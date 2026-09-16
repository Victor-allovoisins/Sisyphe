import { createAgentRunner } from './agent/index.js';
import { SANDBOX_BACKEND_ERROR, loadMachineConfig, type MachineConfig } from './config/machine.js';
import { dataPaths, ensureDataDirs, machineConfigPath, type DataPaths } from './config/paths.js';
import { Git } from './git/git.js';
import { GitHubIssueSource } from './github/client.js';
import { JiraIssueTracker } from './jira/client.js';
import type { PipelineDeps } from './jobs/pipeline.js';
import { createLogger } from './log/logger.js';
import { ActionStore } from './store/actions.js';
import { openDatabase } from './store/db.js';
import { JobStore } from './store/jobs.js';
import { PhaseStore } from './store/phases.js';

export interface App {
  machine: MachineConfig;
  paths: DataPaths;
  deps: PipelineDeps;
  /** Toujours présent : c'est la forge, et elle reste GitHub même quand le suivi est sur Jira. */
  github: GitHubIssueSource;
  /** Présent seulement quand la section `jira` est configurée. `doctor` s'en sert. */
  jira?: JiraIssueTracker;
}

export { machineConfigPath };

/** Câble les implémentations réelles. `needsAgent: false` n'exige pas la clé API (status, report, cancel, doctor). */
export async function createApp(opts: { logToFile?: boolean; needsAgent?: boolean } = {}): Promise<App> {
  const configPath = machineConfigPath();
  // La config décide du backend agent, donc de ce qu'il faut exiger : elle est lue en premier, mais
  // les vérifications restent avant tout effet de bord (ensureDataDirs, openDatabase), pour qu'un
  // premier lancement mal configuré échoue vite et sans laisser de répertoires créés pour rien.
  const machine = await loadMachineConfig(configPath);
  if (opts.needsAgent !== false && machine.agentBackend === 'sdk' && !process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY absente de l'environnement. Le Agent SDK exige une clé API ; pour utiliser l'abonnement Claude Code, mettre `agentBackend: claude-code` dans la config machine.",
    );
  }
  if (machine.sandbox && machine.agentBackend !== 'sdk') {
    throw new Error(SANDBOX_BACKEND_ERROR);
  }
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
  // Le suivi des tickets bascule sur Jira dès que la section est configurée ; la forge reste GitHub
  // dans tous les cas — aucun traqueur n'héberge une branche.
  let jira: JiraIssueTracker | undefined;
  if (machine.jira) {
    try {
      jira = await JiraIssueTracker.fromFiles({ ...machine.jira, log: log.child({ component: 'jira' }) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Impossible d'initialiser le client Jira : ${message}. Vérifier jira.apiTokenPath dans ${configPath}.`);
    }
  }
  const agent = createAgentRunner(machine.agentBackend, { sandbox: machine.sandbox });
  const deps: PipelineDeps = {
    store: new JobStore(db), phases: new PhaseStore(db), actions: new ActionStore(db), source: jira ?? github, forge: github, agent, git: new Git(paths), paths, machine, log, env: process.env,
  };
  return { machine, paths, deps, github, jira };
}
