import { mkdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { EXIT_NOT_FOUND, realExec, type Exec } from './exec.js';
import { write0600 } from './files.js';
import type { ServiceContext, ServiceManager, ServiceStatus } from './types.js';

export const LAUNCHD_LABEL = 'com.sisyphe.daemon';

/** Délai entre les deux essais de `bootstrap` : launchd met parfois un instant à oublier l'agent qu'on vient de décharger. */
const BOOTSTRAP_RETRY_MS = 500;

export interface PlistInput {
  label: string;
  nodePath: string;
  scriptPath: string;
  dataDir: string;
  logsDir: string;
  env: Record<string, string>;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Fichier témoin `<dataDir>/enabled` : présent, launchd garde le daemon en vie ; absent, il ne le relance pas. */
export function enabledPath(dataDir: string): string {
  return join(dataDir, 'enabled');
}

export function renderPlist(i: PlistInput): string {
  // `env` est rendu tel quel : c'est `defaultServiceContext` qui compose l'environnement du daemon (dont le
  // PATH préfixé par le répertoire du node), identique pour le plist, l'unité systemd et le spawn détaché.
  const envXml = Object.entries(i.env)
    .map(([k, v]) => `      <key>${esc(k)}</key>\n      <string>${esc(v)}</string>`)
    .join('\n');
  // RunAtLoad false + KeepAlive/PathState : charger l'agent n'exécute rien ; c'est le fichier `enabled`
  // (créé par start(), supprimé par stop()) qui décide si launchd démarre et relance le daemon.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(i.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(i.nodePath)}</string>
    <string>${esc(i.scriptPath)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>WorkingDirectory</key><string>${esc(i.dataDir)}</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${esc(i.logsDir)}/launchd.err.log</string>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key>
  <dict>
    <key>PathState</key>
    <dict>
      <key>${esc(enabledPath(i.dataDir))}</key><true/>
    </dict>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
</dict>
</plist>
`;
}

export interface LaunchdStatus {
  /** null : plateforme sans launchd (l'agent n'existe que sur macOS). */
  loaded: boolean | null;
  /** null : jamais lancé depuis le chargement — ne pas inventer un 0, ce serait un faux succès. */
  lastExitCode: number | null;
  detail: string;
}

export interface LaunchctlPrint {
  state: string;
  lastExitCode: number | null;
  /** Ligne `pid = N`, présente seulement quand le job tourne. */
  pid: number | null;
}

/** Extrait `state`, `last exit code` et `pid` de la sortie de `launchctl print` (fonction pure, testable). */
export function parseLaunchctlPrint(stdout: string): LaunchctlPrint {
  const state = /^\s*state = (.+?)\s*$/m.exec(stdout)?.[1] ?? '?';
  const raw = /last exit code = (-?\d+)/.exec(stdout)?.[1];
  const pid = /^\s*pid = (\d+)/m.exec(stdout)?.[1];
  return { state, lastExitCode: raw === undefined ? null : Number(raw), pid: pid === undefined ? null : Number(pid) };
}

function describePrint({ state, lastExitCode }: LaunchctlPrint): string {
  return lastExitCode === null ? `state = ${state}` : `state = ${state}, last exit code = ${lastExitCode}`;
}

const NOT_LOADED = 'agent launchd non chargé';

/** uid de l'utilisateur courant, 501 (premier compte macOS) là où `getuid` n'existe pas. */
export function defaultUid(): number {
  return process.getuid?.() ?? 501;
}

/** État de l'agent launchd de l'utilisateur courant. Ne lève jamais : l'UI affiche un avertissement, pas une erreur. */
export async function probeLaunchd(): Promise<LaunchdStatus> {
  if (process.platform !== 'darwin') return { loaded: null, lastExitCode: null, detail: 'launchd : macOS uniquement' };
  const r = await realExec('launchctl', ['print', `gui/${defaultUid()}/${LAUNCHD_LABEL}`]);
  if (r.exitCode !== 0) return { loaded: false, lastExitCode: null, detail: NOT_LOADED };
  const parsed = parseLaunchctlPrint(r.stdout);
  return { loaded: true, lastExitCode: parsed.lastExitCode, detail: describePrint(parsed) };
}

export function plistPath(homeDir: string = homedir()): string {
  return join(homeDir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

interface LoadInput {
  exec: Exec;
  homeDir: string;
  uid: number;
  sleep: (ms: number) => Promise<void>;
}

/** Écrit le plist (0600) puis `bootout` et `bootstrap` dans le domaine gui de l'utilisateur ; deux essais de bootstrap. */
async function loadLaunchAgent(plist: string, { exec, homeDir, uid, sleep }: LoadInput): Promise<void> {
  const p = plistPath(homeDir);
  await mkdir(dirname(p), { recursive: true });
  await write0600(p, plist);
  const domain = `gui/${uid}`;
  await exec('launchctl', ['bootout', domain, p]);
  let result = await exec('launchctl', ['bootstrap', domain, p]);
  if (result.exitCode !== 0) {
    await sleep(BOOTSTRAP_RETRY_MS);
    result = await exec('launchctl', ['bootstrap', domain, p]);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr || `code ${result.exitCode}`;
    throw new Error(
      `Impossible de charger l'agent launchd : ${detail}. Essayer « launchctl bootout gui/$UID/${LAUNCHD_LABEL} » puis relancer sisyphe setup.`,
    );
  }
}

/** Écrit le plist et (re)charge l'agent dans le domaine de l'utilisateur courant. */
export async function installLaunchAgent(plist: string): Promise<void> {
  await loadLaunchAgent(plist, { exec: realExec, homeDir: homedir(), uid: defaultUid(), sleep: (ms) => delay(ms) });
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export interface LaunchdServiceManagerOptions {
  /** Injectable pour que les tests n'attendent pas les 500 ms entre les deux `bootstrap`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Agent launchd de l'utilisateur (macOS) : le plist est chargé une fois, le fichier `enabled` pilote le daemon. */
export class LaunchdServiceManager implements ServiceManager {
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly ctx: ServiceContext,
    opts: LaunchdServiceManagerOptions = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => delay(ms));
  }

  private get target(): string {
    return `gui/${this.ctx.uid}/${LAUNCHD_LABEL}`;
  }

  private get enabled(): string {
    return enabledPath(this.ctx.paths.root);
  }

  async status(): Promise<ServiceStatus> {
    const r = await this.ctx.exec('launchctl', ['print', this.target]);
    const enabledAtBoot = await exists(this.enabled);
    if (r.exitCode !== 0) {
      const detail = r.exitCode === EXIT_NOT_FOUND ? 'launchctl introuvable' : NOT_LOADED;
      return { kind: 'launchd', installed: false, running: false, pid: null, enabledAtBoot, detail };
    }
    const parsed = parseLaunchctlPrint(r.stdout);
    return { kind: 'launchd', installed: true, running: parsed.state === 'running', pid: parsed.pid, enabledAtBoot, detail: describePrint(parsed) };
  }

  async install(): Promise<{ warnings: string[] }> {
    const { paths, nodePath, scriptPath, env, exec, homeDir, uid } = this.ctx;
    const plist = renderPlist({ label: LAUNCHD_LABEL, nodePath, scriptPath, dataDir: paths.root, logsDir: paths.logsDir, env });
    await loadLaunchAgent(plist, { exec, homeDir, uid, sleep: this.sleep });
    return { warnings: [] };
  }

  async start(): Promise<void> {
    await write0600(this.enabled, '');
    const r = await this.ctx.exec('launchctl', ['kickstart', this.target]);
    if (r.exitCode !== 0) {
      // Sans ce retrait, un install() ultérieur démarrerait le daemon via PathState : install() ne démarre pas.
      await rm(this.enabled, { force: true });
      throw new Error(`Impossible de démarrer l'agent launchd : ${r.stderr || `code ${r.exitCode}`}. L'agent est-il installé (sisyphe setup) ?`);
    }
  }

  /**
   * `enabled` d'abord : sans lui, launchd ne relance pas le daemon qu'on arrête. Socket injoignable
   * (daemon planté ou déjà arrêté) ou `stop` rejeté (daemon qui répond au ping mais reste coincé derrière
   * sa porte) : SIGTERM via launchd, sans se soucier du code de retour — un job qui ne tourne plus n'a
   * rien à recevoir.
   */
  async stop(): Promise<void> {
    await rm(this.enabled, { force: true });
    if (await this.ctx.client.isReachable()) {
      try {
        await this.ctx.client.send('stop');
        return;
      } catch {
        // SIGTERM ci-dessous.
      }
    }
    await this.ctx.exec('launchctl', ['kill', 'SIGTERM', this.target]);
  }

  /** `bootout` par cible de service : fonctionne même si le plist a déjà disparu ; agent non chargé → rien à faire. */
  async uninstall(): Promise<void> {
    await this.ctx.exec('launchctl', ['bootout', this.target]);
    await rm(plistPath(this.ctx.homeDir), { force: true });
    await rm(this.enabled, { force: true });
  }
}
