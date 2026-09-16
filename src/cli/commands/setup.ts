import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stringify } from 'yaml';
import { createApp, type App } from '../../app.js';
import {
  AGENT_BACKENDS, MachineConfigError, parseMachineConfig, parseMachineConfigAsWritten, type AgentBackend, type MachineConfig,
} from '../../config/machine.js';
import { writeMachineConfig } from '../../config/write.js';
import { dataPaths, defaultDataDir, ensureDataDirs, expandHome, machineConfigPath, type DataPaths } from '../../config/paths.js';
import { parseRepo } from '../../github/source.js';
import { projectStatuses, searchAccounts } from '../../jira/client.js';
import { openDatabase } from '../../store/db.js';
import type { ServiceManager } from '../../service/index.js';
import { buildChecks } from './doctor.js';
import { runChecks, which } from '../checks.js';
import { NONE_SERVICE_HINT, loadServiceTarget, serviceManagerFor, type CreateManager } from './service.js';

/** Réponse affichée par défaut quand ANTHROPIC_API_KEY est déjà dans l'environnement : la clé elle-même n'est jamais affichée à l'écran. */
export const ENV_KEY_PLACEHOLDER = "[valeur de l'environnement]";

/** Le garde-fou de setup n'installe le service que si l'entrée résolue est bien le fichier buildé. */
export function isBuiltEntry(path: string): boolean {
  return path.endsWith('.js');
}

/** Résout argv[1] jusqu'au fichier réel : un lien `npm link` est un symlink vers dist/cli/index.js, pas un `.js` lui-même. */
export function resolveEntryPath(argv1: string): string {
  try {
    return realpathSync(argv1);
  } catch {
    return resolve(argv1);
  }
}

export function validateId(s: string): string | null {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? null : 'Entier strictement positif attendu.';
}

export function parseReposAnswer(s: string): string[] {
  return s
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
}

export function validateRepos(s: string): string | null {
  const repos = parseReposAnswer(s);
  if (repos.length === 0) return 'Au moins un repo requis (owner/repo, séparés par des virgules).';
  for (const r of repos) {
    try {
      parseRepo(r);
    } catch {
      return `Format invalide : ${r} (attendu owner/repo).`;
    }
  }
  return null;
}

export function validateApiKey(s: string): string | null {
  return s.trim() ? null : 'Clé requise.';
}

/** Backends acceptés à la question : les canoniques, plus l'alias historique `cli` (normalisé au parse). */
const ACCEPTED_BACKENDS = new Set<string>([...AGENT_BACKENDS, 'cli']);

export function validateBackend(s: string): string | null {
  return ACCEPTED_BACKENDS.has(s) ? null : `Répondre ${AGENT_BACKENDS.join(', ')} ou cli.`;
}

export async function validatePrivateKeyPath(p: string): Promise<string | null> {
  try {
    await readFile(expandHome(p), 'utf8');
    return null;
  } catch {
    return `Fichier introuvable ou illisible : ${p}`;
  }
}

export interface SetupAnswers {
  appId: number;
  installationId: number;
  privateKeyPath: string;
  repos: string[];
  dataDir: string;
  agentBackend: AgentBackend;
  /** Absent : le suivi reste sur les issues GitHub, et une section `jira` existante est conservée telle quelle. */
  jira?: MachineConfig['jira'];
}

/**
 * Fusionne les réponses de setup avec une config existante : github, repos et agentBackend sont écrasés.
 * dataDir n'est redemandé nulle part ici — un dataDir personnalisé déjà présent dans la config existante
 * est conservé (setup ne doit pas silencieusement ramener les données vers la racine par défaut). Tout le
 * reste (triggerLabel, pollIntervalSeconds, maxConcurrentJobs, dailyBudgetUsd…) est conservé aussi. Seul
 * `sandbox` est forcé à false dès que le backend n'est pas `sdk`, qui est le seul à le supporter : un
 * `sandbox: true` hérité rendrait la config inutilisable (createApp la refuse) sans que setup puisse jamais
 * la réparer. L'alias `cli` (normalisé en `claude-code` au parse) est couvert par ce même test.
 */
export function buildRawConfig(answers: SetupAnswers, existing?: MachineConfig): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    github: { appId: answers.appId, installationId: answers.installationId, privateKeyPath: answers.privateKeyPath },
    repos: answers.repos,
    agentBackend: answers.agentBackend,
    ...(answers.agentBackend !== 'sdk' ? { sandbox: false } : {}),
    // Le `...existing` en tête a déjà reporté une section `jira` en place : on ne l'écrase que si setup
    // vient d'en construire une neuve, jamais pour la supprimer sans qu'on l'ait demandé.
    ...(answers.jira ? { jira: answers.jira } : {}),
    dataDir: existing?.dataDir ?? answers.dataDir,
  };
}


/** Réponse « oui » tolérante : o, oui, y, yes, quelle que soit la casse. */
export function isYes(answer: string): boolean {
  return /^(o|oui|y|yes)$/i.test(answer.trim());
}

interface AskJiraDeps {
  ask: (question: string, def?: string) => Promise<string>;
  askValidated: (question: string, validate: (v: string) => string | null | Promise<string | null>, def?: string) => Promise<string>;
  repos: string[];
  existing?: MachineConfig;
  dataDir: string;
  /** Injectés par les tests : évitent tout appel réseau. */
  lookup?: typeof searchAccounts;
  statuses?: typeof projectStatuses;
}

/**
 * La section `jira`, construite par questions.
 *
 * Deux partis pris. D'abord, on ne demande jamais un `accountId` : personne ne le connaît. On demande une
 * adresse et on la résout, en laissant choisir quand plusieurs comptes répondent — assigner les tickets au
 * mauvais compte ne se verrait qu'à l'usage. Ensuite, un dépôt sans projet Jira reste sur les issues GitHub :
 * la bascule se fait dépôt par dépôt, pas d'un bloc.
 */
export async function askJira(d: AskJiraDeps): Promise<MachineConfig['jira'] | undefined> {
  const already = d.existing?.jira;
  const answer = await d.ask(`Suivi des tickets sur Jira ? (o/N)`, already ? 'o' : 'n');
  if (!isYes(answer)) return undefined;

  const site = await d.askValidated(
    'Site Atlassian (xxx.atlassian.net)',
    (v) => (/^[a-z0-9-]+\.atlassian\.net$/.test(v) ? null : 'Format attendu : xxx.atlassian.net'),
    already?.site,
  );
  const email = await d.askValidated(
    'Adresse du compte porteur du jeton API',
    (v) => (/^[^@\s]+@[^@\s]+$/.test(v) ? null : 'Adresse invalide'),
    already?.email,
  );
  const apiTokenPath = await d.askValidated(
    'Chemin du fichier contenant le jeton API',
    validatePrivateKeyPath,
    already?.apiTokenPath ?? join(d.dataDir, 'jira-token.txt'),
  );
  const apiToken = (await readFile(expandHome(apiTokenPath), 'utf8')).trim();
  const lookup = d.lookup ?? searchAccounts;

  const projects: NonNullable<MachineConfig['jira']>['projects'] = [];
  for (const repo of d.repos) {
    const prev = already?.projects.find((p) => p.repo === repo);
    const key = await d.ask(`Projet Jira pour ${repo} (vide = rester sur les issues GitHub)`, prev?.key);
    if (!key) continue;
    const accountId = await resolveAccount({ site, email, apiToken }, d, repo, prev?.accountId, lookup);
    const workflow = await askWorkflow({ site, email, apiToken }, d, key.toUpperCase(), prev);
    projects.push({ key: key.toUpperCase(), accountId, repo, ...workflow });
  }
  if (projects.length === 0) {
    console.log('Aucun projet Jira renseigné : le suivi reste sur les issues GitHub.');
    return undefined;
  }
  return { site, email, apiTokenPath, projects };
}

/**
 * Le workflow du projet : quels statuts déclenchent, dans quel ordre ils s'enchaînent, et où Sisyphe pose le
 * ticket pendant son travail puis une fois la PR ouverte.
 *
 * Sisyphe n'impose aucun vocabulaire — il n'a donc pas de valeur par défaut à proposer. Il lit ce que le
 * projet déclare et le donne à ranger : l'API rend les statuts sans ordre exploitable, et seul un humain sait
 * lequel précède l'autre.
 */
async function askWorkflow(
  cfg: { site: string; email: string; apiToken: string },
  d: AskJiraDeps,
  key: string,
  prev: NonNullable<MachineConfig['jira']>['projects'][number] | undefined,
): Promise<Pick<NonNullable<MachineConfig['jira']>['projects'][number], 'candidateStatuses' | 'statusesInOrder' | 'inProgressStatus' | 'doneStatus'>> {
  let declared: string[] = [];
  try {
    declared = await (d.statuses ?? projectStatuses)(cfg, key);
  } catch (err) {
    console.log(`Statuts du projet ${key} illisibles (${err instanceof Error ? err.message : String(err)}) : à saisir à la main.`);
  }
  if (declared.length > 0) console.log(`Statuts déclarés par ${key} : ${declared.join(', ')}`);

  const list = (question: string, def?: string) =>
    d.askValidated(question, (v) => (parseList(v).length > 0 ? null : 'Au moins un statut, séparés par des virgules.'), def);

  const order = parseList(await list(`Ordre du workflow de ${key}, du premier au dernier`, prev?.statusesInOrder.join(', ')));
  const inList = (label: string, def: string | undefined) =>
    d.askValidated(label, (v) => (order.some((s) => s.toLowerCase() === v.trim().toLowerCase()) ? null : `Doit figurer dans : ${order.join(', ')}`), def);

  return {
    candidateStatuses: parseList(await list('Statuts sur lesquels un ticket assigné est pris en charge', prev?.candidateStatuses.join(', ') ?? order[0])),
    statusesInOrder: order,
    inProgressStatus: (await inList('Statut pendant le travail', prev?.inProgressStatus)).trim(),
    doneStatus: (await inList('Statut une fois la PR ouverte', prev?.doneStatus)).trim(),
  };
}

const parseList = (v: string): string[] => v.split(',').map((x) => x.trim()).filter(Boolean);

/** Le compte auquel on assignera les tickets de ce dépôt, résolu depuis une adresse ou un nom. */
async function resolveAccount(
  cfg: { site: string; email: string; apiToken: string },
  d: AskJiraDeps,
  repo: string,
  previous: string | undefined,
  lookup: typeof searchAccounts,
): Promise<string> {
  for (;;) {
    const query = await d.ask(`Compte Sisyphe pour ${repo} (adresse ou nom)`, previous);
    if (!query) continue;
    let found: Awaited<ReturnType<typeof searchAccounts>>;
    try {
      found = await lookup(cfg, query);
    } catch (err) {
      // Jira injoignable ou jeton refusé : on ne bloque pas l'installation, on accepte l'identifiant à la main.
      console.log(`Recherche impossible (${err instanceof Error ? err.message : String(err)}).`);
      const manual = await d.ask('accountId Jira (laisser vide pour réessayer la recherche)', previous);
      if (manual) return manual;
      continue;
    }
    if (found.length === 0) {
      console.log(`Aucun compte ne correspond à « ${query} ».`);
      continue;
    }
    if (found.length === 1) {
      console.log(`→ ${found[0].displayName}`);
      return found[0].accountId;
    }
    found.forEach((u: { displayName: string; emailAddress?: string }, i: number) => console.log(`  ${i + 1}. ${u.displayName}${u.emailAddress ? ` <${u.emailAddress}>` : ''}`));
    const pick = await d.askValidated(
      'Lequel',
      (v) => (Number(v) >= 1 && Number(v) <= found.length ? null : `Un nombre entre 1 et ${found.length}`),
      '1',
    );
    return found[Number(pick) - 1].accountId;
  }
}

/** Ce qui reste à faire après setup : le daemon n'est jamais démarré par l'installation. */
const START_HINT = 'Lancer `sisyphe ui` puis Démarrer, ou `sisyphe service start`.';

/** Dossiers de données puis base : l'ouverture en écriture joue les migrations, la fermeture suit aussitôt. */
export async function prepareData(paths: DataPaths): Promise<void> {
  await ensureDataDirs(paths);
  openDatabase(paths.dbPath).close();
}

/** Refuse d'aller plus loin quand la CLI ne tourne pas depuis le build : un service pointant sur un script `tsx` ne démarrerait jamais. */
export function assertBuiltEntry(): void {
  const entry = resolveEntryPath(process.argv[1] ?? '');
  if (!isBuiltEntry(entry)) throw new Error(`Installer le service depuis le build : node dist/cli/index.js setup (entrée = ${entry}).`);
}

/** Binaire de la CLI et libellé d'installation, par backend non-SDK : le daemon doit pouvoir le joindre. */
const BACKEND_BINARY: Record<Exclude<AgentBackend, 'sdk'>, { bin: string; label: string }> = {
  'claude-code': { bin: 'claude', label: 'Claude Code' },
  codex: { bin: 'codex', label: 'Codex CLI' },
  opencode: { bin: 'opencode', label: 'opencode' },
};

/** Seams injectables pour les tests ; en production, `which` exécute le vrai `which` de checks.ts. */
export interface InstallServiceDeps {
  which?: (bin: string) => Promise<string>;
}

/**
 * Installe (ou réinstalle) le service sans rien démarrer, après avoir vérifié que le daemon aura de quoi
 * travailler, et affiche ses avertissements non bloquants (linger systemd…). Renvoie `false` sur une
 * plateforme sans service géré : il n'y a rien à installer, et ce n'est pas une erreur.
 */
export async function installService(
  machine: Pick<MachineConfig, 'agentBackend'>,
  manager: ServiceManager,
  apiKey?: string,
  deps: InstallServiceDeps = {},
): Promise<boolean> {
  // Backend CLI (`claude-code`, `codex`, `opencode`) : sa session remplace la clé API, mais le binaire doit
  // être joignable depuis le PATH que le service transmettra au daemon — sinon chaque job échouerait.
  if (machine.agentBackend !== 'sdk') {
    const { bin, label } = BACKEND_BINARY[machine.agentBackend];
    try {
      await (deps.which ?? which)(bin);
    } catch {
      throw new Error(`${bin} introuvable sur le PATH : installer ${label} puis relancer setup.`);
    }
  }
  // Backend `sdk` : la clé vient de la question de setup ou de l'environnement. Absente — cas de
  // `--reinstall-service` lancé depuis un shell sans clé — le service serait installé muet.
  if (machine.agentBackend === 'sdk' && !(apiKey || process.env.ANTHROPIC_API_KEY)) {
    throw new Error("ANTHROPIC_API_KEY absente de l'environnement : le service serait installé sans clé. La définir puis relancer.");
  }
  if ((await manager.status()).kind === 'none') {
    console.log(NONE_SERVICE_HINT);
    return false;
  }
  const { warnings } = await manager.install();
  for (const w of warnings) console.log(`⚠️ ${w}`);
  return true;
}

export interface SetupOptions {
  /** Ne rejoue pas les questions : recharge la config et réinstalle seulement le service. */
  reinstallService?: boolean;
}

export async function setupCommand(
  opts: SetupOptions = {},
  deps: { createManager?: CreateManager } & InstallServiceDeps = {},
): Promise<void> {
  // En tête des deux branches : échouer en une seconde plutôt qu'après tout l'entretien.
  assertBuiltEntry();

  if (opts.reinstallService) {
    const { machine, paths, manager } = await loadServiceTarget({ createManager: deps.createManager });
    // Les dossiers et la base d'abord : le plist et l'unité référencent `logsDir` et la racine des données,
    // et c'est cette commande que doctor conseille pour réparer une installation.
    await prepareData(paths);
    if (await installService(machine, manager, undefined, deps)) console.log(`Service réinstallé, daemon non démarré.\n${START_HINT}`);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string, def?: string): Promise<string> => {
    const answer = (await rl.question(def ? `${question} [${def}] : ` : `${question} : `)).trim();
    return answer || def || '';
  };
  const askValidated = async (
    question: string,
    validate: (v: string) => string | null | Promise<string | null>,
    def?: string,
  ): Promise<string> => {
    for (;;) {
      const answer = await ask(question, def);
      const err = await validate(answer);
      if (!err) return answer;
      console.log(err);
    }
  };

  try {
    const dataDir = expandHome(defaultDataDir());
    const configPath = machineConfigPath();

    // Config déjà présente (relance de setup) : on en repart pour préserver les champs non redemandés ici.
    // Absente (premier lancement) : on repart silencieusement d'une config neuve. Présente mais invalide :
    // on avertit avant d'écraser, pour ne pas perdre les réglages personnalisés (triggerLabel...) sans le dire.
    let existing: MachineConfig | undefined;
    let text: string | undefined;
    try {
      text = await readFile(configPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (text !== undefined) {
      try {
        // Forme telle qu'écrite : c'est elle qu'on recopie dans le fichier. La forme développée y graverait
        // `/Users/<nom>/.sisyphe` là où l'opérateur avait écrit `~/.sisyphe`.
        existing = parseMachineConfigAsWritten(text);
      } catch (err) {
        const message = err instanceof MachineConfigError ? err.message : err instanceof Error ? err.message : String(err);
        console.log(`Config existante illisible (${message}) : elle sera remplacée par des valeurs par défaut pour les champs non redemandés ici.`);
      }
    }

    const appId = Number(await askValidated('GitHub App ID', validateId));
    const installationId = Number(await askValidated('Installation ID', validateId));
    // Pas d'`expandHome` sur la réponse : un `~/…` saisi doit rester tel quel dans le fichier. `validatePrivateKeyPath`
    // développe de son côté pour vérifier que le fichier existe, et `parseMachineConfig` développera à l'usage.
    const privateKeyPath = await askValidated('Chemin de la clé privée .pem', validatePrivateKeyPath, join(dataDir, 'github-app.pem'));
    const reposAnswer = await askValidated('Repos à surveiller (owner/repo, séparés par des virgules)', validateRepos);
    const repos = parseReposAnswer(reposAnswer);

    // Le backend décide de la suite : la clé API n'existe que pour le SDK ; les CLI s'appuient sur leur
    // session déjà ouverte sur la machine (`claude auth status`, login codex, `opencode auth list`).
    const agentBackend = (await askValidated(
      'Backend agent (claude-code, codex, opencode = CLI locale ; sdk = clé API)',
      validateBackend,
      existing?.agentBackend ?? 'claude-code',
    )) as AgentBackend;

    let apiKey = '';
    if (agentBackend === 'sdk') {
      const envKey = process.env.ANTHROPIC_API_KEY;
      const apiKeyAnswer = await askValidated(
        'ANTHROPIC_API_KEY (transmise au service, jamais écrite dans config.yml)',
        validateApiKey,
        envKey ? ENV_KEY_PLACEHOLDER : undefined,
      );
      apiKey = envKey && apiKeyAnswer === ENV_KEY_PLACEHOLDER ? envKey : apiKeyAnswer;
    }

    const jira = await askJira({ ask, askValidated, repos, existing, dataDir });

    const raw = buildRawConfig({ appId, installationId, privateKeyPath, repos, dataDir, agentBackend, jira }, existing);
    const rawYaml = stringify(raw);
    // Deux formes de la même configuration, validées avant toute écriture : `written` garde les chemins tels
    // que saisis et c'est elle qui part sur le disque ; `machine` les développe, pour tout ce qui s'en sert
    // ici (dossiers, base, service, vérifications).
    const written = parseMachineConfigAsWritten(rawYaml);
    const machine = parseMachineConfig(rawYaml);
    const paths = dataPaths(machine.dataDir);
    await ensureDataDirs(paths);
    // config.yml vit toujours sous la racine par défaut (machineConfigPath()), même quand dataDir — conservé
    // d'une config existante — pointe ailleurs : s'assurer que ce dossier existe aussi avant d'y écrire.
    if (paths.root !== dataDir) {
      await ensureDataDirs(dataPaths(dataDir));
    }
    // Même écrivain que la page de réglages : rename atomique, 0600, et `.bak` de la version précédente —
    // une relance de setup ne peut plus laisser un config.yml à moitié remplacé ni perdre l'ancien.
    await writeMachineConfig(configPath, written);
    console.log(`Config écrite : ${configPath}`);

    // On revérifie tout (accès GitHub App, sisyphe.yml de chaque repo, outils...) avant d'installer
    // quoi que ce soit : mieux vaut refuser d'installer un daemon qui échouera au premier tick.
    console.log('Vérification de la configuration...');
    let app: App | null = null;
    let initError: unknown = null;
    try {
      app = await createApp({ needsAgent: false });
    } catch (err) {
      initError = err;
    }
    // La clé recueillie n'est pas forcément exportée dans cette session : on la donne aux checks sans la
    // poser dans `process.env`, que tout enfant (`which`, `claude --version`…) hériterait.
    const checkEnv = agentBackend === 'sdk' ? { ...process.env, ANTHROPIC_API_KEY: apiKey } : process.env;
    // Le service est forcément absent à ce stade (on ne l'a pas encore installé) : ce check n'a de sens
    // que pour `sisyphe doctor` une fois le daemon en place, pas pour le pré-vol de setup.
    // `machine` (fraîchement parsée) plutôt que seulement `app?.machine` : si createApp a échoué après la
    // config (client GitHub…), le pré-vol doit quand même vérifier le bon backend, pas retomber sur `sdk`.
    const checks = buildChecks({ machine: app?.machine ?? machine, github: app?.github, env: checkEnv, paths: app?.paths });
    if (initError && !(initError instanceof MachineConfigError)) {
      const err = initError;
      checks.push({ name: 'initialisation', run: async () => { throw err; } });
    }
    const { ok, lines } = await runChecks(checks);
    console.log(lines.join('\n'));
    if (!ok) {
      console.log('Corriger les points ci-dessus puis relancer sisyphe setup (le config est conservé).');
      return;
    }

    await prepareData(paths);
    const manager = await serviceManagerFor(paths, machine, { createManager: deps.createManager, apiKey });
    if (await installService(machine, manager, apiKey, deps)) {
      console.log(`Service installé, daemon non démarré. Logs : ${paths.logsDir}`);
      console.log(`${START_HINT} Vérifier l'installation avec \`sisyphe doctor\`.`);
    }
  } finally {
    rl.close();
  }
}
