import { dirname } from 'node:path';
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
    vi.stubEnv('PATH', '/sisyphe-test/a:/sisyphe-test/b');
    vi.stubEnv('SISYPHE_HOME', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
    const ctx = defaultServiceContext({ paths, client, machine: { agentBackend: 'cli' } });
    // Le répertoire du node courant en tête : aucun des lanceurs n'hérite du PATH d'un shell.
    expect(ctx.env).toEqual({ PATH: `${nodeDir}:/sisyphe-test/a:/sisyphe-test/b`, HOME: ctx.homeDir });
  });

  it('env : le répertoire du node déjà présent dans le PATH n’y est pas dupliqué', () => {
    vi.stubEnv('PATH', `/sisyphe-test/a:${nodeDir}:/sisyphe-test/b`);
    const { PATH } = defaultServiceContext({ paths, client, machine: { agentBackend: 'cli' } }).env;
    expect(PATH).toBe(`${nodeDir}:/sisyphe-test/a:/sisyphe-test/b`);
    expect(PATH!.split(':').filter((d) => d === nodeDir)).toHaveLength(1);
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

  it('env : PATH absent du process → aucune entrée PATH (le gestionnaire applique son défaut, un PATH vide serait pire)', () => {
    vi.stubEnv('PATH', undefined);
    expect(defaultServiceContext({ paths, client, machine: { agentBackend: 'cli' } }).env).not.toHaveProperty('PATH');
  });
});
