import { chmod, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stringify } from 'yaml';
import { createApp, type App } from '../../app.js';
import { MachineConfigError, parseMachineConfig, type MachineConfig } from '../../config/machine.js';
import { dataPaths, defaultDataDir, ensureDataDirs, expandHome, machineConfigPath } from '../../config/paths.js';
import { parseRepo } from '../../github/source.js';
import { buildChecks } from './doctor.js';
import { runChecks } from '../checks.js';
import { LAUNCHD_LABEL, installLaunchAgent, plistPath, renderPlist } from '../launchd.js';

/** Réponse affichée par défaut quand ANTHROPIC_API_KEY est déjà dans l'environnement : la clé elle-même n'est jamais affichée à l'écran. */
export const ENV_KEY_PLACEHOLDER = "[valeur de l'environnement]";

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
}

/**
 * Fusionne les réponses de setup avec une config existante : github et repos sont écrasés. dataDir n'est
 * redemandé nulle part ici — un dataDir personnalisé déjà présent dans la config existante est conservé
 * (setup ne doit pas silencieusement ramener les données vers la racine par défaut). Tout le reste
 * (triggerLabel, pollIntervalSeconds, maxConcurrentJobs, dailyBudgetUsd, sandbox…) est conservé aussi.
 */
export function buildRawConfig(answers: SetupAnswers, existing?: MachineConfig): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    github: { appId: answers.appId, installationId: answers.installationId, privateKeyPath: answers.privateKeyPath },
    repos: answers.repos,
    dataDir: existing?.dataDir ?? answers.dataDir,
  };
}

export async function setupCommand(): Promise<void> {
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

    const envKey = process.env.ANTHROPIC_API_KEY;
    const apiKeyAnswer = await askValidated(
      'ANTHROPIC_API_KEY (stockée uniquement dans le plist launchd)',
      validateApiKey,
      envKey ? ENV_KEY_PLACEHOLDER : undefined,
    );
    const apiKey = envKey && apiKeyAnswer === ENV_KEY_PLACEHOLDER ? envKey : apiKeyAnswer;

    const raw = buildRawConfig({ appId, installationId, privateKeyPath, repos, dataDir }, existing);
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
    // La clé n'est pas forcément exportée dans l'environnement de cette session (c'est justement ce que
    // setup vient de recueillir) : on l'injecte pour que le check et la sonde API portent sur la bonne valeur.
    const checkEnv = { ...process.env, ANTHROPIC_API_KEY: apiKey };
    // « agent launchd » est forcément non chargé à ce stade (on ne l'a pas encore installé) : ce check
    // n'a de sens que pour `sisyphe doctor` une fois le daemon en place, pas pour le pré-vol de setup.
    const checks = buildChecks({ machine: app?.machine, github: app?.github, env: checkEnv, paths: app?.paths }).filter(
      (c) => c.name !== 'agent launchd',
    );
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

    if (process.platform === 'darwin') {
      const argv1 = resolve(process.argv[1]);
      if (!argv1.endsWith('.js')) {
        console.log(`Lancer setup depuis le build : node dist/cli/index.js setup (argv[1] = ${argv1})`);
        return;
      }
      const plist = renderPlist({
        label: LAUNCHD_LABEL,
        nodePath: process.execPath,
        scriptPath: argv1,
        dataDir: paths.root,
        logsDir: paths.logsDir,
        env: { ANTHROPIC_API_KEY: apiKey, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', HOME: homedir(), SISYPHE_HOME: paths.root },
      });
      await installLaunchAgent(plist);
      console.log(`Daemon installé et démarré : ${plistPath()}\nLogs : ${paths.logsDir}`);
    } else {
      console.log("Pas macOS : lancez `sisyphe start` sous le superviseur de votre choix, avec ANTHROPIC_API_KEY dans l'environnement.");
    }
    console.log('Vérifiez maintenant avec `sisyphe doctor`.');
  } finally {
    rl.close();
  }
}
