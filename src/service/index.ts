import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MachineConfig } from '../config/machine.js';
import type { DataPaths } from '../config/paths.js';
import { realExec } from './exec.js';
import { LaunchdServiceManager, defaultUid } from './launchd.js';
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
    // `show -p Version` interroge le gestionnaire utilisateur : contrairement à `--version`, qui répond sans
    // se connecter, il échoue là où il n'y a pas de bus (conteneur, session sans XDG_RUNTIME_DIR) — le cas
    // exact où toutes les opérations systemd échoueraient ensuite.
    const r = await ctx.exec('systemctl', ['--user', 'show', '-p', 'Version']);
    if (r.exitCode === 0) return new SystemdServiceManager(ctx);
  }
  return new NoneServiceManager(ctx);
}

export interface DefaultServiceContextInput {
  paths: DataPaths;
  client: ServiceClient;
  /** Le backend décide si la clé API voyage jusqu'au daemon. */
  machine: Pick<MachineConfig, 'agentBackend'>;
  /** Clé transmise explicitement (setup vient de la recueillir) ; sinon celle de l'environnement. */
  apiKey?: string;
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
 * PATH du daemon : aucun des trois lanceurs (plist, unité, spawn détaché) n'hérite d'un shell, donc le
 * répertoire du node courant passe en tête — un node de nvm/mise ou de homebrew serait sinon introuvable —
 * puis le PATH du process, puis le socle : `<home>/.local/bin` (où install.sh pose gitleaks sur Ubuntu) et
 * les répertoires système, pour que `claude`, `git`, `gitleaks` et les outils des repos restent joignables
 * même lancé depuis un environnement dépouillé. Dédoublonné pour rester lisible.
 */
function daemonPath(home: string): string {
  const current = process.env.PATH?.split(':') ?? [];
  const dirs = [dirname(process.execPath), ...current, join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return [...new Set(dirs)].filter(Boolean).join(':');
}

/**
 * Contexte de production : l'environnement transmis au daemon est réduit à PATH, HOME, `SISYPHE_HOME` si le
 * process l'a, et la clé API seulement pour le backend sdk — le même quel que soit le gestionnaire.
 */
export function defaultServiceContext({ paths, client, machine, apiKey }: DefaultServiceContextInput): ServiceContext {
  const home = homedir();
  const env: Record<string, string> = { PATH: daemonPath(home), HOME: home };
  if (process.env.SISYPHE_HOME) env.SISYPHE_HOME = process.env.SISYPHE_HOME;
  // La clé fournie l'emporte : elle n'a pas à transiter par `process.env`, que tout enfant hériterait.
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (machine.agentBackend === 'sdk' && key) env.ANTHROPIC_API_KEY = key;
  return {
    paths, nodePath: process.execPath, scriptPath: cliScriptPath(), env, client, exec: realExec, homeDir: home, uid: defaultUid(),
  };
}
