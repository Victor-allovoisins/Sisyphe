import { realpathSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stringify } from 'yaml';
import { createApp, type App } from '../../app.js';
import { MachineConfigError, parseMachineConfig, type AgentBackend, type MachineConfig } from '../../config/machine.js';
import { dataPaths, defaultDataDir, ensureDataDirs, expandHome, machineConfigPath, type DataPaths } from '../../config/paths.js';
import { parseRepo } from '../../github/source.js';
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

export function validateBackend(s: string): string | null {
  return s === 'cli' || s === 'sdk' ? null : 'Répondre cli ou sdk.';
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
}

/**
 * Fusionne les réponses de setup avec une config existante : github, repos et agentBackend sont écrasés.
 * dataDir n'est redemandé nulle part ici — un dataDir personnalisé déjà présent dans la config existante
 * est conservé (setup ne doit pas silencieusement ramener les données vers la racine par défaut). Tout le
 * reste (triggerLabel, pollIntervalSeconds, maxConcurrentJobs, dailyBudgetUsd…) est conservé aussi. Seul
 * `sandbox` est forcé à false pour le backend `cli`, qui ne le supporte pas : un `sandbox: true` hérité
 * rendrait la config inutilisable (createApp la refuse) sans que setup puisse jamais la réparer.
 */
export function buildRawConfig(answers: SetupAnswers, existing?: MachineConfig): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    github: { appId: answers.appId, installationId: answers.installationId, privateKeyPath: answers.privateKeyPath },
    repos: answers.repos,
    agentBackend: answers.agentBackend,
    ...(answers.agentBackend === 'cli' ? { sandbox: false } : {}),
    dataDir: existing?.dataDir ?? answers.dataDir,
  };
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

/**
 * Installe (ou réinstalle) le service sans rien démarrer, après avoir vérifié que le daemon aura de quoi
 * travailler, et affiche ses avertissements non bloquants (linger systemd…). Renvoie `false` sur une
 * plateforme sans service géré : il n'y a rien à installer, et ce n'est pas une erreur.
 */
export async function installService(
  machine: Pick<MachineConfig, 'agentBackend'>,
  manager: ServiceManager,
  apiKey?: string,
): Promise<boolean> {
  // Backend `cli` : la session claude.ai remplace la clé API, mais `claude` doit être joignable depuis le
  // PATH que le service transmettra au daemon — sinon chaque job échouerait.
  if (machine.agentBackend === 'cli') {
    try {
      await which('claude');
    } catch {
      throw new Error('claude introuvable sur le PATH : installer Claude Code puis relancer setup.');
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

export async function setupCommand(opts: SetupOptions = {}, deps: { createManager?: CreateManager } = {}): Promise<void> {
  // En tête des deux branches : échouer en une seconde plutôt qu'après tout l'entretien.
  assertBuiltEntry();

  if (opts.reinstallService) {
    const { machine, paths, manager } = await loadServiceTarget({ createManager: deps.createManager });
    // Les dossiers et la base d'abord : le plist et l'unité référencent `logsDir` et la racine des données,
    // et c'est cette commande que doctor conseille pour réparer une installation.
    await prepareData(paths);
    if (await installService(machine, manager)) console.log(`Service réinstallé, daemon non démarré.\n${START_HINT}`);
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
        existing = parseMachineConfig(text);
      } catch (err) {
        const message = err instanceof MachineConfigError ? err.message : err instanceof Error ? err.message : String(err);
        console.log(`Config existante illisible (${message}) : elle sera remplacée par des valeurs par défaut pour les champs non redemandés ici.`);
      }
    }

    const appId = Number(await askValidated('GitHub App ID', validateId));
    const installationId = Number(await askValidated('Installation ID', validateId));
    const privateKeyPath = expandHome(
      await askValidated('Chemin de la clé privée .pem', validatePrivateKeyPath, join(dataDir, 'github-app.pem')),
    );
    const reposAnswer = await askValidated('Repos à surveiller (owner/repo, séparés par des virgules)', validateRepos);
    const repos = parseReposAnswer(reposAnswer);

    // Le backend décide de la suite : la clé API n'existe que pour le SDK, la CLI utilise la session
    // claude.ai déjà ouverte sur la machine (`claude auth status`).
    const agentBackend = (await askValidated(
      'Backend agent (cli = abonnement Claude Code, sdk = clé API)',
      validateBackend,
      existing?.agentBackend ?? 'cli',
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

    const raw = buildRawConfig({ appId, installationId, privateKeyPath, repos, dataDir, agentBackend }, existing);
    const machine = parseMachineConfig(stringify(raw)); // valide avant d'écrire
    const paths = dataPaths(machine.dataDir);
    await ensureDataDirs(paths);
    // config.yml vit toujours sous la racine par défaut (machineConfigPath()), même quand dataDir — conservé
    // d'une config existante — pointe ailleurs : s'assurer que ce dossier existe aussi avant d'y écrire.
    if (paths.root !== dataDir) {
      await ensureDataDirs(dataPaths(dataDir));
    }
    await writeFile(configPath, stringify(raw), { mode: 0o600 });
    await chmod(configPath, 0o600); // le mode de writeFile n'est appliqué qu'à la création
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
    if (await installService(machine, manager, apiKey)) {
      console.log(`Service installé, daemon non démarré. Logs : ${paths.logsDir}`);
      console.log(`${START_HINT} Vérifier l'installation avec \`sisyphe doctor\`.`);
    }
  } finally {
    rl.close();
  }
}
