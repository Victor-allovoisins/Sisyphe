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
    systemctl = { exitCode: 0, stdout: 'systemd 255 (255.4-1ubuntu8)', stderr: '' };
    return {
      paths: dataPaths('/home/v/.sisyphe'), nodePath: '/usr/bin/node', scriptPath: '/x/dist/cli/index.js', env: { PATH: '/usr/bin' },
      client, exec, homeDir: '/home/v', uid: 1000,
    };
  }

  it('darwin → launchd, sans sonder systemctl', async () => {
    expect(await createServiceManager(ctx(), 'darwin')).toBeInstanceOf(LaunchdServiceManager);
    expect(calls).toEqual([]);
  });

  it('linux avec systemctl --user fonctionnel → systemd', async () => {
    expect(await createServiceManager(ctx(), 'linux')).toBeInstanceOf(SystemdServiceManager);
    expect(calls).toEqual([['systemctl', '--user', '--version']]);
  });

  it('linux sans systemctl (exit 127) → none', async () => {
    const c = ctx();
    systemctl = { exitCode: 127, stdout: '', stderr: 'spawn systemctl ENOENT' };
    expect(await createServiceManager(c, 'linux')).toBeInstanceOf(NoneServiceManager);
  });

  it('linux avec systemctl présent mais en échec (pas de bus utilisateur) → none', async () => {
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

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('remplit node, le script CLI buildé, home, uid et un exec réel', () => {
    const ctx = defaultServiceContext({ paths, client, machine: { agentBackend: 'cli' } });
    expect(ctx.paths).toBe(paths);
    expect(ctx.client).toBe(client);
    expect(ctx.nodePath).toBe(process.execPath);
    expect(ctx.scriptPath).toMatch(/[\\/]cli[\\/]index\.js$/);
    expect(ctx.homeDir).toBe(ctx.env.HOME);
    expect(ctx.uid).toBe(process.getuid?.() ?? 501);
    expect(typeof ctx.exec).toBe('function');
  });

  it('env : PATH et HOME seulement quand SISYPHE_HOME est absente et le backend est cli', () => {
    vi.stubEnv('PATH', '/usr/bin:/bin');
    vi.stubEnv('SISYPHE_HOME', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const ctx = defaultServiceContext({ paths, client, machine: { agentBackend: 'cli' } });
    expect(ctx.env).toEqual({ PATH: '/usr/bin:/bin', HOME: ctx.homeDir });
  });

  it('env : SISYPHE_HOME reprise du process quand elle est définie', () => {
    vi.stubEnv('SISYPHE_HOME', '/srv/sisyphe');
    const ctx = defaultServiceContext({ paths, client, machine: { agentBackend: 'cli' } });
    expect(ctx.env.SISYPHE_HOME).toBe('/srv/sisyphe');
  });

  it('env : ANTHROPIC_API_KEY transmise seulement au backend sdk, et seulement si elle est définie', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    expect(defaultServiceContext({ paths, client, machine: { agentBackend: 'sdk' } }).env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(defaultServiceContext({ paths, client, machine: { agentBackend: 'cli' } }).env).not.toHaveProperty('ANTHROPIC_API_KEY');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(defaultServiceContext({ paths, client, machine: { agentBackend: 'sdk' } }).env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('env : PATH absent du process → chaîne vide, jamais undefined dans l’unité', () => {
    vi.stubEnv('PATH', undefined);
    expect(defaultServiceContext({ paths, client, machine: { agentBackend: 'cli' } }).env.PATH).toBe('');
  });
});
