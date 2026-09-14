import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataPaths } from '../config/paths.js';
import type { Exec, ExecResult } from './exec.js';
import { LaunchdServiceManager, NoneServiceManager, SystemdServiceManager, createServiceManager, defaultServiceContext } from './index.js';
import type { ServiceClient, ServiceContext } from './types.js';

const client: ServiceClient = { send: async () => ({ ok: true, result: null }), isReachable: async () => false };

describe('createServiceManager', () => {
  let calls: string[][];
  let systemctl: ExecResult;

  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return systemctl;
  };

  function ctx(): ServiceContext {
    calls = [];
    systemctl = { exitCode: 0, stdout: 'Version=255.4-1ubuntu8\n', stderr: '' };
    return {
      paths: dataPaths('/home/v/.sisyphe'), nodePath: '/usr/bin/node', scriptPath: '/x/dist/cli/index.js', env: { PATH: '/usr/bin' },
      client, exec, homeDir: '/home/v', uid: 1000,
    };
  }

  it('darwin → launchd, sans sonder systemctl', async () => {
    expect(await createServiceManager(ctx(), 'darwin')).toBeInstanceOf(LaunchdServiceManager);
    expect(calls).toEqual([]);
  });

  it('linux avec un gestionnaire utilisateur qui répond → systemd, sondé par une propriété en ligne', async () => {
    expect(await createServiceManager(ctx(), 'linux')).toBeInstanceOf(SystemdServiceManager);
    expect(calls).toEqual([['systemctl', '--user', 'show', '-p', 'Version']]); // pas `--version`, qui répond sans bus
  });

  it('linux sans systemctl (exit 127) → none', async () => {
    const c = ctx();
    systemctl = { exitCode: 127, stdout: '', stderr: 'spawn systemctl ENOENT' };
    expect(await createServiceManager(c, 'linux')).toBeInstanceOf(NoneServiceManager);
  });

  it('linux avec le binaire présent mais aucun bus utilisateur (conteneur, session sans XDG_RUNTIME_DIR) → none', async () => {
    const c = ctx();
    systemctl = { exitCode: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' };
    expect(await createServiceManager(c, 'linux')).toBeInstanceOf(NoneServiceManager);
  });

  it('autre plateforme → none, sans sonder systemctl', async () => {
    expect(await createServiceManager(ctx(), 'win32')).toBeInstanceOf(NoneServiceManager);
    expect(await createServiceManager(ctx(), 'freebsd')).toBeInstanceOf(NoneServiceManager);
    expect(calls).toEqual([]);
  });

  it('par défaut, la plateforme est celle du process', async () => {
    const m = await createServiceManager(ctx());
    if (process.platform === 'darwin') expect(m).toBeInstanceOf(LaunchdServiceManager);
    else expect(m).not.toBeInstanceOf(LaunchdServiceManager);
  });
});

describe('defaultServiceContext', () => {
  const paths = dataPaths('/home/v/.sisyphe');
  const nodeDir = dirname(process.execPath);
  /** Socle ajouté en queue du PATH du daemon, après `<home>/.local/bin`. */
  const STANDARD_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('remplit node, le script CLI buildé, home, uid et un exec réel', () => {
    const ctx = defaultServiceContext({ paths, client, machine: { agentBackend: 'claude-code' } });
    expect(ctx.paths).toBe(paths);
    expect(ctx.client).toBe(client);
    expect(ctx.nodePath).toBe(process.execPath);
    expect(ctx.scriptPath).toMatch(/[\\/]cli[\\/]index\.js$/);
    expect(ctx.homeDir).toBe(ctx.env.HOME);
    expect(ctx.uid).toBe(process.getuid?.() ?? 501);
    expect(typeof ctx.exec).toBe('function');
  });

  it('env : PATH et HOME seulement quand SISYPHE_HOME est absente et le backend est claude-code', () => {
    vi.stubEnv('PATH', '/sisyphe-test/a:/sisyphe-test/b');
    vi.stubEnv('SISYPHE_HOME', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const ctx = defaultServiceContext({ paths, client, machine: { agentBackend: 'claude-code' } });
    // Le répertoire du node courant en tête : aucun des lanceurs n'hérite du PATH d'un shell.
    expect(ctx.env).toEqual({
      PATH: `${nodeDir}:/sisyphe-test/a:/sisyphe-test/b:${join(homedir(), '.local', 'bin')}:${STANDARD_DIRS.join(':')}`,
      HOME: ctx.homeDir,
    });
  });

  it('env : le PATH garde le node en tête, ~/.local/bin et le socle système, sans doublon', () => {
    vi.stubEnv('PATH', `/sisyphe-test/a:${nodeDir}:/usr/bin:/sisyphe-test/b`);
    const { PATH } = defaultServiceContext({ paths, client, machine: { agentBackend: 'claude-code' } }).env;
    const dirs = PATH!.split(':');
    expect(dirs[0]).toBe(nodeDir);
    expect(dirs).toContain(join(homedir(), '.local', 'bin'));
    for (const d of STANDARD_DIRS) expect(dirs).toContain(d);
    expect(new Set(dirs).size).toBe(dirs.length); // ni le node ni /usr/bin, déjà présents, ne sont répétés
  });

  it('env : SISYPHE_HOME reprise du process quand elle est définie', () => {
    vi.stubEnv('SISYPHE_HOME', '/srv/sisyphe');
    const ctx = defaultServiceContext({ paths, client, machine: { agentBackend: 'claude-code' } });
    expect(ctx.env.SISYPHE_HOME).toBe('/srv/sisyphe');
  });

  it('env : la clé fournie explicitement l’emporte sur celle de l’environnement, et reste réservée au backend sdk', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-environnement');
    expect(defaultServiceContext({ paths, client, machine: { agentBackend: 'sdk' }, apiKey: 'sk-repondue' }).env.ANTHROPIC_API_KEY).toBe('sk-repondue');
    expect(defaultServiceContext({ paths, client, machine: { agentBackend: 'claude-code' }, apiKey: 'sk-repondue' }).env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('env : ANTHROPIC_API_KEY transmise seulement au backend sdk, et seulement si elle est définie', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    expect(defaultServiceContext({ paths, client, machine: { agentBackend: 'sdk' } }).env.ANTHROPIC_API_KEY).toBe('sk-test');
    for (const agentBackend of ['claude-code', 'codex', 'opencode'] as const) {
      expect(defaultServiceContext({ paths, client, machine: { agentBackend } }).env, agentBackend).not.toHaveProperty('ANTHROPIC_API_KEY');
    }
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(defaultServiceContext({ paths, client, machine: { agentBackend: 'sdk' } }).env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('env : PATH absent du process → le node et le socle suffisent, jamais un PATH vide', () => {
    vi.stubEnv('PATH', undefined);
    expect(defaultServiceContext({ paths, client, machine: { agentBackend: 'claude-code' } }).env.PATH).toBe(
      `${nodeDir}:${join(homedir(), '.local', 'bin')}:${STANDARD_DIRS.join(':')}`,
    );
  });
});
