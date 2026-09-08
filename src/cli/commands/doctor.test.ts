import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { parseMachineConfig, type MachineConfig } from '../../config/machine.js';
import { REPO_CONFIG_FILENAME } from '../../config/repo.js';
import { buildChecks, type DoctorGitHub } from './doctor.js';

function machineWith(repos: string[]): MachineConfig {
  return parseMachineConfig(
    stringify({ github: { appId: 1, installationId: 2, privateKeyPath: '/does/not/need/to/exist.pem' }, repos }),
  );
}

function fakeGithub(getFileContent: DoctorGitHub['getFileContent'], access?: { appSlug: string; repos: string[] }): DoctorGitHub {
  return {
    checkAccess: async () => access ?? { appSlug: 'app', repos: [] },
    getFileContent,
  };
}

async function run(checks: ReturnType<typeof buildChecks>, name: string): Promise<{ ok: true; detail: string } | { ok: false; message: string }> {
  const c = checks.find((x) => x.name === name);
  if (!c) throw new Error(`check absent : ${name}`);
  try {
    return { ok: true, detail: await c.run() };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

describe('buildChecks — composition de la liste', () => {
  it('inclut toujours le socle, jamais les checks dépendants de github/machine sans les deux', () => {
    const names = buildChecks({ env: {} }).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['node', 'git', 'gitleaks', 'caffeinate', 'ANTHROPIC_API_KEY', 'config machine']));
    expect(names).not.toContain('GitHub App');
    expect(names).not.toContain('clé API (appel minimal)');
    expect(names).not.toContain('espace disque');
  });

  it('ajoute la sonde de clé API seulement si ANTHROPIC_API_KEY est présente', () => {
    expect(buildChecks({ env: {} }).map((c) => c.name)).not.toContain('clé API (appel minimal)');
    expect(buildChecks({ env: { ANTHROPIC_API_KEY: 'sk-x' } }).map((c) => c.name)).toContain('clé API (appel minimal)');
  });

  it('ajoute le check espace disque seulement si des paths sont fournis', () => {
    expect(buildChecks({ env: {} }).map((c) => c.name)).not.toContain('espace disque');
    const names = buildChecks({
      env: {},
      paths: { root: '/tmp/x', dbPath: '', mirrorsDir: '', workDir: '', cacheDir: '', jobsDir: '', logsDir: '' },
    }).map((c) => c.name);
    expect(names).toContain('espace disque');
  });

  it("ajoute GitHub App et un check par repo seulement si machine ET github sont fournis", () => {
    const machine = machineWith(['acme/one', 'acme/two']);
    const names = buildChecks({ env: {}, machine, github: fakeGithub(async () => null) }).map((c) => c.name);
    expect(names).toContain('GitHub App');
    expect(names).toContain(`acme/one · ${REPO_CONFIG_FILENAME}`);
    expect(names).toContain(`acme/two · ${REPO_CONFIG_FILENAME}`);
  });
});

describe('buildChecks — node (version injectée)', () => {
  it('rejette 23, accepte 24', async () => {
    const r23 = await run(buildChecks({ env: {}, nodeVersion: '23.5.0' }), 'node');
    expect(r23.ok).toBe(false);
    if (!r23.ok) expect(r23.message).toContain('23.5.0');

    const r24 = await run(buildChecks({ env: {}, nodeVersion: '24.1.0' }), 'node');
    expect(r24).toEqual({ ok: true, detail: '24.1.0' });
  });
});

describe('buildChecks — sisyphe.yml par repo (github factice)', () => {
  const machine = machineWith(['acme/repo']);
  const checkName = `acme/repo · ${REPO_CONFIG_FILENAME}`;

  it('absent sur la branche par défaut', async () => {
    const github = fakeGithub(async () => null);
    const r = await run(buildChecks({ env: {}, machine, github }), checkName);
    expect(r).toEqual({ ok: false, message: 'absent sur la branche par défaut' });
  });

  it('YAML illisible', async () => {
    const github = fakeGithub(async () => 'baseBranch: [not: closed');
    const r = await run(buildChecks({ env: {}, machine, github }), checkName);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('YAML illisible');
  });

  it('clé inconnue (schéma strict)', async () => {
    const github = fakeGithub(async () => stringify({ baseBranch: 'main', commands: { build: 'npm run build' }, bogus: true }));
    const r = await run(buildChecks({ env: {}, machine, github }), checkName);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('invalide');
  });

  it('config valide avec un outil introuvable', async () => {
    const github = fakeGithub(async () => stringify({ baseBranch: 'main', commands: { build: 'binaire-inexistant-xyz --flag' } }));
    const r = await run(buildChecks({ env: {}, machine, github }), checkName);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('introuvable sur le PATH');
  });

  it('config valide avec des outils présents', async () => {
    const github = fakeGithub(async () => stringify({ baseBranch: 'main', commands: { build: 'sh -c true' } }));
    const r = await run(buildChecks({ env: {}, machine, github }), checkName);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.detail).toContain('base main');
  });
});

describe('buildChecks — GitHub App', () => {
  it("échoue quand l'installation n'a pas accès à un repo configuré", async () => {
    const machine = machineWith(['acme/one', 'acme/two']);
    const github = fakeGithub(async () => null, { appSlug: 'my-app', repos: ['acme/one'] });
    const r = await run(buildChecks({ env: {}, machine, github }), 'GitHub App');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('acme/two');
  });

  it('réussit quand tous les repos sont accessibles', async () => {
    const machine = machineWith(['acme/one']);
    const github = fakeGithub(async () => null, { appSlug: 'my-app', repos: ['acme/one'] });
    const r = await run(buildChecks({ env: {}, machine, github }), 'GitHub App');
    expect(r).toEqual({ ok: true, detail: 'my-app, accès à 1 repo(s)' });
  });
});

// Volontairement non exercés : lecture du vrai config.yml (config machine), appel réseau live
// (clé API), et `launchctl print` / `statfs` réels (agent launchd, espace disque). Ces checks sont
// couverts par leur seule présence dans buildChecks ci-dessus ; leur .run() n'est jamais invoqué ici.
