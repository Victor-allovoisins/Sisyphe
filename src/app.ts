import { SdkAgentRunner } from './agent/sdk-runner.js';
import { loadMachineConfig, type MachineConfig } from './config/machine.js';
import { dataPaths, ensureDataDirs, machineConfigPath, type DataPaths } from './config/paths.js';
import { Git } from './git/git.js';
import { GitHubIssueSource } from './github/client.js';
import type { PipelineDeps } from './jobs/pipeline.js';
import { createLogger } from './log/logger.js';
import { openDatabase } from './store/db.js';
import { JobStore } from './store/jobs.js';
import { PhaseStore } from './store/phases.js';

export interface App {
  machine: MachineConfig;
  paths: DataPaths;
  deps: PipelineDeps;
  github: GitHubIssueSource;
}

export { machineConfigPath };

/** Câble les implémentations réelles. `needsAgent: false` n'exige pas la clé API (status, report, cancel, doctor). */
export async function createApp(opts: { logToFile?: boolean; needsAgent?: boolean } = {}): Promise<App> {
  // Vérifié en tête, avant tout accès disque (ensureDataDirs) ou base (openDatabase) : un premier
  // lancement mal configuré doit échouer vite et sans effet de bord (répertoires créés pour rien).
  if (opts.needsAgent !== false && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY absente de l'environnement. Le Agent SDK exige une clé API, l'abonnement claude.ai n'est pas accepté.");
  }
  const configPath = machineConfigPath();
  const machine = await loadMachineConfig(configPath);
  const paths = dataPaths(machine.dataDir);
  await ensureDataDirs(paths);
  const log = createLogger({ logsDir: opts.logToFile ? paths.logsDir : undefined });
  const db = openDatabase(paths.dbPath);
  let github: GitHubIssueSource;
  try {
    github = await GitHubIssueSource.fromFiles({ ...machine.github, triggerLabel: machine.triggerLabel, log: log.child({ component: 'github' }) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Impossible d'initialiser le client GitHub : ${message}. Vérifier github.privateKeyPath dans ${configPath}.`);
  }
  const agent = new SdkAgentRunner({ sandbox: machine.sandbox });
  const deps: PipelineDeps = {
    store: new JobStore(db), phases: new PhaseStore(db), source: github, agent, git: new Git(paths), paths, machine, log, env: process.env,
  };
  return { machine, paths, deps, github };
}
