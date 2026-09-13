import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readLock } from '../daemon/lock.js';
import type { ActionSource } from '../store/actions.js';
import type { ServiceContext, ServiceManager, ServiceStatus } from './types.js';

export const NO_SERVICE_MESSAGE = 'aucun service géré sur cette plateforme';

/**
 * Temps laissé à Node pour signaler un spawn impossible (exécutable introuvable ou non exécutable), qu'il
 * ne rapporte que par un événement. Au-delà, le daemon est lancé : c'est à l'appelant d'attendre la socket,
 * lui seul connaît son budget — deux attentes en série dépassaient l'abandon de la page (45 s).
 */
const SPAWN_ERROR_GRACE_MS = 250;

/** Sous-ensemble structurel de `child_process.spawn` : un test passe un faux qui n'exécute rien. */
export type Spawn = (
  file: string,
  args: string[],
  options: SpawnOptions,
) => { unref(): void; once(event: 'error', cb: (err: Error) => void): unknown };

export interface NoneServiceManagerOptions {
  spawn?: Spawn;
  sleep?: (ms: number) => Promise<void>;
}

/** Fichier où le daemon détaché écrit stdout/stderr ; distinct du log pino (`logsDir/daemon.log`) écrit par le daemon lui-même. */
export function detachedLogPath(logsDir: string): string {
  return join(logsDir, 'daemon-stdout.log');
}

/**
 * Plateforme sans gestionnaire de services (Linux sans systemd utilisateur, autre) : `start()` lance
 * `sisyphe start` en process détaché, `stop()` passe par la socket ; rien ne survit à un reboot.
 */
export class NoneServiceManager implements ServiceManager {
  private readonly spawn: Spawn;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly ctx: ServiceContext,
    opts: NoneServiceManagerOptions = {},
  ) {
    this.spawn = opts.spawn ?? nodeSpawn;
    this.sleep = opts.sleep ?? ((ms) => delay(ms));
  }

  async status(): Promise<ServiceStatus> {
    const lock = await readLock(this.ctx.paths);
    const running = lock?.alive ?? false;
    return {
      kind: 'none', installed: false, running, pid: running && lock ? lock.pid : null, enabledAtBoot: false,
      detail: running && lock ? `daemon détaché (pid ${lock.pid})` : 'daemon arrêté',
    };
  }

  async install(): Promise<{ warnings: string[] }> {
    throw new Error(NO_SERVICE_MESSAGE);
  }

  async uninstall(): Promise<void> {
    throw new Error(NO_SERVICE_MESSAGE);
  }

  /**
   * Lance le daemon détaché puis rend la main : vérifier qu'il répond appartient à l'appelant, qui seul
   * sait combien de temps il peut attendre (l'interface a son propre budget, et le log du daemon détaché
   * lui reste accessible pour dire pourquoi un démarrage n'a pas abouti).
   */
  async start(): Promise<void> {
    const { paths, nodePath, scriptPath, env } = this.ctx;
    const lock = await readLock(paths);
    if (lock?.alive) throw new Error(`daemon déjà démarré (pid ${lock.pid})`);
    await mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
    const logPath = detachedLogPath(paths.logsDir);
    // Le descripteur est hérité par l'enfant au spawn : le parent peut le fermer aussitôt.
    const fd = openSync(logPath, 'a', 0o600);
    let spawnError: Error | undefined;
    try {
      // `env` seul, comme le plist launchd ou l'unité systemd : le daemon voit le même environnement quelle
      // que soit la plateforme, pas celui du shell qui héberge l'UI.
      const child = this.spawn(nodePath, [scriptPath, 'start'], { detached: true, stdio: ['ignore', fd, fd], env });
      // Exécutable introuvable ou non exécutable : Node le signale par un événement, jamais par une exception
      // au spawn ; sans écouteur, l'erreur ferait tomber le parent.
      child.once('error', (err) => {
        spawnError = err;
      });
      child.unref();
    } finally {
      closeSync(fd);
    }
    await this.sleep(SPAWN_ERROR_GRACE_MS);
    if (spawnError) throw new Error(`impossible de lancer le daemon : ${spawnError.message}`);
  }

  /** Idempotent : sans daemon vivant derrière le verrou, rien à arrêter — pas d'erreur « injoignable ». */
  async stop(source: ActionSource = 'cli'): Promise<void> {
    const lock = await readLock(this.ctx.paths);
    if (!lock?.alive) return;
    await this.ctx.client.send('stop', {}, source);
  }
}
