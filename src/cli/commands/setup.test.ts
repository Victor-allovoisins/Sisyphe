import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { parseMachineConfig } from '../../config/machine.js';
import { dataPaths } from '../../config/paths.js';
import type { ServiceManager } from '../../service/index.js';
import { SCHEMA_VERSION } from '../../store/db.js';
import {
  buildRawConfig, installService, isBuiltEntry, parseReposAnswer, prepareData, resolveEntryPath, setupCommand,
  validateApiKey, validateBackend, validateId, validatePrivateKeyPath, validateRepos,
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

/** Gestionnaire factice : la suite n'installe jamais un vrai agent launchd ni une vraie unité systemd. */
function fakeManager(warnings: string[] = []): { manager: ServiceManager; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    manager: {
      status: async () => {
        calls.push('status');
        return { kind: 'none' as const, installed: false, running: false, pid: null, enabledAtBoot: false, detail: '' };
      },
      install: async () => {
        calls.push('install');
        return { warnings };
      },
      start: async () => {
        calls.push('start');
      },
      stop: async () => {
        calls.push('stop');
      },
      uninstall: async () => {
        calls.push('uninstall');
      },
    },
  };
}

describe('prepareData', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sisyphe-prepare-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('crée les dossiers et une base migrée à la version attendue, puis referme', async () => {
    const paths = dataPaths(join(dir, 'data'));

    await prepareData(paths);

    const db = new DatabaseSync(paths.dbPath, { readOnly: true });
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    db.close();
    // La connexion de prepareData est bien fermée : sinon l'écriture ci-dessous heurterait un verrou.
    const again = new DatabaseSync(paths.dbPath);
    again.exec('PRAGMA user_version');
    again.close();
  });
});

describe('installService', () => {
  let dir: string;
  let logs: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sisyphe-install-'));
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test'); // backend sdk : sans clé, installService refuse (test dédié plus bas)
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('installe le service et affiche ses avertissements, sans jamais le démarrer', async () => {
    const { manager, calls } = fakeManager(['`sudo loginctl enable-linger v` à lancer une fois']);

    await installService(dataPaths(dir), { agentBackend: 'sdk' }, async () => manager);

    expect(calls).toEqual(['install']);
    expect(calls).not.toContain('start');
    expect(logs.join('\n')).toContain('enable-linger');
  });

  it('backend sdk sans clé dans l’environnement : refuse plutôt que d’installer un service muet', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { manager, calls } = fakeManager();

    await expect(installService(dataPaths(dir), { agentBackend: 'sdk' }, async () => manager)).rejects.toThrow(
      'ANTHROPIC_API_KEY absente',
    );

    expect(calls).toEqual([]);
  });

  it('refuse d’installer un service pointant sur une entrée non buildée', async () => {
    const { manager, calls } = fakeManager();
    const argv1 = process.argv[1];
    process.argv[1] = join(dir, 'src', 'cli', 'index.ts');
    try {
      await expect(installService(dataPaths(dir), { agentBackend: 'sdk' }, async () => manager)).rejects.toThrow(
        'Installer le service depuis le build',
      );
    } finally {
      process.argv[1] = argv1;
    }
    expect(calls).toEqual([]);
  });
});

describe('setupCommand --reinstall-service', () => {
  let dir: string;
  let logs: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sisyphe-reinstall-'));
    await writeFile(
      join(dir, 'config.yml'),
      `github:\n  appId: 1\n  installationId: 2\n  privateKeyPath: /dev/null\nrepos:\n  - acme/demo\ndataDir: ${dir}\n`,
    );
    vi.stubEnv('SISYPHE_HOME', dir);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test'); // la config du test retombe sur le backend sdk par défaut
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('repart de la config existante, ne pose aucune question et se contente d’installer', async () => {
    const { manager, calls } = fakeManager();
    const question = vi.spyOn(process.stdin, 'on'); // une question brancherait un écouteur sur stdin

    await setupCommand({ reinstallService: true }, { createManager: async () => manager });

    expect(calls).toEqual(['install']);
    expect(question).not.toHaveBeenCalled();
    expect(logs.join('\n')).toContain('sisyphe service start');
  });

  it('sans config, le message de config absente remonte plutôt qu’une réinstallation à vide', async () => {
    await rm(join(dir, 'config.yml'));
    const { manager, calls } = fakeManager();

    await expect(setupCommand({ reinstallService: true }, { createManager: async () => manager })).rejects.toThrow('Config machine absente');

    expect(calls).toEqual([]);
  });
});
