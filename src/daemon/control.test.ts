import { stat, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO, makeHarness, repoRef } from '../../test/helpers/harness.js';
import { ControlClient } from './control-client.js';
import { MAX_SOCKET_PATH_BYTES, SocketPathTooLongError, startControlServer, type ControlTarget } from './control.js';
import type { DaemonStatus } from './control-types.js';
import { Daemon, type DaemonOptions } from './daemon.js';

/** Timers à l'heure : seuls la socket et les appels explicites font avancer le daemon. */
const QUIET: DaemonOptions = { intervals: { pollMs: 3_600_000, cancelMs: 3_600_000, prTrackMs: 3_600_000, purgeMs: 3_600_000 } };
/** Borne unique de toutes les attentes : large, la machine de test peut être chargée. */
const WAIT_MS = 15_000;

type Harness = Awaited<ReturnType<typeof makeHarness>>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function waitFor(check: () => boolean | Promise<boolean>, ms = WAIT_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition jamais atteinte');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function withinWait<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([p, new Promise<never>((_r, reject) => setTimeout(() => reject(new Error(`${what} : jamais arrivé`)), WAIT_MS))]);
}

/** Daemon réel démarré sur les fakes, socket ouverte et joignable. Arrêté en fin de test, même en échec. */
async function startDaemon(h: Harness, opts: { paused?: boolean } = {}) {
  // `configPath` : `reload` doit relire le fichier du dossier temporaire, jamais la configuration de la machine.
  const daemon = new Daemon(h.deps, { ...QUIET, configPath: h.configPath });
  if (opts.paused) daemon.pause('cli'); // la file se remplit au premier tick mais rien ne démarre
  const started = daemon.start();
  cleanups.push(async () => {
    await daemon.stop();
    await started;
  });
  const client = new ControlClient(h.paths.controlSocketPath);
  await waitFor(() => client.isReachable());
  return { daemon, client, started };
}

/** Le daemon vu par la socket, avec un `cancel` bien plus long que le délai d'inactivité des tests. */
function slowCancelTarget(daemon: Daemon, delayMs: number): ControlTarget {
  return {
    status: () => daemon.status(),
    requestTick: () => daemon.requestTick(),
    pause: (s) => daemon.pause(s),
    resume: (s) => daemon.resume(s),
    reload: (s) => daemon.reload(s),
    purgeBuildCache: (s) => daemon.purgeBuildCache(s),
    retryJob: (id, s) => daemon.retryJob(id, s),
    enqueueIssue: (i, s) => daemon.enqueueIssue(i, s),
    stop: () => daemon.stop(),
    cancelJob: async (id) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { ok: false, error: `lent : ${id}` };
    },
  };
}

/**
 * Envoie des octets bruts et renvoie tout ce que le serveur écrit jusqu'à la fermeture de la connexion.
 * `halfClose` : ferme le côté émission sitôt la ligne partie, comme `nc -N` ou un script.
 */
function sendRaw(path: string, payload: Buffer | string, opts: { halfClose?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const chunks: Buffer[] = [];
    socket.on('connect', () => {
      socket.write(payload);
      if (opts.halfClose) socket.end();
    });
    socket.on('data', (c: Buffer) => chunks.push(c));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

const listCandidatesCalls = (h: Harness) => h.source.calls.filter((c) => c === 'listCandidates').length;

describe('socket de contrôle : cycle de vie', () => {
  it('ping renvoie le statut ; le fichier est en 0600', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const { client } = await startDaemon(h);

    const res = await client.send<DaemonStatus>('ping');
    expect(res).toMatchObject({ ok: true, result: { pid: process.pid, paused: false, running: 0, queued: 0 } });
    expect((await stat(h.paths.controlSocketPath)).mode & 0o777).toBe(0o600);
  });

  it('chemin de socket trop long : refus nommé au démarrage, qui dit quoi raccourcir', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const path = join(h.root, 'x'.repeat(MAX_SOCKET_PATH_BYTES), 'control.sock');
    const err = await startControlServer({ path, daemon: {} as ControlTarget, actions: h.deps.actions, log: h.deps.log }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SocketPathTooLongError);
    expect((err as Error).message).toContain('SISYPHE_HOME');
    expect((err as Error).message).toContain(String(MAX_SOCKET_PATH_BYTES));
    // Rien n'est créé au passage : la limite est vérifiée avant d'ouvrir quoi que ce soit.
    await expect(stat(path)).rejects.toThrow();
  });

  it('une socket périmée est remplacée au démarrage', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    await writeFile(h.paths.controlSocketPath, 'reste d’un daemon mort');
    const { client } = await startDaemon(h);
    expect((await client.send('ping')).ok).toBe(true);
  });

  it('stop() du daemon ferme la socket et supprime le fichier', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const { daemon, client, started } = await startDaemon(h);
    await daemon.stop();
    await started;
    await expect(stat(h.paths.controlSocketPath)).rejects.toThrow();
    expect(await client.isReachable()).toBe(false);
  });

  it('close() est idempotent et supprime le fichier ; une connexion muette est fermée après le délai d’inactivité', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const path = join(h.root, 'ctl.sock');
    const daemon = new Daemon(h.deps, { ...QUIET, control: false, configPath: h.configPath });
    const server = await startControlServer({ path, daemon, actions: h.actions, log: h.deps.log, idleTimeoutMs: 100 });
    cleanups.push(() => server.close());

    expect((await new ControlClient(path).send('ping')).ok).toBe(true);
    const closedByServer = new Promise<void>((resolve) => {
      const socket = createConnection(path); // ne dit rien
      socket.on('close', () => resolve());
      socket.on('error', () => undefined);
    });
    await expect(withinWait(closedByServer, 'fermeture par le serveur')).resolves.toBeUndefined();

    await server.close();
    await server.close();
    await expect(stat(path)).rejects.toThrow();
  });

  it('le délai d’inactivité ne coupe pas une commande qui attend derrière la porte du daemon', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const path = join(h.root, 'ctl.sock');
    const daemon = new Daemon(h.deps, { ...QUIET, control: false, configPath: h.configPath });
    const server = await startControlServer({ path, daemon: slowCancelTarget(daemon, 300), actions: h.actions, log: h.deps.log, idleTimeoutMs: 100 });
    cleanups.push(() => server.close());

    expect(await new ControlClient(path).send('cancel', { jobId: 'j1' })).toEqual({ ok: false, error: 'lent : j1' });
  });

  it('un client qui ferme son côté émission sitôt sa ligne envoyée reçoit quand même la réponse d’une commande lente', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const path = join(h.root, 'ctl.sock');
    const daemon = new Daemon(h.deps, { ...QUIET, control: false, configPath: h.configPath });
    const server = await startControlServer({ path, daemon: slowCancelTarget(daemon, 300), actions: h.actions, log: h.deps.log });
    cleanups.push(() => server.close());

    const answer = await sendRaw(path, '{"cmd":"cancel","jobId":"j1"}\n', { halfClose: true });
    expect(JSON.parse(answer)).toEqual({ ok: false, error: 'lent : j1' });
  });

  it('la socket est ouverte avant le prologue : ping répond pendant une réconciliation encore en cours', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Le prologue interroge GitHub repo par repo : ici il ne rend jamais la main avant qu'on le libère.
    h.source.ensureLabels = () => blocked;
    const daemon = new Daemon(h.deps, { ...QUIET, configPath: h.configPath });
    const started = daemon.start();
    cleanups.push(async () => {
      release(); // sans quoi start() reste bloqué dans le prologue et n'observerait jamais l'arrêt
      await daemon.stop();
      await started;
    });

    const client = new ControlClient(h.paths.controlSocketPath);
    await waitFor(() => client.isReachable());
    expect((await client.send('ping')).ok).toBe(true);
    expect(listCandidatesCalls(h)).toBe(0); // aucun tick encore : on a bien répondu depuis le prologue
  });

  it('stop() pendant le prologue : start() se résout, la socket est fermée et son fichier supprimé', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.source.ensureLabels = () => blocked;
    const daemon = new Daemon(h.deps, { ...QUIET, configPath: h.configPath });
    const started = daemon.start();
    const client = new ControlClient(h.paths.controlSocketPath);
    await waitFor(() => client.isReachable());

    const stopped = daemon.stop(); // l'arrêt arrive alors que le prologue n'a pas rendu la main
    release();
    await withinWait(stopped, 'arrêt');
    await withinWait(started, 'start()');

    await expect(stat(h.paths.controlSocketPath)).rejects.toThrow();
    expect(await client.isReachable()).toBe(false);
    expect(listCandidatesCalls(h)).toBe(0); // aucun tick : les timers n'ont jamais été posés
  });

  it('`control: false` : start() n’ouvre rien', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const daemon = new Daemon(h.deps, { ...QUIET, control: false, configPath: h.configPath });
    const started = daemon.start();
    cleanups.push(async () => {
      await daemon.stop();
      await started;
    });
    await waitFor(() => listCandidatesCalls(h) >= 1); // le premier tick est passé : la socket aurait été ouverte avant
    await expect(stat(h.paths.controlSocketPath)).rejects.toThrow();
  });
});

describe('socket de contrôle : commandes', () => {
  it('pause / resume basculent l’état et sont journalisés avec la source de la requête', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const { client } = await startDaemon(h);

    expect(await client.send<DaemonStatus>('pause', {}, 'ui')).toMatchObject({ ok: true, result: { paused: true } });
    expect(await client.send<DaemonStatus>('resume', {}, 'ui')).toMatchObject({ ok: true, result: { paused: false } });
    // `start` est journalisé par le daemon lui-même à l'ouverture de la socket : le cycle de vie est visible.
    expect(h.actions.listRecent(10).map((a) => [a.action, a.source, a.outcome])).toEqual([
      ['resume', 'ui', 'ok'],
      ['pause', 'ui', 'ok'],
      ['start', 'cli', 'ok'],
    ]);
  });

  it('poll déclenche un tick de plus, répond sans l’attendre, et est journalisé', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const { client } = await startDaemon(h);
    await waitFor(() => listCandidatesCalls(h) >= 1); // le tick de start() est passé : le suivant sera bien celui du poll
    const before = listCandidatesCalls(h);

    expect(await client.send('poll', {}, 'ui')).toEqual({ ok: true, result: null });
    await waitFor(() => listCandidatesCalls(h) === before + 1);
    expect(h.actions.listRecent(1)[0]).toMatchObject({ action: 'poll', source: 'ui', outcome: 'ok' });
  });

  it('un journal en panne ne casse pas la réponse', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const { client } = await startDaemon(h);
    h.actions.record = () => {
      throw new Error('disque plein');
    };
    expect(await client.send('poll')).toEqual({ ok: true, result: null });
  });

  it('stop répond puis arrête le daemon : start() se résout, la socket disparaît, l’action est journalisée', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const { client, started } = await startDaemon(h);

    expect(await client.send('stop', {}, 'ui')).toEqual({ ok: true, result: null });
    await withinWait(started, 'résolution de start()');
    await expect(stat(h.paths.controlSocketPath)).rejects.toThrow();
    expect(await client.isReachable()).toBe(false);
    expect(h.actions.listRecent(1)[0]).toMatchObject({ action: 'stop', source: 'ui', outcome: 'ok' });
  });

  it('cancel : job en file annulé et label retiré ; job inconnu refusé', async () => {
    const h = await makeHarness({ steps: [] });
    const { client } = await startDaemon(h, { paused: true });
    await waitFor(() => h.store.listByStates(['queued']).length === 1);
    const job = h.store.listByStates(['queued'])[0];

    const res = await client.send('cancel', { jobId: job.id }, 'ui');
    expect(res).toMatchObject({ ok: true, result: { id: job.id, state: 'cancelled' } });
    expect(h.source.labelsOf({ repo: repoRef, number: 7 })).not.toContain('sisyphe');
    expect(h.actions.listRecent(1)[0]).toMatchObject({ action: 'cancel', source: 'ui', jobId: job.id, outcome: 'ok' });

    expect(await client.send('cancel', { jobId: 'nope' })).toEqual({ ok: false, error: 'job inconnu : nope' });
  });

  it('retry : nouveau job queued après une annulation ; refusé sur un job encore en file', async () => {
    const h = await makeHarness({ steps: [] });
    const { client } = await startDaemon(h, { paused: true });
    await waitFor(() => h.store.listByStates(['queued']).length === 1);
    const job = h.store.listByStates(['queued'])[0];

    const early = await client.send('retry', { jobId: job.id });
    expect(early).toEqual({ ok: false, error: 'job non relançable (queued) : seuls failed, blocked et cancelled le sont' });

    await client.send('cancel', { jobId: job.id });
    const res = await client.send<{ id: string; state: string }>('retry', { jobId: job.id }, 'ui');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.id).not.toBe(job.id);
    expect(res.result.state).toBe('queued');
    expect(h.source.labelsOf({ repo: repoRef, number: 7 })).toContain('sisyphe');
  });

  it('reload : routé vers le daemon, applique le chaud, signale le structurel, et est journalisé', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const { client } = await startDaemon(h);
    await h.writeConfig({ dailyBudgetUsd: 12, repos: [REPO, 'acme/other'] });

    expect(await client.send('reload', {}, 'ui')).toEqual({ ok: true, result: { applied: ['dailyBudgetUsd'], needsRestart: ['repos'] } });
    expect(h.deps.machine.dailyBudgetUsd).toBe(12);
    expect(h.deps.machine.repos).toEqual([REPO]);
    expect(h.actions.listRecent(1)[0]).toMatchObject({ action: 'reload', source: 'ui', outcome: 'ok' });
  });

  it('purge : routée vers le daemon, place libérée rendue, et journalisée', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const { client } = await startDaemon(h);

    expect(await client.send('purge', {}, 'ui')).toEqual({ ok: true, result: { freedBytes: 0 } });
    expect(h.actions.listRecent(1)[0]).toMatchObject({ action: 'purge', source: 'ui', outcome: 'ok' });
  });

  it('enqueue : job créé et label posé ; repo hors configuration refusé', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    h.source.addIssue(repoRef, { number: 9, title: 'Sans label', labels: [] });
    const { client } = await startDaemon(h, { paused: true });

    const res = await client.send('enqueue', { repo: REPO, issueNumber: 9 }, 'ui');
    expect(res).toMatchObject({ ok: true, result: { state: 'queued', repo: REPO, issueNumber: 9 } });
    expect(h.source.labelsOf({ repo: repoRef, number: 9 })).toContain('sisyphe');

    expect(await client.send('enqueue', { repo: 'acme/other', issueNumber: 1 })).toEqual({ ok: false, error: 'repo hors configuration : acme/other' });
  });
});

describe('socket de contrôle : requêtes invalides', () => {
  it('non JSON, commande inconnue, arguments manquants ou invalides → ok: false, jamais d’exception', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const { client } = await startDaemon(h);
    const path = h.paths.controlSocketPath;

    expect(await sendRaw(path, 'pas du json\n')).toBe('{"ok":false,"error":"requête non JSON"}\n');
    expect(JSON.parse(await sendRaw(path, '{"cmd":"dance"}\n'))).toEqual({ ok: false, error: 'commande inconnue : dance' });
    expect(JSON.parse(await sendRaw(path, '[1,2]\n'))).toEqual({ ok: false, error: 'commande inconnue : undefined' });
    expect(JSON.parse(await sendRaw(path, '{"cmd":"ping","source":"mars"}\n'))).toMatchObject({ ok: false, error: expect.stringContaining('source') });

    const missing = await client.send('cancel', {});
    expect(missing).toMatchObject({ ok: false, error: expect.stringMatching(/^requête invalide : jobId/) });
    const badIssue = await client.send('enqueue', { repo: REPO, issueNumber: 0 });
    expect(badIssue).toMatchObject({ ok: false, error: expect.stringContaining('issueNumber') });

    expect((await client.send('ping')).ok).toBe(true); // le serveur a survécu à tout ça
  });

  it('une requête de plus de 64 Ko est refusée et la connexion fermée', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const { client } = await startDaemon(h);

    const answer = await sendRaw(h.paths.controlSocketPath, Buffer.alloc(65 * 1024, 'a'));
    expect(JSON.parse(answer)).toEqual({ ok: false, error: 'requête trop longue' });
    expect((await client.send('ping')).ok).toBe(true);
  });
});
