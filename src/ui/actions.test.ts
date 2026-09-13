import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { dataPaths, type DataPaths } from '../config/paths.js';
import { DaemonUnreachableError } from '../daemon/control-client.js';
import type { CommandResult } from '../daemon/control-types.js';
import type { ExecResult } from '../service/exec.js';
import type { ServiceKind, ServiceStatus } from '../service/types.js';
import { createControlProbe, runAction, serviceLogTail, type ActionClient, type ActionService, type RunActionDeps } from './actions.js';

const statusOf = (kind: ServiceKind = 'launchd'): ServiceStatus => ({
  kind,
  installed: true,
  running: false,
  pid: null,
  enabledAtBoot: false,
  detail: 'state = not running',
});

/** Client factice : aucun test n'ouvre de socket de contrôle. */
function fakeClient(over: Partial<ActionClient> = {}): ActionClient {
  return {
    send: vi.fn(async () => ({ ok: true, result: 'fait' }) as CommandResult<unknown>),
    isReachable: vi.fn(async () => true),
    ...over,
  };
}

/** Service factice : aucun test ne parle à launchd ni à systemd. */
function fakeService(over: Partial<ActionService> = {}): ActionService {
  return { start: vi.fn(async () => {}), stop: vi.fn(async () => {}), status: vi.fn(async () => statusOf()), ...over };
}

/** Horloge de test : `sleep` avance le temps que lit `now`, l'échéance de 30 s tombe donc sans attendre. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

async function makePaths(): Promise<DataPaths> {
  const paths = dataPaths(await mkdtemp(join(tmpdir(), 'sisyphe-act-')));
  await mkdir(paths.logsDir, { recursive: true });
  return paths;
}

async function deps(over: Partial<RunActionDeps> = {}): Promise<RunActionDeps> {
  return { client: fakeClient(), service: fakeService(), paths: await makePaths(), ...fakeClock(), ...over };
}

describe('runAction : traduction des résultats', () => {
  it('succès du daemon → 200 avec son résultat, commandé au nom de l’UI', async () => {
    const client = fakeClient({ send: vi.fn(async () => ({ ok: true, result: { queued: 2 } }) as CommandResult<unknown>) });

    const res = await runAction('poll', {}, await deps({ client }));

    expect(res).toEqual({ status: 200, body: { ok: true, result: { queued: 2 } } });
    expect(client.send).toHaveBeenCalledWith('poll', {}, 'ui');
  });

  it('refus métier du daemon → 409 avec son message', async () => {
    const client = fakeClient({ send: vi.fn(async () => ({ ok: false, error: 'job déjà terminé' }) as CommandResult<unknown>) });

    const res = await runAction('cancel', { jobId: 'abc' }, await deps({ client }));

    expect(res).toEqual({ status: 409, body: { error: 'job déjà terminé' } });
    expect(client.send).toHaveBeenCalledWith('cancel', { jobId: 'abc' }, 'ui');
  });

  it('daemon injoignable → 502', async () => {
    const client = fakeClient({
      send: vi.fn(() => Promise.reject(new DaemonUnreachableError('daemon injoignable (ENOENT)'))),
    });

    const res = await runAction('pause', {}, await deps({ client }));

    expect(res).toEqual({ status: 502, body: { error: 'daemon injoignable (ENOENT)' } });
  });

  it('panne quelconque → 500 sans stack', async () => {
    const client = fakeClient({ send: vi.fn(() => Promise.reject(new Error('réponse illisible du daemon'))) });

    const res = await runAction('resume', {}, await deps({ client }));

    expect(res).toEqual({ status: 500, body: { error: 'réponse illisible du daemon' } });
  });
});

describe('runAction : validation', () => {
  it('action inconnue → 400 listant les actions acceptées', async () => {
    const client = fakeClient();

    const res = await runAction('rm-rf', {}, await deps({ client }));

    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toContain('rm-rf');
    expect((res.body as { error: string }).error).toContain('cancel');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('arguments invalides → 400, rien n’est envoyé au daemon', async () => {
    const client = fakeClient();
    const d = await deps({ client });

    for (const [name, body] of [
      ['cancel', {}],
      ['cancel', { jobId: '' }],
      ['retry', { jobId: 42 }],
      ['enqueue', { repo: 'acme/demo' }],
      ['enqueue', { repo: 'acme/demo', issueNumber: 0 }],
      ['enqueue', { repo: 'acme/demo', issueNumber: '7' }],
      // Objet strict : une clé inconnue est refusée plutôt qu'ignorée en silence.
      ['poll', { jobId: 'abc' }],
    ] as Array<[string, unknown]>) {
      expect((await runAction(name, body, d)).status, `${name} ${JSON.stringify(body)}`).toBe(400);
    }
    expect(client.send).not.toHaveBeenCalled();
  });

  it('corps absent : les actions sans argument passent quand même', async () => {
    const client = fakeClient();

    expect((await runAction('poll', undefined, await deps({ client }))).status).toBe(200);
    expect(client.send).toHaveBeenCalledWith('poll', {}, 'ui');
  });
});

describe('runAction : démarrage et arrêt par le service', () => {
  it('stop passe par le gestionnaire de service, jamais par la socket', async () => {
    const client = fakeClient();
    const service = fakeService();

    const res = await runAction('stop', {}, await deps({ client, service }));

    expect(res).toEqual({ status: 200, body: { ok: true, result: null } });
    expect(service.stop).toHaveBeenCalledOnce();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('start attend que la socket réponde : succès au troisième essai', async () => {
    const isReachable = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const client = fakeClient({ isReachable });
    const service = fakeService();

    const res = await runAction('start', {}, await deps({ client, service }));

    expect(res).toEqual({ status: 200, body: { ok: true, result: null } });
    expect(service.start).toHaveBeenCalledOnce();
    expect(isReachable).toHaveBeenCalledTimes(3);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('start qui n’aboutit pas → 409 avec la fin du log du service', async () => {
    const client = fakeClient({ isReachable: vi.fn(async () => false) });
    const service = fakeService({ status: vi.fn(async () => statusOf('launchd')) });
    const paths = await makePaths();
    await writeFile(join(paths.logsDir, 'launchd.err.log'), 'Error: config illisible\n');

    const res = await runAction('start', {}, await deps({ client, service, paths }));

    expect(res.status).toBe(409);
    const { error } = res.body as { error: string };
    expect(error).toContain('30 s');
    expect(error).toContain('Error: config illisible');
    expect(service.start).toHaveBeenCalledOnce();
  });

  it('start qui n’aboutit pas sans log lisible : le message reste seul', async () => {
    const client = fakeClient({ isReachable: vi.fn(async () => false) });

    const res = await runAction('start', {}, await deps({ client }));

    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/n'a pas répondu.*$/);
  });

  it('start qui n’aboutit pas alors que le service ne répond plus : toujours 409, sans log', async () => {
    const client = fakeClient({ isReachable: vi.fn(async () => false) });
    const service = fakeService({ status: vi.fn(() => Promise.reject(new Error('launchctl introuvable'))) });

    const res = await runAction('start', {}, await deps({ client, service }));

    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toContain("n'a pas répondu");
  });

  it('échec du gestionnaire de service → 500', async () => {
    const service = fakeService({ start: vi.fn(() => Promise.reject(new Error('launchctl introuvable'))) });

    const res = await runAction('start', {}, await deps({ service }));

    expect(res).toEqual({ status: 500, body: { error: 'launchctl introuvable' } });
  });
});

describe('serviceLogTail', () => {
  const noExec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }) as ExecResult);

  it('launchd : la fin du fichier d’erreur du job', async () => {
    const paths = await makePaths();
    const lines = Array.from({ length: 30 }, (_, i) => `ligne ${i + 1}`).join('\n');
    await writeFile(join(paths.logsDir, 'launchd.err.log'), lines);

    const out = await serviceLogTail('launchd', paths.logsDir, noExec);

    expect(out).toContain('ligne 30');
    expect(out).not.toContain('ligne 10');
    expect(noExec).not.toHaveBeenCalled();
  });

  it('none : la sortie du daemon détaché', async () => {
    const paths = await makePaths();
    await writeFile(join(paths.logsDir, 'daemon-stdout.log'), 'port déjà utilisé\n');

    expect(await serviceLogTail('none', paths.logsDir, noExec)).toBe('port déjà utilisé');
  });

  it('systemd : les dernières lignes du journal de l’unité', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'sisyphe: démarrage refusé\n', stderr: '' }) as ExecResult);

    const out = await serviceLogTail('systemd', '/tmp/absent', exec);

    expect(exec).toHaveBeenCalledWith('journalctl', ['--user', '-u', 'sisyphe', '-n', '20']);
    expect(out).toBe('sisyphe: démarrage refusé');
  });

  it('journal indisponible ou fichier absent : chaîne vide, jamais d’exception', async () => {
    const failing = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'introuvable' }) as ExecResult);

    expect(await serviceLogTail('systemd', '/tmp/absent', failing)).toBe('');
    expect(await serviceLogTail('launchd', join(tmpdir(), 'sisyphe-nexiste-pas'), noExec)).toBe('');
  });
});

describe('createControlProbe', () => {
  const pong = (paused: boolean) =>
    ({ ok: true, result: { pid: 7, paused, running: 0, queued: 0, startedAt: '2026-09-13T10:00:00.000Z' } }) as CommandResult<unknown>;

  it('mémorise le ping le temps du TTL, puis resonde', async () => {
    let t = 0;
    const send = vi.fn(async () => pong(true));
    const probe = createControlProbe(fakeClient({ send }), { ttlMs: 1_000, now: () => t });

    expect((await probe.ping())?.paused).toBe(true);
    await probe.ping();
    expect(send).toHaveBeenCalledOnce();

    t = 1_500;
    await probe.ping();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith('ping', {}, 'ui');
  });

  it('daemon injoignable → null ; c’est une réponse, donc elle est mémorisée comme les autres', async () => {
    let t = 0;
    const send = vi
      .fn<ActionClient['send']>()
      .mockRejectedValueOnce(new DaemonUnreachableError('daemon injoignable (ENOENT)'))
      .mockResolvedValue(pong(false));
    const probe = createControlProbe(fakeClient({ send }), { ttlMs: 1_000, now: () => t });

    expect(await probe.ping()).toBeNull();
    expect(await probe.ping()).toBeNull();
    expect(send).toHaveBeenCalledOnce();

    // Daemon revenu : la sonde suivante le voit dès le TTL écoulé.
    t = 1_500;
    expect((await probe.ping())?.paused).toBe(false);
  });

  it('réponse en échec du daemon → null plutôt qu’une exception', async () => {
    const send = vi.fn(async () => ({ ok: false, error: 'porte fermée' }) as CommandResult<unknown>);

    expect(await createControlProbe(fakeClient({ send })).ping()).toBeNull();
  });

  it('panne autre que l’injoignabilité : elle remonte, et rien n’est mis en cache', async () => {
    const send = vi.fn(() => Promise.reject(new Error('réponse illisible du daemon')));
    const probe = createControlProbe(fakeClient({ send }), { now: () => 0 });

    await expect(probe.ping()).rejects.toThrow('illisible');
    await expect(probe.ping()).rejects.toThrow('illisible');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
