import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { parseMachineConfigAsWritten } from '../config/machine.js';
import { dataPaths, type DataPaths } from '../config/paths.js';
import { DaemonUnreachableError } from '../daemon/control-client.js';
import type { CommandResult } from '../daemon/control-types.js';
import type { Exec } from '../service/exec.js';
import type { ServiceKind, ServiceStatus } from '../service/types.js';
import { JOB_STATES, type JobState } from '../store/types.js';
import {
  createControlProbe,
  runAction,
  serviceLogTail,
  type ActionClient,
  type ActionJobs,
  type ActionService,
  type ActionSettings,
  type RunActionDeps,
} from './actions.js';

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
    send: vi.fn<ActionClient['send']>(async () => ({ ok: true, result: 'fait' })),
    isReachable: vi.fn<ActionClient['isReachable']>(async () => true),
    ...over,
  };
}

/** Service factice : aucun test ne parle à launchd ni à systemd. Daemon arrêté par défaut (`stop` vérifié). */
function fakeService(over: Partial<ActionService> = {}): ActionService {
  return {
    start: vi.fn<ActionService['start']>(async () => {}),
    stop: vi.fn<ActionService['stop']>(async () => {}),
    status: vi.fn<ActionService['status']>(async () => statusOf()),
    ...over,
  };
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

/** Compteurs de jobs : tous à zéro, sauf ceux qu'un test fixe. */
function fakeJobs(over: Partial<Record<JobState, number>> = {}): ActionJobs {
  const zeros = Object.fromEntries(JOB_STATES.map((s) => [s, 0])) as Record<JobState, number>;
  return { countByState: () => ({ ...zeros, ...over }) };
}

/** Purge factice : aucun test de contrôleur ne supprime un dossier. */
function fakeSettings(): ActionSettings {
  return { purgeCache: vi.fn<ActionSettings['purgeCache']>(async () => ({ freedBytes: 42 })) };
}

async function deps(over: Partial<RunActionDeps> = {}): Promise<RunActionDeps> {
  const paths = over.paths ?? (await makePaths());
  return {
    client: fakeClient(),
    service: fakeService(),
    paths,
    configPath: join(paths.root, 'config.yml'),
    jobs: fakeJobs(),
    settings: fakeSettings(),
    ...fakeClock(),
    ...over,
  };
}

/** Installation de test : clé factice et `config.yml` en chemins absolus, sous un dossier temporaire. */
async function settingsFixture() {
  const paths = await makePaths();
  const keyPath = join(paths.root, 'app.pem');
  await writeFile(keyPath, 'clé factice');
  const config = {
    github: { appId: 1, installationId: 2, privateKeyPath: keyPath },
    repos: ['acme/demo'],
    triggerLabel: 'sisyphe',
    pollIntervalSeconds: 60,
    maxConcurrentJobs: 1,
    sandbox: false,
    agentBackend: 'sdk',
    dataDir: paths.root,
  };
  const configPath = join(paths.root, 'config.yml');
  await writeFile(configPath, stringify(config));
  return { paths, configPath, config };
}

const unreachable = () =>
  fakeClient({ send: vi.fn<ActionClient['send']>(() => Promise.reject(new DaemonUnreachableError('daemon injoignable (ENOENT)'))) });

describe('runAction : traduction des résultats', () => {
  it('succès du daemon → 200 avec son résultat, commandé au nom de l’UI', async () => {
    const client = fakeClient({ send: vi.fn<ActionClient['send']>(async () => ({ ok: true, result: { queued: 2 } })) });

    const res = await runAction('poll', {}, await deps({ client }));

    expect(res).toEqual({ status: 200, body: { ok: true, result: { queued: 2 } } });
    expect(client.send).toHaveBeenCalledWith('poll', {}, 'ui');
  });

  it('refus métier du daemon → 409 avec son message', async () => {
    const client = fakeClient({ send: vi.fn<ActionClient['send']>(async () => ({ ok: false, error: 'job déjà terminé' })) });

    const res = await runAction('cancel', { jobId: 'abc' }, await deps({ client }));

    expect(res).toEqual({ status: 409, body: { error: 'job déjà terminé' } });
    expect(client.send).toHaveBeenCalledWith('cancel', { jobId: 'abc' }, 'ui');
  });

  it('daemon injoignable → 502', async () => {
    const client = fakeClient({
      send: vi.fn<ActionClient['send']>(() => Promise.reject(new DaemonUnreachableError('daemon injoignable (ENOENT)'))),
    });

    const res = await runAction('pause', {}, await deps({ client }));

    expect(res).toEqual({ status: 502, body: { error: 'daemon injoignable (ENOENT)' } });
  });

  it('délai client dépassé → 502 qui dit que l’action a pu être appliquée quand même', async () => {
    const client = fakeClient({
      send: vi.fn<ActionClient['send']>(() =>
        // Rien n'annule la commande côté daemon : elle peut aboutir après coup et apparaître dans le journal.
        Promise.reject(new DaemonUnreachableError('le daemon ne répond pas (30000 ms)', { timedOut: true })),
      ),
    });

    const res = await runAction('poll', {}, await deps({ client }));

    expect(res).toEqual({
      status: 502,
      body: { error: "Le daemon n'a pas répondu à temps ; l'action a peut-être été appliquée, vérifier le journal." },
    });
  });

  it('panne quelconque → 500 sans stack', async () => {
    const client = fakeClient({ send: vi.fn<ActionClient['send']>(() => Promise.reject(new Error('réponse illisible du daemon'))) });

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

describe('runAction : settings', () => {
  it('écrit la configuration puis la fait relire au daemon, dont le résultat est relayé', async () => {
    const { paths, configPath, config } = await settingsFixture();
    const reloaded = { applied: ['pollIntervalSeconds'], needsRestart: [] };
    const client = fakeClient({ send: vi.fn<ActionClient['send']>(async () => ({ ok: true, result: reloaded })) });

    const res = await runAction('settings', { ...config, pollIntervalSeconds: 120 }, await deps({ client, paths, configPath }));

    expect(res).toEqual({ status: 200, body: { ok: true, result: reloaded } });
    expect(client.send).toHaveBeenCalledWith('reload', {}, 'ui');
    expect(parseMachineConfigAsWritten(await readFile(configPath, 'utf8')).pollIntervalSeconds).toBe(120);
  });

  it('refus de validation → 400 avec le détail par champ, fichier intact, rien envoyé au daemon', async () => {
    const { paths, configPath, config } = await settingsFixture();
    const before = await readFile(configPath, 'utf8');
    const client = fakeClient();
    const d = await deps({ client, paths, configPath });

    const badSchema = await runAction('settings', { ...config, github: { ...config.github, appId: 'un' } }, d);
    expect(badSchema.status).toBe(400);
    expect(badSchema.body).toMatchObject({ error: 'Configuration refusée', issues: [{ path: 'github.appId' }] });

    const movedData = await runAction('settings', { ...config, dataDir: join(paths.root, 'ailleurs') }, d);
    expect(movedData.status).toBe(400);
    expect(movedData.body).toMatchObject({ issues: [{ path: 'dataDir' }] });

    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('daemon arrêté → 200 quand même : rien d’appliqué, les champs structurels modifiés à redémarrer', async () => {
    const { paths, configPath, config } = await settingsFixture();
    const body = { ...config, pollIntervalSeconds: 120, triggerLabel: 'robot', repos: ['acme/demo', 'acme/other'] };

    const res = await runAction('settings', body, await deps({ client: unreachable(), paths, configPath }));

    // Ordre de `RESTART_REQUIRED_FIELDS` ; l'intervalle, rechargeable à chaud, n'y figure pas.
    expect(res).toEqual({ status: 200, body: { ok: true, result: { applied: [], needsRestart: ['repos', 'triggerLabel'] } } });
    expect(parseMachineConfigAsWritten(await readFile(configPath, 'utf8')).triggerLabel).toBe('robot');
  });

  it('délai dépassé sur le reload → 502 qui dit que l’action a pu être appliquée', async () => {
    const { paths, configPath, config } = await settingsFixture();
    const client = fakeClient({
      send: vi.fn<ActionClient['send']>(() => Promise.reject(new DaemonUnreachableError('le daemon ne répond pas', { timedOut: true }))),
    });

    const res = await runAction('settings', config, await deps({ client, paths, configPath }));

    expect(res.status).toBe(502);
    expect((res.body as { error: string }).error).toContain("l'action a peut-être été appliquée");
  });

  it('écriture impossible → 409, fichier intact, rien envoyé au daemon', async () => {
    const { paths, configPath, config } = await settingsFixture();
    const before = await readFile(configPath, 'utf8');
    const client = fakeClient();
    // Dossier en lecture seule : la config et la clé restent lisibles, le fichier temporaire ne peut pas naître.
    await chmod(paths.root, 0o500);
    try {
      const res = await runAction('settings', { ...config, pollIntervalSeconds: 120 }, await deps({ client, paths, configPath }));

      expect(res.status).toBe(409);
      expect((res.body as { error: string }).error).toContain('impossible');
    } finally {
      await chmod(paths.root, 0o700);
    }
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(client.send).not.toHaveBeenCalled();
  });
});

describe('runAction : purge-cache', () => {
  it('refusée en 409 tant qu’un job n’est pas terminal, file comprise', async () => {
    for (const state of ['implementing', 'queued'] as const) {
      const settings = fakeSettings();

      const res = await runAction('purge-cache', {}, await deps({ jobs: fakeJobs({ [state]: 1 }), settings }));

      expect(res.status, state).toBe(409);
      expect((res.body as { error: string }).error).toContain('Purge refusée');
      expect(settings.purgeCache).not.toHaveBeenCalled();
    }
  });

  it('aucun job actif : purge par la couche de données, place libérée rendue, socket non sollicitée', async () => {
    const settings = fakeSettings();
    const client = fakeClient();

    const res = await runAction('purge-cache', undefined, await deps({ jobs: fakeJobs({ done: 3, failed: 1 }), settings, client }));

    expect(res).toEqual({ status: 200, body: { ok: true, result: { freedBytes: 42 } } });
    expect(settings.purgeCache).toHaveBeenCalledOnce();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('argument inattendu → 400, rien n’est purgé', async () => {
    const settings = fakeSettings();

    expect((await runAction('purge-cache', { dir: '/' }, await deps({ settings }))).status).toBe(400);
    expect(settings.purgeCache).not.toHaveBeenCalled();
  });
});

describe('runAction : démarrage et arrêt par le service', () => {
  it('stop passe par le gestionnaire de service au nom de l’UI, jamais par la socket', async () => {
    // Le daemon lâche la socket au deuxième essai : `doStop()` la ferme avant sa grâce de 30 s.
    const isReachable = vi.fn<ActionClient['isReachable']>().mockResolvedValueOnce(true).mockResolvedValue(false);
    const client = fakeClient({ isReachable });
    const service = fakeService();

    const res = await runAction('stop', {}, await deps({ client, service }));

    expect(res).toEqual({ status: 200, body: { ok: true, result: null } });
    expect(service.stop).toHaveBeenCalledWith('ui');
    expect(isReachable).toHaveBeenCalledTimes(2);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('stop dont le daemon répond encore → 409 : pas de confirmation verte sur un daemon qui tourne', async () => {
    const client = fakeClient({ isReachable: vi.fn<ActionClient['isReachable']>(async () => true) });
    const service = fakeService();

    const res = await runAction('stop', {}, await deps({ client, service }));

    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toContain('répond toujours');
    expect(service.stop).toHaveBeenCalledOnce();
  });

  it('échec du gestionnaire de service sur stop → 500 : là, c’est bien une panne', async () => {
    const service = fakeService({ stop: vi.fn<ActionService['stop']>(() => Promise.reject(new Error('launchctl introuvable'))) });

    const res = await runAction('stop', {}, await deps({ service }));

    expect(res).toEqual({ status: 500, body: { error: 'launchctl introuvable' } });
  });

  it('start attend que la socket réponde : succès au troisième essai', async () => {
    const isReachable = vi.fn<ActionClient['isReachable']>().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    const client = fakeClient({ isReachable });
    const service = fakeService();

    const res = await runAction('start', {}, await deps({ client, service }));

    expect(res).toEqual({ status: 200, body: { ok: true, result: null } });
    expect(service.start).toHaveBeenCalledOnce();
    expect(isReachable).toHaveBeenCalledTimes(3);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('start qui n’aboutit pas → 409 avec la fin du log du service', async () => {
    const client = fakeClient({ isReachable: vi.fn<ActionClient['isReachable']>(async () => false) });
    const service = fakeService({ status: vi.fn<ActionService['status']>(async () => statusOf('launchd')) });
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
    const client = fakeClient({ isReachable: vi.fn<ActionClient['isReachable']>(async () => false) });

    const res = await runAction('start', {}, await deps({ client }));

    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/n'a pas répondu.*$/);
  });

  it('start qui n’aboutit pas alors que le service ne répond plus : toujours 409, sans log', async () => {
    const client = fakeClient({ isReachable: vi.fn<ActionClient['isReachable']>(async () => false) });
    const service = fakeService({ status: vi.fn<ActionService['status']>(() => Promise.reject(new Error('launchctl introuvable'))) });

    const res = await runAction('start', {}, await deps({ client, service }));

    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toContain("n'a pas répondu");
  });

  it('start refusé par le service → 409 avec son message : le daemon n’est pas parti, ce n’est pas une panne', async () => {
    const service = fakeService({ start: vi.fn<ActionService['start']>(() => Promise.reject(new Error('daemon déjà démarré (pid 42)'))) });
    const client = fakeClient();

    const res = await runAction('start', {}, await deps({ client, service }));

    expect(res).toEqual({ status: 409, body: { error: 'daemon déjà démarré (pid 42)' } });
    expect(client.isReachable).not.toHaveBeenCalled();
  });
});

describe('serviceLogTail', () => {
  const noExec = vi.fn<Exec>(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

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
    const exec = vi.fn<Exec>(async () => ({ exitCode: 0, stdout: 'sisyphe: démarrage refusé\n', stderr: '' }));

    const out = await serviceLogTail('systemd', '/tmp/absent', exec);

    expect(exec).toHaveBeenCalledWith('journalctl', ['--user', '-u', 'sisyphe', '-n', '20']);
    expect(out).toBe('sisyphe: démarrage refusé');
  });

  it('journal indisponible ou fichier absent : chaîne vide, jamais d’exception', async () => {
    const failing = vi.fn<Exec>(async () => ({ exitCode: 1, stdout: '', stderr: 'introuvable' }));

    expect(await serviceLogTail('systemd', '/tmp/absent', failing)).toBe('');
    expect(await serviceLogTail('launchd', join(tmpdir(), 'sisyphe-nexiste-pas'), noExec)).toBe('');
  });
});

describe('createControlProbe', () => {
  const pong = (paused: boolean) =>
    ({ ok: true, result: { pid: 7, paused, running: 0, queued: 0, startedAt: '2026-09-13T10:00:00.000Z' } }) as CommandResult<unknown>;

  it('mémorise le ping le temps du TTL, puis resonde', async () => {
    let t = 0;
    const send = vi.fn<ActionClient['send']>(async () => pong(true));
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

  it('une sonde plus lente que le TTL n’est pas périmée d’avance : le cache est horodaté à la fin', async () => {
    let t = 0;
    // Un `ping` sans réponse dure jusqu'à 2 s, soit plus que le TTL d'une seconde.
    const send = vi.fn<ActionClient['send']>(async () => {
      t += 2_000;
      return pong(false);
    });
    const probe = createControlProbe(fakeClient({ send }), { ttlMs: 1_000, now: () => t });

    await probe.ping();
    await probe.ping();

    expect(send).toHaveBeenCalledOnce();
  });

  it('deux sondes simultanées partagent celle qui est en vol plutôt que d’en ouvrir une seconde', async () => {
    let release = (): void => {};
    const send = vi.fn<ActionClient['send']>(async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return pong(true);
    });
    const probe = createControlProbe(fakeClient({ send }), { ttlMs: 0, now: () => 0 });

    const both = Promise.all([probe.ping(), probe.ping()]);
    release();

    expect(await both).toEqual([{ pid: 7, paused: true, running: 0, queued: 0, startedAt: '2026-09-13T10:00:00.000Z' }, expect.anything()]);
    expect(send).toHaveBeenCalledOnce();
  });

  it('réponse en échec du daemon → null plutôt qu’une exception', async () => {
    const send = vi.fn<ActionClient['send']>(async () => ({ ok: false, error: 'porte fermée' }));

    expect(await createControlProbe(fakeClient({ send })).ping()).toBeNull();
  });

  it('panne autre que l’injoignabilité : elle remonte, et rien n’est mis en cache', async () => {
    const send = vi.fn<ActionClient['send']>(() => Promise.reject(new Error('réponse illisible du daemon')));
    const probe = createControlProbe(fakeClient({ send }), { now: () => 0 });

    await expect(probe.ping()).rejects.toThrow('illisible');
    await expect(probe.ping()).rejects.toThrow('illisible');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
