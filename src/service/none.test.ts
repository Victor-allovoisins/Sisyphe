import type { SpawnOptions } from 'node:child_process';
import { writeSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataPaths, ensureDataDirs, type DataPaths } from '../config/paths.js';
import { NO_SERVICE_MESSAGE, NoneServiceManager, detachedLogPath } from './none.js';
import type { ServiceContext } from './types.js';

describe('NoneServiceManager', () => {
  let root: string;
  let paths: DataPaths;
  let spawned: { file: string; args: string[]; options: SpawnOptions; unrefs: number }[];
  let pings: number;
  /** Réponses successives d'`isReachable()` ; épuisées → la dernière est répétée. */
  let reachable: boolean[];
  let sent: string[];
  let slept: number[];
  /** Ce que le faux daemon écrit sur le descripteur reçu : prouve qu'il pointe bien sur le log. */
  let childOutput: string;
  /** Erreur que le faux enfant émet sur `'error'` (exécutable introuvable…), null pour un spawn réussi. */
  let spawnError: Error | null;

  function manager(): NoneServiceManager {
    const ctx: ServiceContext = {
      paths, nodePath: '/usr/bin/node', scriptPath: '/x/dist/cli/index.js', env: { SISYPHE_HOME: root, PATH: '/usr/bin' },
      client: {
        send: async (cmd) => { sent.push(cmd); return { ok: true, result: null }; },
        isReachable: async () => { pings += 1; return reachable[Math.min(pings - 1, reachable.length - 1)] ?? false; },
      },
      exec: async () => { throw new Error('exec inattendu'); },
      homeDir: root, uid: 501,
    };
    return new NoneServiceManager(ctx, {
      spawn: (file, args, options) => {
        const entry = { file, args, options, unrefs: 0 };
        spawned.push(entry);
        if (childOutput) writeSync(options.stdio![1] as number, childOutput);
        return {
          unref: () => { entry.unrefs += 1; },
          once: (_event, cb) => { if (spawnError) cb(spawnError); },
        };
      },
      sleep: async (ms) => { slept.push(ms); },
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sisyphe-none-'));
    paths = dataPaths(root);
    await ensureDataDirs(paths);
    spawned = [];
    pings = 0;
    reachable = [true];
    sent = [];
    slept = [];
    childOutput = '';
    spawnError = null;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('install et uninstall refusent : aucun service géré', async () => {
    await expect(manager().install()).rejects.toThrow(NO_SERVICE_MESSAGE);
    await expect(manager().uninstall()).rejects.toThrow(NO_SERVICE_MESSAGE);
  });

  it('start refuse quand un verrou vivant existe, sans rien lancer', async () => {
    await writeFile(join(root, 'daemon.lock'), String(process.pid));
    await expect(manager().start()).rejects.toThrow(`daemon déjà démarré (pid ${process.pid})`);
    expect(spawned).toEqual([]);
    expect(pings).toBe(0);
  });

  it('start lance node <script> start détaché, sortie vers daemon-stdout.log, puis unref, sans attendre la socket', async () => {
    childOutput = 'hello\n';
    await manager().start();
    expect(spawned).toHaveLength(1);
    const [s] = spawned;
    expect(s!.file).toBe('/usr/bin/node');
    expect(s!.args).toEqual(['/x/dist/cli/index.js', 'start']);
    expect(s!.options.detached).toBe(true);
    const stdio = s!.options.stdio as unknown[];
    expect(stdio[0]).toBe('ignore');
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[2]).toBe(stdio[1]);
    expect(s!.options.env).toEqual({ SISYPHE_HOME: root, PATH: '/usr/bin' }); // celui du plist/de l'unité, pas celui du shell parent
    expect(s!.unrefs).toBe(1);
    expect(await readFile(detachedLogPath(paths.logsDir), 'utf8')).toBe('hello\n');
    expect((await stat(detachedLogPath(paths.logsDir))).mode & 0o777).toBe(0o600);
    // L'attente de la socket appartient à l'appelant (UI, CLI) : ici, rien d'autre que la grâce du spawn.
    expect(pings).toBe(0);
    expect(slept).toEqual([250]);
  });

  it('start ouvre le log en ajout : un démarrage précédent n’est pas écrasé', async () => {
    await writeFile(detachedLogPath(paths.logsDir), 'ancien\n');
    childOutput = 'nouveau\n';
    await manager().start();
    expect(await readFile(detachedLogPath(paths.logsDir), 'utf8')).toBe('ancien\nnouveau\n');
  });

  it('start rend la main sans attendre la socket : une socket muette n’est plus un échec ici', async () => {
    reachable = [false];
    await expect(manager().start()).resolves.toBeUndefined();
    // Aucune sonde, et une seule attente : celle de la grâce du spawn. Le budget d'attente est unique,
    // côté appelant — cumulés, les deux dépassaient l'abandon de la page (45 s).
    expect(pings).toBe(0);
    expect(slept).toEqual([250]);
  });

  it('start échoue quand le spawn échoue (exécutable introuvable…), sans attendre la socket', async () => {
    reachable = [false];
    spawnError = new Error('spawn /usr/bin/node ENOENT');
    await expect(manager().start()).rejects.toThrow('impossible de lancer le daemon : spawn /usr/bin/node ENOENT');
    expect(pings).toBe(0);
    expect(slept).toEqual([250]);
  });

  it('stop envoie stop sur la socket quand un daemon vivant tient le verrou', async () => {
    await writeFile(join(root, 'daemon.lock'), String(process.pid));
    await manager().stop();
    expect(sent).toEqual(['stop']);
  });

  it('stop est idempotent : sans verrou ou avec un verrou périmé, rien n’est envoyé', async () => {
    await manager().stop();
    await writeFile(join(root, 'daemon.lock'), String(2 ** 22 - 1));
    await manager().stop();
    expect(sent).toEqual([]);
  });

  it('status : verrou absent → arrêté ; verrou vivant → running avec pid ; verrou périmé → arrêté', async () => {
    const m = manager();
    expect(await m.status()).toEqual({ kind: 'none', installed: false, running: false, pid: null, enabledAtBoot: false, detail: 'daemon arrêté' });
    await writeFile(join(root, 'daemon.lock'), String(process.pid));
    expect(await m.status()).toEqual({
      kind: 'none', installed: false, running: true, pid: process.pid, enabledAtBoot: false, detail: `daemon détaché (pid ${process.pid})`,
    });
    await writeFile(join(root, 'daemon.lock'), String(2 ** 22 - 1));
    expect((await m.status()).running).toBe(false);
  });
});
