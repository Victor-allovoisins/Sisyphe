import type { SpawnOptions } from 'node:child_process';
import { writeSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  let clock: number;
  let slept: number[];
  /** Ce que le faux daemon écrit sur le descripteur reçu : prouve qu'il pointe bien sur le log. */
  let childOutput: string;

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
        return { unref: () => { entry.unrefs += 1; } };
      },
      sleep: async (ms) => { slept.push(ms); clock += ms; },
      now: () => clock,
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
    clock = 1_000;
    slept = [];
    childOutput = '';
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

  it('start lance node <script> start détaché, sortie vers daemon-stdout.log, puis unref ; succès dès que la socket répond', async () => {
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
    expect(s!.options.env).toMatchObject({ SISYPHE_HOME: root, PATH: '/usr/bin' });
    expect(s!.unrefs).toBe(1);
    expect(await readFile(detachedLogPath(paths.logsDir), 'utf8')).toBe('hello\n');
    expect(pings).toBe(1);
    expect(slept).toEqual([]);
  });

  it('start ouvre le log en ajout : un démarrage précédent n’est pas écrasé', async () => {
    await writeFile(detachedLogPath(paths.logsDir), 'ancien\n');
    childOutput = 'nouveau\n';
    await manager().start();
    expect(await readFile(detachedLogPath(paths.logsDir), 'utf8')).toBe('ancien\nnouveau\n');
  });

  it('start réussit quand la socket répond au troisième essai, 250 ms entre deux', async () => {
    reachable = [false, false, true];
    await manager().start();
    expect(pings).toBe(3);
    expect(slept).toEqual([250, 250]);
  });

  it('start échoue après 5 s sans réponse, avec les dernières lignes du log', async () => {
    reachable = [false];
    childOutput = Array.from({ length: 25 }, (_, i) => `ligne ${i + 1}`).join('\n') + '\n';
    const logPath = detachedLogPath(paths.logsDir);
    const err = await manager().start().then(() => null, (e: Error) => e);
    expect(err?.message).toBe(
      `le daemon n'a pas répondu en 5 s ; dernières lignes de ${logPath} :\n…(5 lignes coupées)\n${Array.from({ length: 20 }, (_, i) => `ligne ${i + 6}`).join('\n')}`,
    );
    expect(slept.reduce((a, b) => a + b, 0)).toBe(5_000);
    expect(pings).toBe(21); // 0, 250, …, 5000 ms
  });

  it('stop envoie stop sur la socket', async () => {
    await manager().stop();
    expect(sent).toEqual(['stop']);
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
