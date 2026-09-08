import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataPaths } from '../config/paths.js';
import { acquireLock } from './lock.js';

describe('acquireLock', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sisyphe-lock-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('refuse un second appel tant que le premier tient le verrou', async () => {
    const paths = dataPaths(root);
    const release = await acquireLock(paths);
    await expect(acquireLock(paths)).rejects.toThrow(/tourne déjà/);
    await release();
  });

  it('reprend un verrou périmé (pid inexistant) et y écrit le pid courant', async () => {
    const paths = dataPaths(root);
    const lockPath = join(paths.root, 'daemon.lock');
    // Improbable qu'un process porte ce pid (au-delà de pid_max par défaut sur la plupart des systèmes).
    await writeFile(lockPath, String(2 ** 22 - 1));
    const release = await acquireLock(paths);
    expect((await readFile(lockPath, 'utf8')).trim()).toBe(String(process.pid));
    await release();
  });

  it('release supprime le fichier de verrou', async () => {
    const paths = dataPaths(root);
    const lockPath = join(paths.root, 'daemon.lock');
    const release = await acquireLock(paths);
    await release();
    await expect(stat(lockPath)).rejects.toThrow();
  });
});
