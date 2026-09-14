import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { effectiveDailyBudget } from '../../src/config/machine.js';
import { Daemon } from '../../src/daemon/daemon.js';
import { pollOnce } from '../../src/daemon/poll.js';
import type { JobStore } from '../../src/store/jobs.js';
import type { JobState } from '../../src/store/types.js';
import { REPO, makeHarness, readyVerdict, repoRef, report, writeFeature } from '../helpers/harness.js';

/** Timers à l'heure : seuls les appels explicites font avancer le daemon. Pas de socket : elle a ses propres tests. */
const QUIET = { intervals: { pollMs: 3_600_000, cancelMs: 3_600_000, prTrackMs: 3_600_000, purgeMs: 3_600_000 }, control: false };
const ISSUE_7 = { repo: repoRef, number: 7 };

/** Amène un job `queued` à un état terminal en suivant les transitions autorisées. */
function finishAs(store: JobStore, id: string, final: 'done' | 'failed' | 'blocked' | 'cancelled'): void {
  const path: Record<typeof final, JobState[]> = {
    cancelled: ['cancelled'],
    failed: ['failed'],
    blocked: ['triaging', 'blocked'],
    done: ['triaging', 'implementing', 'verifying', 'delivering', 'done'],
  };
  for (const s of path[final]) store.transition(id, s);
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition jamais atteinte');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Promesse à résolution manuelle, pour figer un appel réseau du fake au milieu d'un tick ou d'une commande. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

describe('Daemon : pause, tick immédiat, statut', () => {
  it('pause bloque le démarrage d’un job queued, resume le libère', async () => {
    const h = await makeHarness({ steps: [{ output: readyVerdict }, { output: report('a'), sideEffect: writeFeature('hello\n') }] });
    const daemon = new Daemon(h.deps, QUIET);
    await pollOnce(h.deps);
    const job = h.store.listByStates(['queued'])[0];

    expect(daemon.pause('ui').paused).toBe(true);
    await daemon.requestTick();
    expect(h.store.get(job.id)!.state).toBe('queued');
    expect(h.agent.calls).toHaveLength(0);

    expect(daemon.resume('ui').paused).toBe(false);
    await daemon.requestTick();
    expect(h.store.get(job.id)!.state).not.toBe('queued');
    await daemon.stop(); // interrompt le job démarré (SHUTDOWN) puis attend sa sortie

    expect(h.actions.listRecent(10).map((a) => [a.action, a.source, a.outcome])).toEqual([
      ['resume', 'ui', 'ok'],
      ['pause', 'ui', 'ok'],
    ]);
  });

  it('resume() démarre un job queued sans attendre le timer', async () => {
    const h = await makeHarness({ steps: [{ output: readyVerdict }, { output: report('a'), sideEffect: writeFeature('hello\n') }] });
    // Aucun timer (start() n'est pas appelé) : seul le tick déclenché par resume() peut démarrer le job.
    const daemon = new Daemon(h.deps, QUIET);
    await pollOnce(h.deps);
    const job = h.store.listByStates(['queued'])[0];
    daemon.pause('ui');
    daemon.resume('ui');
    await waitFor(() => h.store.get(job.id)!.state !== 'queued', 2000);
    await daemon.stop();
  });

  it('requestTick pendant un tick lent : un seul tick de plus, après le premier ; le tick du timer est ignoré', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps, QUIET);
    const g = gate();
    let started = 0;
    const real = h.source.listCandidates.bind(h.source);
    h.source.listCandidates = async (repo) => {
      started++;
      await g.wait;
      return real(repo);
    };

    const slow = daemon.requestTick();
    await waitFor(() => started === 1);
    const a = daemon.requestTick();
    const b = daemon.requestTick();
    expect(b).toBe(a); // deux demandes pendant le même tick → un seul tick supplémentaire
    await (daemon as unknown as { tick(): Promise<void> }).tick(); // timer : ignoré, ne s'empile pas
    expect(started).toBe(1); // rien n'a démarré avant la fin du tick lent

    g.release();
    await Promise.all([slow, a]);
    expect(started).toBe(2);

    await daemon.requestTick(); // plus rien en cours : une nouvelle demande déclenche un tick
    expect(started).toBe(3);
  });

  it('status() : pid, pause, jobs en cours et en file, startedAt ISO', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps, QUIET);
    await pollOnce(h.deps);
    const st = daemon.status();
    expect(st).toMatchObject({ pid: process.pid, paused: false, running: 0, queued: 1 });
    expect(Date.parse(st.startedAt)).not.toBeNaN();
  });

  it('une commande reçue pendant l’arrêt est refusée', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps, QUIET);
    await daemon.stop();
    expect(await daemon.cancelJob('x', 'ui')).toEqual({ ok: false, error: "daemon en cours d'arrêt" });
  });
});

describe('Daemon.cancelJob', () => {
  it('job en cours : aborte le pipeline, état final cancelled, label retiré', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps, QUIET);
    let agentStarted: () => void = () => undefined;
    const agentEntered = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    h.deps.agent = {
      async run(opts: { signal: AbortSignal }) {
        agentStarted();
        await new Promise<never>((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason as Error)));
      },
    } as never;

    const started = daemon.start();
    await agentEntered;
    const job = h.store.listRecent(1)[0];
    const res = await daemon.cancelJob(job.id, 'ui');
    expect(res.ok).toBe(true);
    await waitFor(() => h.store.get(job.id)!.state === 'cancelled');
    await daemon.stop();
    await started;

    expect(h.source.labelsOf(ISSUE_7)).toEqual([]); // trigger retiré par la commande, statut effacé par le pipeline
    expect(h.actions.listForJob(job.id)).toMatchObject([{ action: 'cancel', source: 'ui', outcome: 'ok', repo: REPO, issueNumber: 7 }]);
  });

  it('job queued : passe cancelled et retire le label', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps, QUIET);
    await pollOnce(h.deps);
    const job = h.store.listByStates(['queued'])[0];

    const res = await daemon.cancelJob(job.id, 'cli');
    expect(res).toMatchObject({ ok: true, result: { id: job.id, state: 'cancelled' } });
    expect(h.source.labelsOf(ISSUE_7)).not.toContain('sisyphe');
    expect(h.actions.listRecent(1)[0]).toMatchObject({ action: 'cancel', source: 'cli', jobId: job.id, outcome: 'ok' });
  });

  it('refuse un job terminal ou inconnu, sans toucher au label, et journalise le refus', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps, QUIET);
    await pollOnce(h.deps);
    const job = h.store.listByStates(['queued'])[0];
    finishAs(h.store, job.id, 'done');

    expect(await daemon.cancelJob(job.id, 'ui')).toEqual({ ok: false, error: 'job déjà terminé (done)' });
    expect(await daemon.cancelJob('nope', 'ui')).toEqual({ ok: false, error: 'job inconnu : nope' });
    expect(h.source.calls).not.toContain('removeTriggerLabel');
    expect(h.actions.listRecent(10).map((a) => [a.action, a.jobId, a.outcome])).toEqual([
      ['cancel', 'nope', 'error'],
      ['cancel', job.id, 'error'],
    ]);
  });
});

describe('Daemon.retryJob', () => {
  it('crée un job queued sur la même issue et repose le label, sans doublon au poll suivant', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps, QUIET);
    await pollOnce(h.deps);
    const old = h.store.listByStates(['queued'])[0];
    await daemon.cancelJob(old.id, 'cli');
    expect(h.source.labelsOf(ISSUE_7)).not.toContain('sisyphe');

    const res = await daemon.retryJob(old.id, 'ui');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.id).not.toBe(old.id);
    expect(res.result).toMatchObject({ state: 'queued', repo: REPO, issueNumber: 7, issueTitle: old.issueTitle });
    expect(h.source.labelsOf(ISSUE_7)).toContain('sisyphe');
    expect(h.actions.listRecent(1)[0]).toMatchObject({ action: 'retry', source: 'ui', jobId: res.result.id, outcome: 'ok' });

    // Le label est posé par l'App (que canTrigger refuserait) : le poll doit s'arrêter au job actif existant.
    await pollOnce(h.deps);
    expect(h.store.listActive().map((j) => j.id)).toEqual([res.result.id]);
    expect(h.source.labelsOf(ISSUE_7)).toContain('sisyphe');
  });

  it('refuse si un job est déjà actif sur l’issue, ou si le job est done', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps, QUIET);
    await pollOnce(h.deps);
    const first = h.store.listByStates(['queued'])[0];
    h.store.transition(first.id, 'cancelled'); // label toujours présent : le poll recrée un job
    await pollOnce(h.deps);
    const second = h.store.listByStates(['queued'])[0];
    expect(second.id).not.toBe(first.id);

    const dup = await daemon.retryJob(first.id, 'ui');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain('déjà actif');

    finishAs(h.store, second.id, 'done');
    expect(await daemon.retryJob(second.id, 'ui')).toEqual({
      ok: false,
      error: 'job non relançable (done) : seuls failed, blocked et cancelled le sont',
    });
    expect(h.store.listRecent(10)).toHaveLength(2); // aucun job créé
    expect(h.source.calls).not.toContain('addTriggerLabel');
  });

  it('échec de la pose du label : nouveau job cancelled avec earlyStop, ok: false', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps, QUIET);
    await pollOnce(h.deps);
    const old = h.store.listByStates(['queued'])[0];
    await daemon.cancelJob(old.id, 'cli');
    h.source.addTriggerLabel = async () => {
      throw new Error('boom');
    };

    expect(await daemon.retryJob(old.id, 'ui')).toEqual({ ok: false, error: 'label impossible : boom' });
    const created = h.store.listRecent(1)[0];
    expect(created.id).not.toBe(old.id);
    expect(created.state).toBe('cancelled');
    expect(created.flags.earlyStop).toBe('label impossible : boom');
    expect(h.actions.listRecent(1)[0]).toMatchObject({ action: 'retry', jobId: created.id, outcome: 'error', error: 'label impossible : boom' });
  });
});

describe('Daemon.enqueueIssue', () => {
  it('crée un job queued sur une issue ouverte sans label, puis pose le label', async () => {
    const h = await makeHarness({ steps: [] });
    h.source.addIssue(repoRef, { number: 9, title: 'Sans label', labels: [] });
    const daemon = new Daemon(h.deps, QUIET);

    const res = await daemon.enqueueIssue({ repo: REPO, issueNumber: 9 }, 'ui');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result).toMatchObject({ state: 'queued', repo: REPO, issueNumber: 9, issueTitle: 'Sans label' });
    expect(h.source.labelsOf({ repo: repoRef, number: 9 })).toContain('sisyphe');
    expect(h.actions.listRecent(1)[0]).toMatchObject({
      action: 'enqueue', source: 'ui', jobId: res.result.id, repo: REPO, issueNumber: 9, outcome: 'ok',
    });
  });

  it('refuse un repo hors configuration, une issue inconnue, fermée, ou déjà suivie', async () => {
    const h = await makeHarness({ steps: [] });
    h.source.addIssue(repoRef, { number: 10, title: 'Fermée', labels: [], state: 'closed' });
    const daemon = new Daemon(h.deps, QUIET);
    await pollOnce(h.deps); // job actif sur #7

    expect(await daemon.enqueueIssue({ repo: 'acme/other', issueNumber: 1 }, 'ui')).toEqual({ ok: false, error: 'repo hors configuration : acme/other' });
    const missing = await daemon.enqueueIssue({ repo: REPO, issueNumber: 404 }, 'ui');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain('issue illisible');
    expect(await daemon.enqueueIssue({ repo: REPO, issueNumber: 10 }, 'ui')).toEqual({ ok: false, error: `issue fermée : ${REPO}#10` });
    const dup = await daemon.enqueueIssue({ repo: REPO, issueNumber: 7 }, 'cli');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain('déjà actif');

    expect(h.store.listRecent(10)).toHaveLength(1); // seul le job du poll existe
    expect(h.source.calls).not.toContain('addTriggerLabel');
    const rows = h.actions.listRecent(10);
    expect(rows.map((r) => [r.action, r.source, r.outcome])).toEqual([
      ['enqueue', 'cli', 'error'],
      ['enqueue', 'ui', 'error'],
      ['enqueue', 'ui', 'error'],
      ['enqueue', 'ui', 'error'],
    ]);
    expect(rows[0]).toMatchObject({ repo: REPO, issueNumber: 7, jobId: null });
  });

  it('watchCancellations lancé pendant enqueueIssue attend la pose du label : le job survit', async () => {
    const h = await makeHarness({ steps: [] });
    h.source.addIssue(repoRef, { number: 9, title: 'Sans label', labels: [] });
    const daemon = new Daemon(h.deps, QUIET);
    const g = gate();
    const real = h.source.addTriggerLabel.bind(h.source);
    h.source.addTriggerLabel = async (ref) => {
      await g.wait;
      await real(ref);
    };

    const enqueued = daemon.enqueueIssue({ repo: REPO, issueNumber: 9 }, 'ui');
    await waitFor(() => h.store.listByStates(['queued']).length === 1); // job créé, label pas encore posé
    const swept = daemon.watchCancellations(); // sans la porte, ce balayage annulerait le job (actif, sans label)
    g.release();
    await Promise.all([enqueued, swept]);

    expect(h.store.listByStates(['queued'])).toHaveLength(1);
    expect(h.source.labelsOf({ repo: repoRef, number: 9 })).toContain('sisyphe');
  });
});

/**
 * Période d'un minuteur Node, en millisecondes ; `-1` une fois le minuteur annulé. Champ interne, mais
 * c'est la seule façon de vérifier qu'un minuteur a bien été remplacé sans attendre qu'il se déclenche.
 */
const periodMs = (t: NodeJS.Timeout): number => (t as unknown as { _idleTimeout: number })._idleTimeout;

describe('Daemon.reload', () => {
  it('budget relevé à chaud : un job bloqué par le budget démarre au tick suivant', async () => {
    const h = await makeHarness({
      steps: [{ output: readyVerdict }, { output: report('a'), sideEffect: writeFeature('hello\n') }],
      dailyBudgetUsd: 1,
    });
    const daemon = new Daemon(h.deps, { ...QUIET, configPath: h.configPath });
    await pollOnce(h.deps);
    const job = h.store.listByStates(['queued'])[0];
    // Dépense du jour bien au-delà du plafond d'un dollar : plus rien ne démarre.
    const phase = h.phases.start({ jobId: job.id, name: 'triage', attempt: 1 });
    h.phases.finish(phase.id, { costUsd: 5, outcome: 'success' });

    await daemon.requestTick();
    expect(h.store.get(job.id)!.state).toBe('queued');

    await h.writeConfig({ dailyBudgetUsd: 100 });
    expect(await daemon.reload('ui')).toEqual({ ok: true, result: { applied: ['dailyBudgetUsd'], needsRestart: [] } });
    expect(h.deps.machine.dailyBudgetUsd).toBe(100);

    await daemon.requestTick();
    expect(h.store.get(job.id)!.state).toBe('triaging'); // le budget est relu à chaque décision : rien d'autre à faire
    await daemon.stop();

    expect(h.actions.listRecent(1)[0]).toMatchObject({ action: 'reload', source: 'ui', outcome: 'ok' });
  });

  it('plafond vidé sous `cli` : `null` et champ absent restent deux valeurs distinctes', async () => {
    // Sous `cli` les deux formes se résolvent toutes deux en « aucun plafond » : seule une comparaison sur la
    // valeur brute peut encore les distinguer. Sous `sdk`, l'absence vaut 60 et le test ne prouverait rien.
    const h = await makeHarness({ steps: [], agentBackend: 'cli', dailyBudgetUsd: 'absent' });
    const daemon = new Daemon(h.deps, { ...QUIET, configPath: h.configPath });
    expect(effectiveDailyBudget(h.deps.machine)).toBeUndefined();

    await h.writeConfig({ dailyBudgetUsd: null });
    expect(await daemon.reload('ui')).toEqual({ ok: true, result: { applied: ['dailyBudgetUsd'], needsRestart: [] } });
    expect(h.deps.machine.dailyBudgetUsd).toBeNull();
    expect(effectiveDailyBudget(h.deps.machine)).toBeUndefined(); // même résolution, valeur brute différente

    await h.writeConfig({ dailyBudgetUsd: 'absent' });
    expect(await daemon.reload('ui')).toEqual({ ok: true, result: { applied: ['dailyBudgetUsd'], needsRestart: [] } });
    expect(h.deps.machine.dailyBudgetUsd).toBeUndefined();
  });

  it('backend en attente de redémarrage : le budget n’est pas appliqué à chaud, la paire reste cohérente', async () => {
    // Vivant : {sdk, 40}. Fichier : {cli, budget absent}. Recopier le budget brut seul mettrait le daemon
    // sur le plafond que `sdk` applique à un champ absent — 60 — que ni la config vivante ni le fichier ne demandent.
    const h = await makeHarness({ steps: [], dailyBudgetUsd: 40 });
    const daemon = new Daemon(h.deps, { ...QUIET, configPath: h.configPath });
    await h.writeConfig({ agentBackend: 'cli', dailyBudgetUsd: 'absent' });

    expect(await daemon.reload('ui')).toEqual({ ok: true, result: { applied: [], needsRestart: ['agentBackend'] } });
    expect(h.deps.machine.dailyBudgetUsd).toBe(40);
    expect(h.deps.machine.agentBackend).toBe('sdk');
    expect(effectiveDailyBudget(h.deps.machine)).toBe(40); // le plafond réellement appliqué reste celui de la paire vivante
  });

  it('maxConcurrentJobs relevé à chaud : deux jobs démarrent là où un seul le pouvait', async () => {
    const h = await makeHarness({
      steps: [],
      issues: [
        { number: 7, title: 'Un' },
        { number: 8, title: 'Deux' },
      ],
    });
    const daemon = new Daemon(h.deps, { ...QUIET, configPath: h.configPath });
    // Un agent qui ne rend la main qu'à l'abort : sans lui le premier job se terminerait aussitôt et
    // libérerait sa place, si bien que le second démarrerait quelle que soit la concurrence autorisée.
    h.deps.agent = {
      async run(opts: { signal: AbortSignal }) {
        await new Promise<never>((_resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason as Error)));
      },
    } as never;
    await pollOnce(h.deps);
    expect(h.store.listByStates(['queued'])).toHaveLength(2);

    await daemon.requestTick();
    expect(h.store.listByStates(['queued'])).toHaveLength(1); // maxConcurrentJobs vaut 1 : le second attend

    await h.writeConfig({ maxConcurrentJobs: 2 });
    expect(await daemon.reload('cli')).toEqual({ ok: true, result: { applied: ['maxConcurrentJobs'], needsRestart: [] } });
    expect(h.deps.machine.maxConcurrentJobs).toBe(2);

    await daemon.requestTick();
    expect(h.store.listByStates(['queued'])).toHaveLength(0); // le premier occupe toujours sa place : c'est bien le plafond qui a cédé
    await daemon.stop();
  });

  it('champs structurels : tous nommés dans needsRestart, aucun appliqué à la configuration en cours', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps, { ...QUIET, configPath: h.configPath });
    await h.writeConfig({
      github: { appId: 2, installationId: 3, privateKeyPath: '/tmp/autre.pem' },
      repos: [REPO, 'acme/other'],
      triggerLabel: 'autre',
      sandbox: true,
      agentBackend: 'cli',
      dataDir: '/tmp/ailleurs',
    });

    // Les noms pointés sont le contrat avec la page de réglages, qui en fait un bandeau : ils sont figés ici.
    expect(await daemon.reload('cli')).toEqual({
      ok: true,
      result: {
        applied: [],
        needsRestart: [
          'github.appId', 'github.installationId', 'github.privateKeyPath',
          'repos', 'triggerLabel', 'sandbox', 'agentBackend', 'dataDir',
        ],
      },
    });
    expect(h.deps.machine).toMatchObject({
      github: { appId: 1, installationId: 1, privateKeyPath: '/dev/null' },
      repos: [REPO],
      triggerLabel: 'sisyphe',
      sandbox: false,
      agentBackend: 'sdk',
      dataDir: h.paths.root,
    });
    expect(h.actions.listRecent(1)[0]).toMatchObject({ action: 'reload', source: 'cli', outcome: 'ok' });
  });

  it('configuration inchangée : deux listes vides, et l’action est quand même journalisée', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps, { ...QUIET, configPath: h.configPath });

    expect(await daemon.reload('ui')).toEqual({ ok: true, result: { applied: [], needsRestart: [] } });
    expect(h.actions.listRecent(1)[0]).toMatchObject({ action: 'reload', source: 'ui', outcome: 'ok' });
  });

  it('configuration invalide : refus journalisé, et le daemon garde celle qu’il avait', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps, { ...QUIET, configPath: h.configPath });

    await writeFile(h.configPath, 'github: [\n');
    const unreadable = await daemon.reload('ui');
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) expect(unreadable.error).toContain('YAML illisible');

    await writeFile(h.configPath, 'github:\n  appId: zéro\nrepos: []\n');
    const invalid = await daemon.reload('ui');
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toContain('config.yml invalide');

    expect(h.deps.machine.repos).toEqual([REPO]);
    expect(h.deps.machine.dailyBudgetUsd).toBe(60);
    expect(h.deps.machine.github.appId).toBe(1);
    expect(h.actions.listRecent(2).map((a) => [a.action, a.outcome])).toEqual([
      ['reload', 'error'],
      ['reload', 'error'],
    ]);
  });

  it('pollIntervalSeconds : le minuteur de poll est remplacé à sa place, les autres sont intacts', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    // Aucun intervalle de poll imposé : c'est la configuration qui le fixe, comme en production.
    const daemon = new Daemon(h.deps, {
      intervals: { cancelMs: 3_600_000, prTrackMs: 3_600_000, purgeMs: 3_600_000 },
      control: false,
      configPath: h.configPath,
    });
    const internals = daemon as unknown as { timers: NodeJS.Timeout[]; pollTimer: NodeJS.Timeout | null };
    const started = daemon.start();
    await waitFor(() => internals.pollTimer !== null);
    const before = internals.pollTimer!;
    expect(periodMs(before)).toBe(60_000); // défaut du schéma
    const others = internals.timers.filter((t) => t !== before);

    await h.writeConfig({ pollIntervalSeconds: 600 });
    expect(await daemon.reload('ui')).toEqual({ ok: true, result: { applied: ['pollIntervalSeconds'], needsRestart: [] } });

    expect(h.deps.machine.pollIntervalSeconds).toBe(600);
    expect(internals.pollTimer).not.toBe(before);
    expect(periodMs(internals.pollTimer!)).toBe(600_000);
    expect(periodMs(before)).toBe(-1); // l'ancien minuteur est annulé, il ne se déclenchera plus
    expect(internals.timers).toContain(internals.pollTimer); // dans la liste, donc annulé par stop()
    expect(internals.timers).not.toContain(before);
    expect(internals.timers.filter((t) => t !== internals.pollTimer)).toEqual(others);

    await daemon.stop();
    await started;
  });

  it('un intervalle de poll imposé par les options prime sur celui du fichier', async () => {
    const h = await makeHarness({ steps: [], issues: [] });
    const daemon = new Daemon(h.deps, { ...QUIET, configPath: h.configPath });
    const internals = daemon as unknown as { pollTimer: NodeJS.Timeout | null };
    const started = daemon.start();
    await waitFor(() => internals.pollTimer !== null);
    const before = internals.pollTimer!;

    await h.writeConfig({ pollIntervalSeconds: 600 });
    expect(await daemon.reload('ui')).toEqual({ ok: true, result: { applied: ['pollIntervalSeconds'], needsRestart: [] } });

    expect(h.deps.machine.pollIntervalSeconds).toBe(600); // la valeur est bien appliquée
    expect(internals.pollTimer).toBe(before); // mais le minuteur n'est pas reprogrammé
    expect(periodMs(before)).toBe(3_600_000);

    await daemon.stop();
    await started;
  });
});
