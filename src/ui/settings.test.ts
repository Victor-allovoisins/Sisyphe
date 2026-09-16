import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Check } from '../cli/checks.js';
import { MachineConfigError } from '../config/machine.js';
import { dataPaths, type DataPaths } from '../config/paths.js';
import { HOT_RELOAD_FIELDS, RESTART_REQUIRED_FIELDS } from '../daemon/control-types.js';
import type { Exec, ExecResult } from '../service/exec.js';
import { createSettingsData, diskUsage, settingsView, type SettingsDataDeps } from './settings.js';

let dir: string;
let paths: DataPaths;
let configPath: string;
let keyPath: string;

/** Contenu de la clé privée : il ne doit apparaître dans aucune sortie. */
const KEY_CONTENT = '-----BEGIN RSA PRIVATE KEY-----\nMIIsecret\n-----END RSA PRIVATE KEY-----\n';

const CONFIG_YAML = `github:
  appId: 12
  installationId: 34
  privateKeyPath: ~/.sisyphe/app.pem
repos:
  - ILokYou/ILokYou-iOS
agentBackend: cli
dataDir: ~/.sisyphe
`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sisyphe-settings-'));
  paths = dataPaths(dir);
  configPath = join(dir, 'config.yml');
  keyPath = join(dir, 'app.pem');
  await writeFile(configPath, CONFIG_YAML);
  await writeFile(keyPath, KEY_CONTENT);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Fichier de `n` octets sous la racine temporaire, dossiers parents compris. */
async function seedFile(relative: string, n: number): Promise<void> {
  const path = join(dir, relative);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, Buffer.alloc(n, 0x61));
}

const okCheck = (name: string, detail: string): Check => ({ name, run: async () => detail });
const throwingCheck = (name: string, message: string, warn?: boolean): Check => ({
  name,
  warn,
  run: async () => {
    throw new Error(message);
  },
});

const found = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: '' });
const absent: ExecResult = { exitCode: 127, stdout: '', stderr: 'command not found' };

const VERSION_STDOUT: Record<string, ExecResult> = {
  sisyphe: found('0.1.0'),
  node: found('v24.9.0'),
  claude: found('1.2.3 (Claude Code)'),
  git: found('git version 2.39.5 (Apple Git-154)'),
  gitleaks: absent,
};

/** `exec` de test : ne lance rien, enregistre les appels. */
function fakeExec(table: Record<string, ExecResult> = VERSION_STDOUT): Exec & { calls: [string, string[]][] } {
  const calls: [string, string[]][] = [];
  const exec = async (file: string, args: string[]): Promise<ExecResult> => {
    calls.push([file, args]);
    return table[file] ?? absent;
  };
  return Object.assign(exec, { calls });
}

/** Horloge de test en millisecondes. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function deps(over: Partial<SettingsDataDeps> = {}): SettingsDataDeps {
  return {
    paths,
    configPath,
    buildChecks: () => [okCheck('node', '24.9.0')],
    exec: fakeExec(),
    now: fakeClock().now,
    ...over,
  };
}

describe('settingsView', () => {
  it('rend la configuration telle qu\'écrite, sans développer les ~', async () => {
    const view = await settingsView(configPath, paths);
    expect(view.config.dataDir).toBe('~/.sisyphe');
    expect(view.config.github.privateKeyPath).toBe('~/.sisyphe/app.pem');
  });

  it('rend le dossier de données développé à part, pour affichage', async () => {
    const view = await settingsView(configPath, paths);
    expect(view.dataDir).toBe(paths.root);
    expect(view.dataDir).not.toBe(view.config.dataDir);
  });

  it('sert les deux listes de champs exportées par le daemon', async () => {
    const view = await settingsView(configPath, paths);
    expect(view.hotReloadable).toEqual([...HOT_RELOAD_FIELDS]);
    expect(view.restartRequired).toEqual([...RESTART_REQUIRED_FIELDS]);
  });

  it('ne laisse filtrer aucun secret', async () => {
    // La configuration désigne la clé **semée** : une régression qui lirait la clé lirait celle-ci, jamais
    // la vraie clé de la machine, et le test échouerait au lieu de passer à côté.
    await writeFile(configPath, CONFIG_YAML.replace('~/.sisyphe/app.pem', keyPath));
    const view = await settingsView(configPath, paths);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('PRIVATE KEY');
    expect(serialized).not.toContain('MIIsecret');
    // Aucune clé API dans le fichier de configuration : le schéma n'en porte pas, on le fige.
    expect(serialized).not.toMatch(/apiKey|ANTHROPIC/i);
    // Seul le chemin de la clé circule.
    expect(view.config.github.privateKeyPath).toBe(keyPath);
  });

  it('garde un budget absent absent, sans y graver le défaut du mode sdk', async () => {
    const view = await settingsView(configPath, paths);
    expect(view.config.dailyBudgetUsd).toBeUndefined();
    expect(JSON.stringify(view.config)).not.toContain('dailyBudgetUsd');
  });

  it('complète les champs absents par les défauts du schéma', async () => {
    const view = await settingsView(configPath, paths);
    expect(view.config.triggerLabel).toBe('sisyphe');
    expect(view.config.pollIntervalSeconds).toBe(60);
    expect(view.config.sandbox).toBe(false);
  });

  it('signale une configuration absente', async () => {
    await expect(settingsView(join(dir, 'nulle-part.yml'), paths)).rejects.toBeInstanceOf(MachineConfigError);
  });

  it('signale une configuration invalide', async () => {
    await writeFile(configPath, 'repos: []\n');
    await expect(settingsView(configPath, paths)).rejects.toBeInstanceOf(MachineConfigError);
  });
});

describe('diagnostics', () => {
  it('rend contrôles, versions et chemins', async () => {
    const exec = fakeExec();
    const data = createSettingsData(deps({ exec, buildChecks: () => [okCheck('node', '24.9.0'), throwingCheck('git', 'absent')] }));
    const d = await data.diagnostics();
    expect(d.checks).toEqual([
      { name: 'node', status: 'ok', detail: '24.9.0' },
      { name: 'git', status: 'fail', detail: 'absent' },
    ]);
    expect(d.versions).toEqual({ sisyphe: '0.1.0', node: '24.9.0', claude: '1.2.3', git: '2.39.5', gitleaks: null });
    expect(d.paths).toEqual({
      config: configPath,
      data: paths.root,
      socket: paths.controlSocketPath,
      logs: paths.logsDir,
    });
  });

  it('interroge chaque outil avec --version', async () => {
    const exec = fakeExec();
    await createSettingsData(deps({ exec })).diagnostics();
    expect(exec.calls).toEqual([
      ['sisyphe', ['--version']],
      ['node', ['--version']],
      ['claude', ['--version']],
      ['git', ['--version']],
      ['gitleaks', ['--version']],
    ]);
  });

  it('rend null pour une version illisible plutôt que de lever', async () => {
    const exec = fakeExec({ ...VERSION_STDOUT, git: found('pas de numéro ici'), claude: { exitCode: 1, stdout: '9.9.9', stderr: '' } });
    const d = await createSettingsData(deps({ exec })).diagnostics();
    expect(d.versions.git).toBeNull();
    expect(d.versions.claude).toBeNull();
  });

  it('partage la promesse en vol entre deux appels concurrents', async () => {
    let built = 0;
    const exec = fakeExec();
    const data = createSettingsData(deps({ exec, buildChecks: () => { built++; return []; } }));
    const [a, b] = await Promise.all([data.diagnostics(), data.diagnostics()]);
    expect(built).toBe(1);
    expect(exec.calls).toHaveLength(5);
    expect(a).toBe(b);
  });

  it('mémorise 30 s puis recalcule', async () => {
    let built = 0;
    const clock = fakeClock();
    const data = createSettingsData(deps({ now: clock.now, buildChecks: () => { built++; return []; } }));
    await data.diagnostics();
    clock.advance(29_000);
    await data.diagnostics();
    expect(built).toBe(1);
    clock.advance(1_001);
    await data.diagnostics();
    expect(built).toBe(2);
  });

  it('`fresh` passe outre les 30 s, mais rejoint un calcul en cours plutôt que d’en lancer un second', async () => {
    let built = 0;
    let release = (): void => {};
    const data = createSettingsData(deps({
      buildChecks: () => {
        built++;
        return [{ name: 'lent', run: () => new Promise<string>((resolve) => { release = () => resolve('fini'); }) }];
      },
    }));

    const first = data.diagnostics();
    const clicks = Promise.all([data.diagnostics({ fresh: true }), data.diagnostics({ fresh: true })]);
    // Laisse le premier calcul atteindre son contrôle avant de le libérer.
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, clicks]);
    expect(built).toBe(1);

    const again = data.diagnostics({ fresh: true });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await again;
    expect(built).toBe(2);
  });

  it('invalidateDiagnostics : le diagnostic suivant est recalculé sans attendre les 30 s', async () => {
    let built = 0;
    const data = createSettingsData(deps({ buildChecks: () => { built++; return []; } }));
    await data.diagnostics();
    data.invalidateDiagnostics();
    await data.diagnostics();
    expect(built).toBe(2);
  });

  it('ne mémorise pas un échec', async () => {
    let calls = 0;
    const data = createSettingsData(deps({
      buildChecks: () => {
        calls++;
        if (calls === 1) throw new Error('config illisible');
        return [];
      },
    }));
    await expect(data.diagnostics()).rejects.toThrow('config illisible');
    await expect(data.diagnostics()).resolves.toBeDefined();
    expect(calls).toBe(2);
  });
});

describe('diskUsage', () => {
  beforeEach(async () => {
    await seedFile('cache/ILokYou__ILokYou-iOS/DerivedData/a.o', 1000);
    await seedFile('cache/ILokYou__ILokYou-iOS/b.o', 500);
    await seedFile('mirrors/ILokYou__ILokYou-iOS.git/packed-refs', 200);
    await seedFile('work/.gardé', 10);
    await seedFile('logs/sisyphe.log', 300);
    // `jobs/` n'existe pas : un dossier absent vaut 0 octet.
  });

  it('mesure chaque dossier et le total', async () => {
    const usage = await diskUsage(paths);
    expect(usage.entries).toEqual([
      { name: 'cache', path: paths.cacheDir, bytes: 1500 },
      { name: 'mirrors', path: paths.mirrorsDir, bytes: 200 },
      { name: 'work', path: paths.workDir, bytes: 10 },
      { name: 'logs', path: paths.logsDir, bytes: 300 },
      { name: 'jobs', path: paths.jobsDir, bytes: 0 },
    ]);
    expect(usage.totalBytes).toBe(2010);
  });

  it('cache/ lui-même en lien symbolique : 0 octet, la cible n’est pas mesurée', async () => {
    await rm(paths.cacheDir, { recursive: true, force: true });
    await symlink(join(dir, 'mirrors'), paths.cacheDir);
    const usage = await diskUsage(paths);
    expect(usage.entries[0]).toEqual({ name: 'cache', path: paths.cacheDir, bytes: 0 });
  });

  it('ne suit pas les liens symboliques', async () => {
    await symlink(join(dir, 'mirrors'), join(paths.cacheDir, 'lien'));
    const usage = await diskUsage(paths);
    expect(usage.entries[0]?.bytes).toBe(1500);
  });

  it('ne lève jamais sur une racine inexistante', async () => {
    const usage = await diskUsage(dataPaths(join(dir, 'racine-absente')));
    expect(usage.totalBytes).toBe(0);
  });

  it('est mémorisé 30 s', async () => {
    const clock = fakeClock();
    const data = createSettingsData(deps({ now: clock.now }));
    const first = await data.diskUsage();
    await seedFile('cache/c.o', 4000);
    expect((await data.diskUsage()).totalBytes).toBe(first.totalBytes);
    clock.advance(30_001);
    expect((await data.diskUsage()).totalBytes).toBe(first.totalBytes + 4000);
  });
});

describe('createSettingsData : purge', () => {
  beforeEach(async () => {
    await seedFile('cache/ILokYou__ILokYou-iOS/DerivedData/a.o', 1000);
    await seedFile('cache/b.o', 500);
    await seedFile('mirrors/gardé.git/packed-refs', 200);
  });

  it('n\'est pas mémorisée, contrairement aux lectures', async () => {
    const data = createSettingsData(deps());
    expect((await data.purgeCache()).freedBytes).toBe(1500);
    await seedFile('cache/c.o', 42);
    expect((await data.purgeCache()).freedBytes).toBe(42);
  });

  it('périme la mesure disque mémorisée', async () => {
    const clock = fakeClock();
    const data = createSettingsData(deps({ now: clock.now }));
    expect((await data.diskUsage()).totalBytes).toBe(1700);
    await data.purgeCache();
    expect((await data.diskUsage()).totalBytes).toBe(200);
  });

  it('invalidateDisk : une purge faite par le daemon est vue aussitôt', async () => {
    const clock = fakeClock();
    const data = createSettingsData(deps({ now: clock.now }));
    expect((await data.diskUsage()).totalBytes).toBe(1700);
    await rm(paths.cacheDir, { recursive: true, force: true });
    data.invalidateDisk();
    expect((await data.diskUsage()).totalBytes).toBe(200);
  });
});
