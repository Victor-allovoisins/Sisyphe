import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseMachineConfig } from '../../config/machine.js';
import {
  buildPlistPath, buildRawConfig, isBuiltEntry, parseReposAnswer, resolveEntryPath, validateApiKey, validateBackend,
  validateId, validatePrivateKeyPath, validateRepos,
} from './setup.js';

describe('isBuiltEntry', () => {
  it('accepte un .js, rejette le reste (symlink npm link, script tsx)', () => {
    expect(isBuiltEntry('/usr/local/lib/node_modules/sisyphe/dist/cli/index.js')).toBe(true);
    expect(isBuiltEntry('/opt/homebrew/bin/sisyphe')).toBe(false);
    expect(isBuiltEntry('/Users/x/sisyphe/src/cli/index.ts')).toBe(false);
  });
});

describe('resolveEntryPath', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sisyphe-entry-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('résout un lien symbolique (npm link) vers le fichier buildé réel, qui passe le garde', async () => {
    const built = join(dir, 'index.js');
    await writeFile(built, '// build\n');
    const link = join(dir, 'sisyphe'); // simule le bin posé par npm link, sans extension .js
    await symlink(built, link);
    const resolved = resolveEntryPath(link);
    expect(isBuiltEntry(resolved)).toBe(true);
    expect(isBuiltEntry(link)).toBe(false); // avant résolution, le lien lui-même échouait le garde
  });

  it('retombe sur path.resolve si le chemin n’existe pas', () => {
    const missing = join(dir, 'introuvable.js');
    expect(resolveEntryPath(missing)).toBe(missing);
  });
});

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

describe('validateBackend', () => {
  it('accepte cli et sdk, rejette le reste', () => {
    expect(validateBackend('cli')).toBeNull();
    expect(validateBackend('sdk')).toBeNull();
    expect(validateBackend('')).not.toBeNull();
    expect(validateBackend('bedrock')).not.toBeNull();
  });
});

describe('buildPlistPath', () => {
  it('met le node courant en tête, puis le dossier de claude, sans doublon', () => {
    const p = buildPlistPath('/usr/local/n/bin/node', '/Users/x/.local/bin/claude');
    expect(p.split(':')[0]).toBe('/usr/local/n/bin');
    expect(p.split(':')[1]).toBe('/Users/x/.local/bin');
    expect(p).toContain('/opt/homebrew/bin');
    expect(p.split(':').filter((d) => d === '/opt/homebrew/bin')).toHaveLength(1);
    expect(buildPlistPath('/opt/homebrew/bin/node').split(':').filter((d) => d === '/opt/homebrew/bin')).toHaveLength(1);
    expect(buildPlistPath('/usr/local/n/bin/node')).not.toContain('undefined');
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
      { appId: 9, installationId: 10, privateKeyPath: '/new.pem', repos: ['new/repo'], dataDir: '/new-data', agentBackend: 'cli' },
      existing,
    );
    const merged = parseMachineConfig(stringify(raw));
    expect(merged.agentBackend).toBe('cli');
    expect(merged.github.appId).toBe(9);
    expect(merged.repos).toEqual(['new/repo']);
    expect(merged.dataDir).toBe('/old-data');
    expect(merged.triggerLabel).toBe('custom-label');
    expect(merged.pollIntervalSeconds).toBe(42);
  });

  it('backend cli : sandbox forcé à false (sinon createApp refuse la config et setup ne la corrigerait jamais)', () => {
    const existing = parseMachineConfig(
      stringify({ github: { appId: 1, installationId: 2, privateKeyPath: '/old.pem' }, repos: ['old/repo'], sandbox: true }),
    );
    const answers = { appId: 1, installationId: 2, privateKeyPath: '/k.pem', repos: ['a/b'], dataDir: '/d' };
    expect(parseMachineConfig(stringify(buildRawConfig({ ...answers, agentBackend: 'cli' }, existing))).sandbox).toBe(false);
    expect(parseMachineConfig(stringify(buildRawConfig({ ...answers, agentBackend: 'sdk' }, existing))).sandbox).toBe(true);
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
      { appId: 1, installationId: 2, privateKeyPath: '/old.pem', repos: ['old/repo'], dataDir: '/Users/x/.sisyphe', agentBackend: 'sdk' },
      existing,
    );
    const merged = parseMachineConfig(stringify(raw));
    expect(merged.dataDir).toBe(existing.dataDir); // déjà étendu (expandHome) par le premier parseMachineConfig
    expect(merged.dataDir).not.toBe('/Users/x/.sisyphe');
  });

  it('sans config existante, ne pose que les champs fournis (les défauts du schéma s’appliquent, dataDir vient des réponses)', () => {
    const raw = buildRawConfig({ appId: 1, installationId: 2, privateKeyPath: '/k.pem', repos: ['a/b'], dataDir: '/d', agentBackend: 'cli' });
    const merged = parseMachineConfig(stringify(raw));
    expect(merged.triggerLabel).toBe('sisyphe');
    expect(merged.dataDir).toBe('/d');
    expect(merged.agentBackend).toBe('cli');
  });
});
