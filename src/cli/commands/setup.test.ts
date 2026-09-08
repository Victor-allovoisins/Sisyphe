import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseMachineConfig } from '../../config/machine.js';
import {
  buildRawConfig, parseReposAnswer, validateApiKey, validateId, validatePrivateKeyPath, validateRepos,
} from './setup.js';

describe('validateId', () => {
  it('rejette vide et NaN, accepte un entier positif', () => {
    expect(validateId('')).not.toBeNull();
    expect(validateId('abc')).not.toBeNull();
    expect(validateId('0')).not.toBeNull();
    expect(validateId('-3')).not.toBeNull();
    expect(validateId('42')).toBeNull();
  });
});

describe('validateApiKey', () => {
  it('rejette une clé vide', () => {
    expect(validateApiKey('')).not.toBeNull();
    expect(validateApiKey('   ')).not.toBeNull();
    expect(validateApiKey('sk-x')).toBeNull();
  });
});

describe('parseReposAnswer', () => {
  it('découpe et trim', () => {
    expect(parseReposAnswer(' a/b , c/d ,, ')).toEqual(['a/b', 'c/d']);
  });
});

describe('validateRepos', () => {
  it('rejette une liste vide et un format invalide', () => {
    expect(validateRepos('')).not.toBeNull();
    expect(validateRepos('pasunrepo')).not.toBeNull();
    expect(validateRepos('a/b, pasunrepo')).not.toBeNull();
    expect(validateRepos('a/b, c/d')).toBeNull();
  });
});

describe('validatePrivateKeyPath', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sisyphe-setup-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejette un fichier absent, accepte un fichier lisible', async () => {
    const missing = join(dir, 'absent.pem');
    expect(await validatePrivateKeyPath(missing)).not.toBeNull();
    const present = join(dir, 'key.pem');
    await writeFile(present, 'clé');
    expect(await validatePrivateKeyPath(present)).toBeNull();
  });
});

describe('buildRawConfig', () => {
  it('écrase github/repos et conserve le reste, y compris dataDir (triggerLabel...)', () => {
    const existing = parseMachineConfig(
      stringify({
        github: { appId: 1, installationId: 2, privateKeyPath: '/old.pem' },
        repos: ['old/repo'],
        triggerLabel: 'custom-label',
        pollIntervalSeconds: 42,
        dataDir: '/old-data',
      }),
    );
    const raw = buildRawConfig(
      { appId: 9, installationId: 10, privateKeyPath: '/new.pem', repos: ['new/repo'], dataDir: '/new-data' },
      existing,
    );
    const merged = parseMachineConfig(stringify(raw));
    expect(merged.github.appId).toBe(9);
    expect(merged.repos).toEqual(['new/repo']);
    expect(merged.dataDir).toBe('/old-data');
    expect(merged.triggerLabel).toBe('custom-label');
    expect(merged.pollIntervalSeconds).toBe(42);
  });

  it('dataDir existant conservé : un dataDir personnalisé ne doit jamais être écrasé par la relance de setup', () => {
    const existing = parseMachineConfig(
      stringify({
        github: { appId: 1, installationId: 2, privateKeyPath: '/old.pem' },
        repos: ['old/repo'],
        dataDir: '~/custom-sisyphe-data',
      }),
    );
    const raw = buildRawConfig(
      { appId: 1, installationId: 2, privateKeyPath: '/old.pem', repos: ['old/repo'], dataDir: '/Users/x/.sisyphe' },
      existing,
    );
    const merged = parseMachineConfig(stringify(raw));
    expect(merged.dataDir).toBe(existing.dataDir); // déjà étendu (expandHome) par le premier parseMachineConfig
    expect(merged.dataDir).not.toBe('/Users/x/.sisyphe');
  });

  it('sans config existante, ne pose que les champs fournis (les défauts du schéma s’appliquent, dataDir vient des réponses)', () => {
    const raw = buildRawConfig({ appId: 1, installationId: 2, privateKeyPath: '/k.pem', repos: ['a/b'], dataDir: '/d' });
    const merged = parseMachineConfig(stringify(raw));
    expect(merged.triggerLabel).toBe('sisyphe');
    expect(merged.dataDir).toBe('/d');
  });
});
