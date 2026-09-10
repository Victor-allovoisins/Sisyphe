import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readLock } from '../daemon/lock.js';
import { tail } from '../util/text.js';
import type { ServiceContext, ServiceManager, ServiceStatus } from './types.js';

export const NO_SERVICE_MESSAGE = 'aucun service géré sur cette plateforme';

/**
 * Attente maximale de la socket de contrôle après le spawn, et pas entre deux essais. Chaque `isReachable()`
 * peut lui-même durer jusqu'au délai du ping (2 s) : le pire cas réel est donc ≈ 5 s + 2 s.
 */
const START_TIMEOUT_MS = 5_000;
const START_POLL_MS = 250;
/** Lignes du log rapportées quand le daemon ne répond pas à temps. */
const LOG_TAIL_LINES = 20;

/** Sous-ensemble structurel de `child_process.spawn` : un test passe un faux qui n'exécute rien. */
export type Spawn = (
  file: string,
  args: string[],
  options: SpawnOptions,
) => { unref(): void; once(event: 'error', cb: (err: Error) => void): unknown };

export interface NoneServiceManagerOptions {
  spawn?: Spawn;
  sleep?: (ms: number) => Promise<void>;
  /** Horloge en ms, injectable pour borner l'attente sans attendre réellement. */
  now?: () => number;
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
  private readonly now: () => number;

  constructor(
    private readonly ctx: ServiceContext,
    opts: NoneServiceManagerOptions = {},
  ) {
    this.spawn = opts.spawn ?? nodeSpawn;
    this.sleep = opts.sleep ?? ((ms) => delay(ms));
    this.now = opts.now ?? Date.now;
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

  async start(): Promise<void> {
    const { paths, nodePath, scriptPath, env, client } = this.ctx;
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
    const deadline = this.now() + START_TIMEOUT_MS;
    while (true) {
      if (spawnError) throw new Error(`impossible de lancer le daemon : ${spawnError.message}`);
      if (await client.isReachable()) return;
      if (this.now() >= deadline) break;
      await this.sleep(START_POLL_MS);
    }
    const log = await readFile(logPath, 'utf8').catch(() => '');
    throw new Error(`le daemon n'a pas répondu en ${START_TIMEOUT_MS / 1000} s ; dernières lignes de ${logPath} :\n${tail(log.trimEnd(), LOG_TAIL_LINES)}`);
  }

  /** Idempotent : sans daemon vivant derrière le verrou, rien à arrêter — pas d'erreur « injoignable ». */
  async stop(): Promise<void> {
    const lock = await readLock(this.ctx.paths);
    if (!lock?.alive) return;
    await this.ctx.client.send('stop');
  }
}
