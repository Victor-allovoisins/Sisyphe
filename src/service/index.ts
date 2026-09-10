import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { MachineConfig } from '../config/machine.js';
import type { DataPaths } from '../config/paths.js';
import { realExec } from './exec.js';
import { LaunchdServiceManager } from './launchd.js';
import { NoneServiceManager } from './none.js';
import { SystemdServiceManager } from './systemd.js';
import type { ServiceClient, ServiceContext, ServiceManager } from './types.js';

export type { ServiceClient, ServiceContext, ServiceKind, ServiceManager, ServiceStatus } from './types.js';
export { realExec } from './exec.js';
export { LaunchdServiceManager } from './launchd.js';
export { NoneServiceManager } from './none.js';
export { SystemdServiceManager } from './systemd.js';

/**
 * Choisit le gestionnaire de la plateforme : launchd sur macOS, systemd sur Linux quand `systemctl --user`
 * répond (sinon aucun gestionnaire : daemon détaché), rien ailleurs.
 */
export async function createServiceManager(ctx: ServiceContext, platform: NodeJS.Platform = process.platform): Promise<ServiceManager> {
  if (platform === 'darwin') return new LaunchdServiceManager(ctx);
  if (platform === 'linux') {
    const r = await ctx.exec('systemctl', ['--user', '--version']);
    if (r.exitCode === 0) return new SystemdServiceManager(ctx);
  }
  return new NoneServiceManager(ctx);
}

export interface DefaultServiceContextInput {
  paths: DataPaths;
  client: ServiceClient;
  /** Le backend décide si la clé API voyage jusqu'au daemon. */
  machine: Pick<MachineConfig, 'agentBackend'>;
}

/**
 * `dist/cli/index.js` résolu depuis ce module, jusqu'au fichier réel (un lien `npm link` est un symlink).
 * Depuis `src/` (tests), le `.js` n'existe pas : on garde le chemin non résolu, la forme suffit.
 */
function cliScriptPath(): string {
  const p = fileURLToPath(new URL('../cli/index.js', import.meta.url));
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Contexte de production : l'environnement transmis au daemon est réduit à PATH, HOME, `SISYPHE_HOME` si le
 * process l'a, et la clé API seulement pour le backend sdk — le même quel que soit le gestionnaire.
 */
export function defaultServiceContext({ paths, client, machine }: DefaultServiceContextInput): ServiceContext {
  const home = homedir();
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home };
  if (process.env.SISYPHE_HOME) env.SISYPHE_HOME = process.env.SISYPHE_HOME;
  if (machine.agentBackend === 'sdk' && process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  return {
    paths, nodePath: process.execPath, scriptPath: cliScriptPath(), env, client, exec: realExec, homeDir: home, uid: process.getuid?.() ?? 501,
  };
}
