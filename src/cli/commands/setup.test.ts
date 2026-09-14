import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { effectiveDailyBudget, loadMachineConfig, parseMachineConfig, parseMachineConfigAsWritten } from '../../config/machine.js';
import { dataPaths, expandHome } from '../../config/paths.js';
import { writeMachineConfig } from '../../config/write.js';
import type { ServiceManager, ServiceStatus } from '../../service/index.js';

type ServiceManagerKind = ServiceStatus['kind'];
import { SCHEMA_VERSION } from '../../store/db.js';
import {
  assertBuiltEntry, buildRawConfig, installService, isBuiltEntry, parseReposAnswer, prepareData, resolveEntryPath,
  setupCommand, validateApiKey, validateBackend, validateId, validatePrivateKeyPath, validateRepos,
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
  it("accepte les quatre backends canoniques et l'alias cli, rejette le reste", () => {
    for (const backend of ['sdk', 'claude-code', 'codex', 'opencode', 'cli']) {
      expect(validateBackend(backend)).toBeNull();
    }
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
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sisyphe-setup-write-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

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
      { appId: 9, installationId: 10, privateKeyPath: '/new.pem', repos: ['new/repo'], dataDir: '/new-data', agentBackend: 'claude-code' },
      existing,
    );
    const merged = parseMachineConfig(stringify(raw));
    expect(merged.agentBackend).toBe('claude-code');
    expect(merged.github.appId).toBe(9);
    expect(merged.repos).toEqual(['new/repo']);
    expect(merged.dataDir).toBe('/old-data');
    expect(merged.triggerLabel).toBe('custom-label');
    expect(merged.pollIntervalSeconds).toBe(42);
  });

  it('un ~ hérité ou saisi survit à la réécriture, sans jamais être gravé en absolu', async () => {
    const existingYaml = stringify({
      github: { appId: 1, installationId: 2, privateKeyPath: '/old.pem' },
      repos: ['old/repo'],
      dataDir: '~/.sisyphe',
    });
    const answers = {
      appId: 9, installationId: 10, privateKeyPath: '~/cles/app.pem', repos: ['new/repo'], dataDir: '/defaut', agentBackend: 'claude-code' as const,
    };

    // La cause, pinnée : repartir de la forme développée grave l'absolu dans un fichier qui disait `~`,
    // à la première relance de setup et pour toujours.
    expect(stringify(buildRawConfig(answers, parseMachineConfig(existingYaml)))).toContain(expandHome('~/.sisyphe'));

    const raw = buildRawConfig(answers, parseMachineConfigAsWritten(existingYaml));

    const written = stringify(raw);
    expect(written).toContain('dataDir: ~/.sisyphe');
    expect(written).toContain('privateKeyPath: ~/cles/app.pem');
    expect(written).not.toContain(homedir());

    // Et le fichier écrit se relit bien en la configuration répondue, chemins développés à l'usage.
    const configPath = join(dir, 'config.yml');
    await writeMachineConfig(configPath, parseMachineConfigAsWritten(written));
    const reloaded = await loadMachineConfig(configPath);
    expect(reloaded.repos).toEqual(['new/repo']);
    expect(reloaded.github.appId).toBe(9);
    expect(reloaded.agentBackend).toBe('claude-code');
    expect(reloaded.dataDir).toBe(expandHome('~/.sisyphe'));
    expect(reloaded.github.privateKeyPath).toBe(expandHome('~/cles/app.pem'));
    // Le fichier lui-même n'a pas bougé : c'est la lecture qui développe, pas l'écriture.
    expect(await readFile(configPath, 'utf8')).toContain('dataDir: ~/.sisyphe');
  });

  it('backend claude-code : sandbox forcé à false (sinon createApp refuse la config et setup ne la corrigerait jamais)', () => {
    const existing = parseMachineConfig(
      stringify({ github: { appId: 1, installationId: 2, privateKeyPath: '/old.pem' }, repos: ['old/repo'], sandbox: true }),
    );
    const answers = { appId: 1, installationId: 2, privateKeyPath: '/k.pem', repos: ['a/b'], dataDir: '/d' };
    expect(parseMachineConfig(stringify(buildRawConfig({ ...answers, agentBackend: 'claude-code' }, existing))).sandbox).toBe(false);
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

  it("une config sdk sans plafond passée en claude-code n'y grave aucun plafond", () => {
    const existing = parseMachineConfig(
      stringify({ github: { appId: 1, installationId: 2, privateKeyPath: '/old.pem' }, repos: ['old/repo'] }),
    );
    const raw = buildRawConfig(
      { appId: 1, installationId: 2, privateKeyPath: '/k.pem', repos: ['a/b'], dataDir: '/d', agentBackend: 'claude-code' },
      existing,
    );
    // setup recopie la config existante : un plafond résolu à la lecture s'y graverait sans que l'utilisateur l'ait saisi.
    expect(stringify(raw)).not.toContain('dailyBudgetUsd');
    expect(effectiveDailyBudget(parseMachineConfig(stringify(raw)))).toBeUndefined();
  });

  it("un plafond explicitement vidé reste vidé", () => {
    const existing = parseMachineConfig(
      stringify({ github: { appId: 1, installationId: 2, privateKeyPath: '/old.pem' }, repos: ['old/repo'], dailyBudgetUsd: null }),
    );
    const raw = buildRawConfig(
      { appId: 1, installationId: 2, privateKeyPath: '/k.pem', repos: ['a/b'], dataDir: '/d', agentBackend: 'sdk' },
      existing,
    );
    // Un writer qui laisserait tomber les `null` rétablirait le plafond de 60 sous `sdk` : l'image inverse du bug corrigé.
    expect(stringify(raw)).toContain('dailyBudgetUsd: null');
    expect(effectiveDailyBudget(parseMachineConfig(stringify(raw)))).toBeUndefined();
  });

  it('sans config existante, ne pose que les champs fournis (les défauts du schéma s’appliquent, dataDir vient des réponses)', () => {
    const raw = buildRawConfig({ appId: 1, installationId: 2, privateKeyPath: '/k.pem', repos: ['a/b'], dataDir: '/d', agentBackend: 'claude-code' });
    const merged = parseMachineConfig(stringify(raw));
    expect(merged.triggerLabel).toBe('sisyphe');
    expect(merged.dataDir).toBe('/d');
    expect(merged.agentBackend).toBe('claude-code');
  });
});

/** Entrée d'un binaire buildé : `installService` et `setupCommand` refusent tout ce qui n'est pas `.js`. */
const BUILT_ENTRY = '/opt/sisyphe/dist/cli/index.js';

/** Gestionnaire factice : la suite n'installe jamais un vrai agent launchd ni une vraie unité systemd. */
function fakeManager(opts: { warnings?: string[]; kind?: ServiceManagerKind } = {}): { manager: ServiceManager; calls: string[] } {
  const calls: string[] = [];
  const kind = opts.kind ?? 'launchd';
  return {
    calls,
    manager: {
      status: async () => {
        calls.push('status');
        return { kind, installed: kind !== 'none', running: false, pid: null, enabledAtBoot: false, detail: '' };
      },
      install: async () => {
        calls.push('install');
        return { warnings: opts.warnings ?? [] };
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

const userVersionOf = (path: string): number => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
};

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

    expect(userVersionOf(paths.dbPath)).toBe(SCHEMA_VERSION);
    // La connexion de prepareData est bien fermée : sinon l'écriture ci-dessous heurterait un verrou.
    const again = new DatabaseSync(paths.dbPath);
    again.exec('PRAGMA user_version');
    again.close();
  });
});

describe('assertBuiltEntry', () => {
  let argv1: string;
  beforeEach(() => {
    argv1 = process.argv[1];
  });
  afterEach(() => {
    process.argv[1] = argv1;
  });

  it('accepte le fichier buildé, refuse un script tsx (un service pointant dessus ne démarrerait jamais)', () => {
    process.argv[1] = BUILT_ENTRY;
    expect(() => assertBuiltEntry()).not.toThrow();
    process.argv[1] = '/opt/sisyphe/src/cli/index.ts';
    expect(() => assertBuiltEntry()).toThrow('Installer le service depuis le build');
  });
});

describe('installService', () => {
  let logs: string[];

  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test'); // backend sdk : sans clé, installService refuse (test dédié plus bas)
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('installe le service et affiche ses avertissements, sans jamais le démarrer', async () => {
    const { manager, calls } = fakeManager({ warnings: ['`sudo loginctl enable-linger v` à lancer une fois'] });

    expect(await installService({ agentBackend: 'sdk' }, manager)).toBe(true);

    expect(calls).toEqual(['status', 'install']);
    expect(calls).not.toContain('start');
    expect(logs.join('\n')).toContain('enable-linger');
  });

  it('plateforme sans service géré : consigne pour le daemon détaché, aucune installation, aucune erreur', async () => {
    const { manager, calls } = fakeManager({ kind: 'none' });

    expect(await installService({ agentBackend: 'sdk' }, manager)).toBe(false);

    expect(calls).toEqual(['status']);
    expect(logs.join('\n')).toContain('Aucun service géré sur cette plateforme');
  });

  it('backend sdk sans clé : refuse plutôt que d’installer un service muet ; la clé répondue suffit', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const { manager, calls } = fakeManager();

    await expect(installService({ agentBackend: 'sdk' }, manager)).rejects.toThrow('ANTHROPIC_API_KEY absente');
    expect(calls).toEqual([]);

    // Clé recueillie par setup : elle voyage en paramètre, pas par `process.env`.
    expect(await installService({ agentBackend: 'sdk' }, manager, 'sk-repondue')).toBe(true);
  });
});

describe('setupCommand --reinstall-service', () => {
  let dir: string;
  let logs: string[];
  let argv1: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sisyphe-reinstall-'));
    await writeFile(
      join(dir, 'config.yml'),
      `github:\n  appId: 1\n  installationId: 2\n  privateKeyPath: /dev/null\nrepos:\n  - acme/demo\ndataDir: ${dir}\n`,
    );
    vi.stubEnv('SISYPHE_HOME', dir);
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test'); // la config du test retombe sur le backend sdk par défaut
    argv1 = process.argv[1];
    process.argv[1] = BUILT_ENTRY; // sinon le garde-fou d'entrée dépend du lanceur de vitest
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
  });
  afterEach(async () => {
    process.argv[1] = argv1;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('repart de la config existante, ne pose aucune question, prépare les données et installe', async () => {
    const { manager, calls } = fakeManager();
    const question = vi.spyOn(process.stdin, 'on'); // une question brancherait un écouteur sur stdin

    await setupCommand({ reinstallService: true }, { createManager: async () => manager });

    expect(calls).toEqual(['status', 'install']);
    expect(question).not.toHaveBeenCalled();
    // Dossiers et base créés avant l'installation : le plist et l'unité référencent logsDir et la racine.
    expect(userVersionOf(join(dir, 'sisyphe.db'))).toBe(SCHEMA_VERSION);
    expect(logs.join('\n')).toContain('sisyphe service start');
  });

  it('entrée non buildée : refus immédiat, sans lire la config ni construire de gestionnaire', async () => {
    process.argv[1] = '/opt/sisyphe/src/cli/index.ts';
    const { manager, calls } = fakeManager();

    await expect(setupCommand({ reinstallService: true }, { createManager: async () => manager })).rejects.toThrow(
      'Installer le service depuis le build',
    );

    expect(calls).toEqual([]);
  });

  it('sans config, le message de config absente remonte plutôt qu’une réinstallation à vide', async () => {
    await rm(join(dir, 'config.yml'));
    const { manager, calls } = fakeManager();

    await expect(setupCommand({ reinstallService: true }, { createManager: async () => manager })).rejects.toThrow('Config machine absente');

    expect(calls).toEqual([]);
  });
});
