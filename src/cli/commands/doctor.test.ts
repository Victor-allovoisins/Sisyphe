import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { parseMachineConfig, type MachineConfig } from '../../config/machine.js';
import { REPO_CONFIG_FILENAME } from '../../config/repo.js';
import type { ServiceStatus } from '../../service/index.js';
import { buildChecks, parseAuthStatus, type DoctorGitHub, type DoctorService } from './doctor.js';

const installedStatus: ServiceStatus = {
  kind: 'launchd', installed: true, running: true, pid: 321, enabledAtBoot: true, detail: 'state = running',
};

/** Service factice : la suite n'appelle jamais `launchctl` ni `systemctl`. */
function fakeService(status: Partial<ServiceStatus> = {}): DoctorService {
  return { status: async () => ({ ...installedStatus, ...status }) };
}

function machineWith(repos: string[], extra: Record<string, unknown> = {}): MachineConfig {
  return parseMachineConfig(
    stringify({ github: { appId: 1, installationId: 2, privateKeyPath: '/does/not/need/to/exist.pem' }, repos, ...extra }),
  );
}

function fakeGithub(getFileContent: DoctorGitHub['getFileContent'], access?: { appSlug: string; repos: string[] }): DoctorGitHub {
  return {
    checkAccess: async () => access ?? { appSlug: 'app', repos: [] },
    getFileContent,
  };
}

// Les checks exercés via ce helper (node, sisyphe.yml par repo, GitHub App) ne renvoient jamais la forme
// { warn, message } — seule la sonde de clé API le fait, testée séparément plus bas via `probe()`.
async function run(checks: ReturnType<typeof buildChecks>, name: string): Promise<{ ok: true; detail: string } | { ok: false; message: string }> {
  const c = checks.find((x) => x.name === name);
  if (!c) throw new Error(`check absent : ${name}`);
  try {
    const result = await c.run();
    if (typeof result !== 'string') throw new Error(`${name} a renvoyé la forme warn, inattendue ici`);
    return { ok: true, detail: result };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

describe('buildChecks — composition de la liste', () => {
  it('inclut toujours le socle, jamais les checks dépendants de github/machine sans les deux', () => {
    const names = buildChecks({ env: {}, platform: 'darwin' }).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['node', 'git', 'gitleaks', 'caffeinate', 'ANTHROPIC_API_KEY', 'config machine']));
    expect(names).not.toContain('GitHub App');
    expect(names).not.toContain('clé API (appel minimal)');
    expect(names).not.toContain('espace disque');
  });

  it('caffeinate sur macOS seulement, linger sur Linux seulement', () => {
    const darwin = buildChecks({ env: {}, platform: 'darwin' }).map((c) => c.name);
    const linux = buildChecks({ env: {}, platform: 'linux' }).map((c) => c.name);
    expect(darwin).toContain('caffeinate');
    expect(darwin).not.toContain('linger');
    expect(linux).toContain('linger');
    expect(linux).not.toContain('caffeinate');
  });

  it('le check « service » n’existe que si un gestionnaire est fourni', () => {
    expect(buildChecks({ env: {}, platform: 'darwin' }).map((c) => c.name)).not.toContain('service');
    expect(buildChecks({ env: {}, platform: 'darwin', service: fakeService() }).map((c) => c.name)).toContain('service');
  });

  it('ajoute la sonde de clé API seulement si ANTHROPIC_API_KEY est présente', () => {
    expect(buildChecks({ env: {} }).map((c) => c.name)).not.toContain('clé API (appel minimal)');
    expect(buildChecks({ env: { ANTHROPIC_API_KEY: 'sk-x' } }).map((c) => c.name)).toContain('clé API (appel minimal)');
  });

  it('backend cli : les checks de clé API cèdent la place aux checks de la CLI claude', () => {
    const machine = machineWith(['acme/one'], { agentBackend: 'cli' });
    const names = buildChecks({ env: { ANTHROPIC_API_KEY: 'sk-x' }, machine, github: fakeGithub(async () => null) }).map((c) => c.name);
    expect(names).toContain('claude (CLI)');
    expect(names).toContain('claude auth status');
    expect(names).not.toContain('ANTHROPIC_API_KEY');
    expect(names).not.toContain('clé API (appel minimal)');
  });

  it('backend sdk (défaut) : pas de check de la CLI claude', () => {
    const machine = machineWith(['acme/one']);
    const names = buildChecks({ env: {}, machine, github: fakeGithub(async () => null) }).map((c) => c.name);
    expect(names).toContain('ANTHROPIC_API_KEY');
    expect(names).not.toContain('claude (CLI)');
  });

  it('ajoute le check espace disque seulement si des paths sont fournis', () => {
    expect(buildChecks({ env: {} }).map((c) => c.name)).not.toContain('espace disque');
    const names = buildChecks({
      env: {},
      paths: { root: '/tmp/x', dbPath: '', mirrorsDir: '', workDir: '', cacheDir: '', jobsDir: '', logsDir: '', controlSocketPath: '' },
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

// Le vrai binaire `claude` n'est jamais lancé par les tests : seule la lecture de sa sortie est exercée.
describe('check « service »', () => {
  const checkOf = (service: DoctorService) => {
    const c = buildChecks({ env: {}, platform: 'darwin', service }).find((x) => x.name === 'service');
    if (!c) throw new Error('check absent');
    return c;
  };

  it('installé : ok, avec l’état du daemon et le redémarrage au boot', async () => {
    await expect(checkOf(fakeService()).run()).resolves.toBe('launchd, actif (pid 321), au boot : oui · state = running');
    await expect(checkOf(fakeService({ running: false, pid: null, enabledAtBoot: false })).run()).resolves.toContain('arrêté, au boot : non');
  });

  it('non installé : avertissement citant sisyphe setup --reinstall-service, jamais un échec bloquant', async () => {
    const check = checkOf(fakeService({ installed: false, running: false, pid: null, enabledAtBoot: false, detail: 'agent launchd non chargé' }));
    await expect(check.run()).resolves.toEqual({ warn: true, message: 'launchd : non installé — lancer `sisyphe setup --reinstall-service`' });
  });

  it('plateforme sans service géré : avertissement sans conseil de réinstallation', async () => {
    const result = await checkOf(fakeService({ kind: 'none', installed: false, detail: 'daemon arrêté' })).run();
    expect(result).toEqual({ warn: true, message: 'aucun service géré sur cette plateforme (daemon arrêté)' });
  });
});

describe('consignes d’installation', () => {
  it('un prérequis en échec donne la commande de l’OS', async () => {
    const tooOld = (platform: NodeJS.Platform) => run(buildChecks({ env: {}, platform, nodeVersion: '22.9.0' }), 'node');
    expect(await tooOld('darwin')).toEqual({ ok: false, message: 'Node 22.9.0, il faut 24 ou plus — installer : brew install node' });
    expect((await tooOld('linux') as { message: string }).message).toContain('apt-get install -y nodejs');
    expect((await tooOld('freebsd') as { message: string }).message).toBe('Node 22.9.0, il faut 24 ou plus'); // rien de sûr à conseiller
  });
});

describe('parseAuthStatus', () => {
  it('accepte loggedIn true et rapporte la méthode', () => {
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'x@y.z' }))).toBe('connecté (claude.ai)');
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true }))).toBe('connecté');
  });

  it('refuse loggedIn false, un JSON illisible et une forme inattendue', () => {
    expect(() => parseAuthStatus(JSON.stringify({ loggedIn: false }))).toThrow(/claude login/);
    expect(() => parseAuthStatus('pas du json')).toThrow(/illisible/);
    expect(() => parseAuthStatus('null')).toThrow();
  });
});

describe('buildChecks — clé API (appel minimal), fetch simulé (jamais de réseau réel)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function probe(status: number): Promise<string | { warn: true; message: string }> {
    vi.stubGlobal('fetch', async () => new Response(null, { status }));
    const checks = buildChecks({ env: { ANTHROPIC_API_KEY: 'sk-test' } });
    const check = checks.find((c) => c.name === 'clé API (appel minimal)');
    if (!check) throw new Error('check absent');
    return check.run();
  }

  it('200 -> clé valide', async () => {
    expect(await probe(200)).toBe('clé valide');
  });

  it('429 -> succès, clé acceptée en rate limit', async () => {
    expect(await probe(429)).toBe('clé acceptée, rate limit');
  });

  it('401 et 403 -> échec dur (clé refusée)', async () => {
    await expect(probe(401)).rejects.toThrow('clé refusée');
    await expect(probe(403)).rejects.toThrow('clé refusée');
  });

  it('autre statut -> échec dur avec le code HTTP', async () => {
    await expect(probe(500)).rejects.toThrow('réponse HTTP 500');
  });

  it('fetch qui rejette (réseau indisponible) -> warn, ne lève pas', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const checks = buildChecks({ env: { ANTHROPIC_API_KEY: 'sk-test' } });
    const check = checks.find((c) => c.name === 'clé API (appel minimal)');
    if (!check) throw new Error('check absent');
    await expect(check.run()).resolves.toEqual({ warn: true, message: 'réseau indisponible' });
  });
});

// Volontairement non exercés (au-delà de la sonde de clé API ci-dessus, mockée) : lecture du vrai
// config.yml (config machine), `statfs` réel (espace disque) et `loginctl` (linger, Linux seulement).
// Ces checks sont couverts par leur seule présence dans buildChecks ; leur .run() n'est jamais invoqué ici.
