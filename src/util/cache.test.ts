import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dataPaths, type DataPaths } from '../config/paths.js';
import { purgeCache, treeBytes } from './cache.js';

// Tout vit sous un `mkdtemp` : ni suppression ni lecture ailleurs, cibles des liens comprises.
let dir: string;
let paths: DataPaths;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sisyphe-cache-'));
  paths = dataPaths(join(dir, 'data'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seed(path: string, n: number): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, Buffer.alloc(n, 0x61));
}

describe('treeBytes', () => {
  it('somme les fichiers sans suivre les liens, racine comprise', async () => {
    await seed(join(dir, 'dehors', 'gros.bin'), 1000);
    await seed(join(paths.cacheDir, 'a', 'b.o'), 300);
    await symlink(join(dir, 'dehors'), join(paths.cacheDir, 'lien'));
    expect(await treeBytes(paths.cacheDir)).toBe(300);

    // Racine elle-même en lien : 0, pas la taille de la cible.
    await symlink(join(dir, 'dehors'), paths.mirrorsDir);
    expect(await treeBytes(paths.mirrorsDir)).toBe(0);
  });

  it('racine absente ou simple fichier : 0, jamais d’exception', async () => {
    await seed(join(dir, 'fichier.bin'), 10);
    expect(await treeBytes(join(dir, 'absent'))).toBe(0);
    expect(await treeBytes(join(dir, 'fichier.bin'))).toBe(0);
  });
});

describe('purgeCache', () => {
  beforeEach(async () => {
    await seed(join(paths.cacheDir, 'acme__demo', 'DerivedData', 'a.o'), 1000);
    await seed(join(paths.cacheDir, 'b.o'), 500);
    await seed(join(paths.mirrorsDir, 'garde.git', 'packed-refs'), 200);
  });

  it('vide le contenu du cache, conserve le dossier et rend les octets libérés', async () => {
    expect(await purgeCache(paths)).toEqual({ freedBytes: 1500 });
    expect(await readdir(paths.cacheDir)).toEqual([]);
    expect((await stat(paths.cacheDir)).isDirectory()).toBe(true);
    expect(await treeBytes(paths.mirrorsDir)).toBe(200);
  });

  it('ne crée rien quand le cache n’existe pas', async () => {
    await rm(paths.cacheDir, { recursive: true, force: true });
    expect(await purgeCache(paths)).toEqual({ freedBytes: 0 });
    await expect(stat(paths.cacheDir)).rejects.toThrow();
  });

  it('refuse un chemin qui n’est pas le cache de ces chemins, avant tout effet', async () => {
    // Des dossiers du `mkdtemp`, jamais le vrai home : si le garde-fou régressait, c'est eux qui seraient vidés.
    const ailleurs = join(dir, 'ailleurs');
    await seed(join(ailleurs, 'garde.bin'), 10);
    await expect(purgeCache({ ...paths, cacheDir: paths.root })).rejects.toThrow(/cache/);
    await expect(purgeCache({ ...paths, cacheDir: ailleurs })).rejects.toThrow(/cache/);
    await expect(purgeCache({ ...paths, cacheDir: join(paths.root, 'cache', '..') })).rejects.toThrow(/cache/);
    expect(await readdir(paths.cacheDir)).toHaveLength(2);
    expect(await readdir(ailleurs)).toEqual(['garde.bin']);
  });

  it('cache/ en lien symbolique vers un dossier hors des données : refus, la cible reste intacte', async () => {
    const externe = join(dir, 'disque-externe');
    await seed(join(externe, 'precieux.bin'), 700);
    await rm(paths.cacheDir, { recursive: true, force: true });
    await symlink(externe, paths.cacheDir);

    await expect(purgeCache(paths)).rejects.toThrow('le cache de build est un lien symbolique : purge refusée');

    expect(await readdir(externe)).toEqual(['precieux.bin']);
    expect(await treeBytes(externe)).toBe(700);
  });

  it('cache/ simple fichier : refus', async () => {
    await rm(paths.cacheDir, { recursive: true, force: true });
    await writeFile(paths.cacheDir, 'pas un dossier');
    await expect(purgeCache(paths)).rejects.toThrow("n'est pas un dossier");
  });
});
