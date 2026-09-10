import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceManager, ServiceStatus } from '../../service/index.js';
import { formatStatus, parseServiceAction, serviceCommand } from './service.js';

const status: ServiceStatus = {
  kind: 'launchd', installed: true, running: true, pid: 4242, enabledAtBoot: true, detail: 'state = running',
};

interface FakeOptions {
  /** État initial ; `start`/`stop` le font basculer, sauf `stuck`. */
  running?: boolean;
  kind?: ServiceStatus['kind'];
  /** Le daemon ne bascule jamais : l'attente doit s'arrêter au délai plutôt que tourner sans fin. */
  stuck?: boolean;
}

/** Gestionnaire factice : aucun `launchctl` ni `systemctl` réel dans la suite. */
function fakeManager(opts: FakeOptions = {}): { manager: ServiceManager; calls: string[] } {
  const calls: string[] = [];
  let running = opts.running ?? true;
  return {
    calls,
    manager: {
      status: async () => {
        calls.push('status');
        return { ...status, kind: opts.kind ?? status.kind, running, pid: running ? status.pid : null };
      },
      install: async () => {
        calls.push('install');
        return { warnings: [] };
      },
      start: async () => {
        calls.push('start');
        if (!opts.stuck) running = true;
      },
      stop: async () => {
        calls.push('stop');
        if (!opts.stuck) running = false;
      },
      uninstall: async () => {
        calls.push('uninstall');
      },
    },
  };
}

describe('parseServiceAction', () => {
  it('accepte les quatre actions et refuse le reste en listant les valeurs attendues', () => {
    for (const a of ['status', 'start', 'stop', 'uninstall']) expect(parseServiceAction(a)).toBe(a);
    expect(() => parseServiceAction('restart')).toThrow('Action inconnue : restart (attendu status, start, stop, uninstall).');
    expect(() => parseServiceAction('')).toThrow('Action inconnue');
  });
});

describe('formatStatus', () => {
  it('une ligne clé : valeur par champ, pid absent affiché en tiret', () => {
    expect(formatStatus(status)).toBe(
      ['kind : launchd', 'installed : true', 'running : true', 'pid : 4242', 'enabledAtBoot : true', 'detail : state = running'].join('\n'),
    );
    expect(formatStatus({ ...status, pid: null })).toContain('pid : -');
  });
});

describe('serviceCommand', () => {
  let dir: string;
  let logs: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sisyphe-service-'));
    await writeFile(
      join(dir, 'config.yml'),
      `github:\n  appId: 1\n  installationId: 2\n  privateKeyPath: /dev/null\nrepos:\n  - acme/demo\ndataDir: ${dir}\n`,
    );
    vi.stubEnv('SISYPHE_HOME', dir);
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

  it('status : n’agit pas sur le service et affiche les six champs', async () => {
    const { manager, calls } = fakeManager();

    await serviceCommand('status', { createManager: async () => manager });

    expect(calls).toEqual(['status']);
    expect(logs.join('\n')).toContain('kind : launchd');
    expect(logs.join('\n')).toContain('enabledAtBoot : true');
  });

  it('start et stop routent vers le gestionnaire puis affichent le statut obtenu', async () => {
    const started = fakeManager({ running: false });
    await serviceCommand('start', { createManager: async () => started.manager });
    expect(started.calls).toEqual(['start', 'status']);
    expect(logs.join('\n')).toContain('running : true');

    logs = [];
    const stopped = fakeManager({ running: true });
    await serviceCommand('stop', { createManager: async () => stopped.manager });
    expect(stopped.calls).toEqual(['stop', 'status']);
    // Le statut affiché est celui d'après l'arrêt : la socket répond « ok » avant que le daemon ait fini.
    expect(logs.join('\n')).toContain('running : false');
    expect(logs.join('\n')).toContain('pid : -');
  });

  it('daemon qui ne bascule pas : l’attente s’arrête au délai et affiche l’état réel', async () => {
    const { manager, calls } = fakeManager({ running: true, stuck: true });

    await serviceCommand('stop', { createManager: async () => manager, settleMs: 30 });

    expect(calls.filter((c) => c === 'status').length).toBeGreaterThan(1); // il a bien réessayé
    expect(logs.join('\n')).toContain('running : true');
  });

  it('uninstall ne demande rien et ne sonde pas le statut d’un service qui n’existe plus', async () => {
    const { manager, calls } = fakeManager();

    await serviceCommand('uninstall', { createManager: async () => manager });

    expect(calls).toEqual(['status', 'uninstall']);
    expect(logs.join('\n')).toContain('Service désinstallé.');
  });

  it('uninstall sur une plateforme sans service géré : consigne, pas d’erreur', async () => {
    const { manager, calls } = fakeManager({ kind: 'none' });

    await serviceCommand('uninstall', { createManager: async () => manager });

    expect(calls).toEqual(['status']);
    expect(logs.join('\n')).toContain('Aucun service géré sur cette plateforme');
  });

  it('l’erreur du gestionnaire remonte telle quelle', async () => {
    const { manager } = fakeManager();
    manager.start = async () => {
      throw new Error("Impossible de démarrer l'agent launchd : refusé");
    };

    await expect(serviceCommand('start', { createManager: async () => manager })).rejects.toThrow(
      "Impossible de démarrer l'agent launchd : refusé",
    );
  });

  it('action inconnue : refusée avant toute lecture de config ou construction de gestionnaire', async () => {
    const { manager, calls } = fakeManager();

    await expect(serviceCommand('restart', { createManager: async () => manager })).rejects.toThrow('Action inconnue');

    expect(calls).toEqual([]);
  });

  it('config absente : le message de la config manquante remonte', async () => {
    await rm(join(dir, 'config.yml'));
    const { manager } = fakeManager();

    await expect(serviceCommand('status', { createManager: async () => manager })).rejects.toThrow('Config machine absente');
  });
});
