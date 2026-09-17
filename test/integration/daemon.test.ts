import { describe, expect, it } from 'vitest';
import { effectiveDailyBudget } from '../../src/config/machine.js';
import { Daemon } from '../../src/daemon/daemon.js';
import { pollOnce } from '../../src/daemon/poll.js';
import { SHUTDOWN } from '../../src/jobs/pipeline.js';
import { startOfLocalDay } from '../../src/jobs/scheduler.js';
import { isTerminal } from '../../src/store/types.js';
import { REPO, makeHarness, readyVerdict, repoRef, report, writeFeature } from '../helpers/harness.js';

/** Timers à l'heure : seuls les appels explicites font avancer le daemon. Pas de socket : elle a ses propres tests. */
const QUIET = { intervals: { pollMs: 3_600_000, cancelMs: 3_600_000, prTrackMs: 3_600_000, purgeMs: 3_600_000 }, control: false };

describe('Daemon', () => {
  it('runOnce traite toute la file dans l’ordre', async () => {
    const h = await makeHarness({
      steps: [
        { output: readyVerdict }, { output: report('a'), sideEffect: writeFeature('hello\n') },
        { output: readyVerdict }, { output: report('b'), sideEffect: writeFeature('hello\n') },
      ],
      issues: [{ number: 7, title: 'Ajouter feature hello' }, { number: 8, title: 'Encore hello' }],
    });
    await new Daemon(h.deps).runOnce();
    expect(h.source.pulls.map((p) => p.title)).toEqual(['[#7] Ajouter feature hello', '[#8] Encore hello']);
    expect(h.store.listActive()).toHaveLength(0);
    expect(h.source.labelsEnsured).toEqual(['acme/demo']);
  });

  it('respecte le budget quotidien et prévient les issues en attente', async () => {
    const h = await makeHarness({
      steps: [{ output: readyVerdict }, { output: report('a'), sideEffect: writeFeature('hello\n') }],
      issues: [{ number: 7, title: 'A' }, { number: 8, title: 'B' }],
      dailyBudgetUsd: 0.5,
    });
    await new Daemon(h.deps).runOnce();
    expect(h.source.pulls).toHaveLength(1);
    const queued = h.store.listByStates(['queued']);
    expect(queued.map((j) => j.issueNumber)).toEqual([8]);
    expect(h.source.commentsOf({ repo: repoRef, number: 8 }).at(-1)).toContain('Budget quotidien');
  });

  it('sans plafond, aucune pause budgétaire : le job démarre malgré une dépense élevée', async () => {
    // Plafond vidé (`dailyBudgetUsd: null`) sur un backend `sdk` : ce que l'absence du champ ne peut pas dire.
    const h = await makeHarness({
      steps: [{ output: readyVerdict }, { output: report('a'), sideEffect: writeFeature('hello\n') }],
      dailyBudgetUsd: null,
    });
    expect(effectiveDailyBudget(h.deps.machine)).toBeUndefined();

    // Dépense du jour très supérieure à n'importe quel plafond plausible, portée par un job déjà terminé.
    const spent = h.store.create({ repo: REPO, issueNumber: 99, issueTitle: 'dépense du jour' });
    h.store.transition(spent.id, 'failed');
    const phase = h.phases.start({ jobId: spent.id, name: 'triage', attempt: 1 });
    h.phases.finish(phase.id, { costUsd: 5000, outcome: 'success' });
    expect(h.phases.costSince(startOfLocalDay())).toBeGreaterThan(1000);

    await new Daemon(h.deps).runOnce();

    expect(h.source.pulls).toHaveLength(1);
    expect(h.store.listByStates(['queued'])).toHaveLength(0);
    expect(h.source.commentsOf({ repo: repoRef, number: 7 }).filter((c) => /budget/i.test(c))).toEqual([]);
  });

  it('watchCancellations annule un job dont le label a disparu', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps);
    const fakeAgent = {
      calls: 0,
      async run() {
        // 1er appel : triage. 2e appel : l'humain retire le label pendant l'implémentation.
        this.calls++;
        if (this.calls === 2) {
          await h.source.removeTriggerLabel({ repo: repoRef, number: 7 });
          await daemon.watchCancellations();
        }
        return {
          output: this.calls === 1 ? readyVerdict : report('x'), sessionId: 's', costUsd: 0.1,
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
          numTurns: 1, durationMs: 1, stopReason: 'completed' as const, transcriptPath: '',
        };
      },
    };
    h.deps.agent = fakeAgent as never;
    await daemon.runOnce();
    const job = h.store.listRecent(1)[0];
    expect(job.state).toBe('cancelled');
  });

  it('trackPullRequests enregistre le merge', async () => {
    const h = await makeHarness({ steps: [{ output: readyVerdict }, { output: report('a'), sideEffect: writeFeature('hello\n') }] });
    const daemon = new Daemon(h.deps);
    await daemon.runOnce();
    const pr = h.source.pulls[0];
    pr.state = 'closed';
    pr.mergedAt = '2026-09-09T08:00:00Z';
    await daemon.trackPullRequests();
    const job = h.store.listRecent(1)[0];
    expect(job.prState).toBe('closed');
    expect(job.prMergedAt).toBe('2026-09-09T08:00:00Z');
  });

  it('stop() pendant le prologue de start() ne bloque pas', async () => {
    const h = await makeHarness({ steps: [] });
    const realEnsureLabels = h.source.ensureLabels.bind(h.source);
    h.source.ensureLabels = async (repo) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await realEnsureLabels(repo);
    };
    const daemon = new Daemon(h.deps, { control: false });
    const started = daemon.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await daemon.stop();
    await Promise.race([
      started,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("start() ne s'est pas résolu après stop()")), 2000)),
    ]);
  });

  it('stop() pendant un job laisse le job non terminal et résout start()', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps, QUIET);
    let observedReason: unknown;
    // Le job passe en 'triaging' de façon synchrone bien avant d'atteindre l'agent (mkdir, git, worktree...) :
    // attendre l'état en base serait racy. On attend plutôt que l'agent factice soit réellement entré dans run().
    let agentStarted: () => void = () => undefined;
    const agentEntered = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    const fakeAgent = {
      async run(opts: { signal: AbortSignal }) {
        agentStarted();
        await new Promise<never>((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            observedReason = opts.signal.reason;
            reject(opts.signal.reason as Error);
          });
        });
      },
    };
    h.deps.agent = fakeAgent as never;

    const started = daemon.start();
    await Promise.race([
      agentEntered,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("l'agent n'a jamais démarré")), 2000)),
    ]);
    const s1 = daemon.stop();
    expect(daemon.stop()).toBe(s1);
    await s1;
    await started;

    const job = h.store.listRecent(1)[0];
    expect(isTerminal(job.state)).toBe(false);
    expect(observedReason).toBe(SHUTDOWN);
    expect(h.source.labelsOf({ repo: repoRef, number: job.issueNumber })).not.toContain('sisyphe:done');
  });

  it('stop() abandonne un job bloqué après stopGraceMs plutôt que de pendre', async () => {
    const h = await makeHarness({ steps: [] });
    const daemon = new Daemon(h.deps, { ...QUIET, stopGraceMs: 50 });
    let agentStarted: () => void = () => undefined;
    const agentEntered = new Promise<void>((resolve) => {
      agentStarted = resolve;
    });
    const fakeAgent = {
      // Ne résout jamais et ignore le signal d'abandon (ex. bloqué dans un sleep de rate limit d'une heure).
      async run() {
        agentStarted();
        await new Promise<never>(() => undefined);
      },
    };
    h.deps.agent = fakeAgent as never;

    const started = daemon.start();
    await Promise.race([
      agentEntered,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("l'agent n'a jamais démarré")), 2000)),
    ]);

    await Promise.race([
      daemon.stop(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("stop() ne s'est pas résolu après stopGraceMs")), 2000)),
    ]);
    await started;

    const job = h.store.listRecent(1)[0];
    expect(isTerminal(job.state)).toBe(false);
  });

  it('budget : un seul commentaire de pause par issue et par jour', async () => {
    const h = await makeHarness({
      steps: [{ output: readyVerdict }, { output: report('a'), sideEffect: writeFeature('hello\n') }],
      issues: [{ number: 7, title: 'A' }, { number: 8, title: 'B' }],
      dailyBudgetUsd: 0.5,
    });
    const daemon = new Daemon(h.deps);
    await daemon.runOnce();

    // Épingle la clé par issue plutôt que par job : on annule le job en attente puis on en recrée un
    // nouveau (id différent) sur la même issue ; le budget étant toujours dépassé, un seul commentaire doit sortir.
    const queuedBefore = h.store.listByStates(['queued']);
    expect(queuedBefore.map((j) => j.issueNumber)).toEqual([8]);
    h.store.transition(queuedBefore[0].id, 'cancelled');
    await pollOnce(h.deps);
    const queuedAfter = h.store.listByStates(['queued']);
    expect(queuedAfter.map((j) => j.issueNumber)).toEqual([8]);
    expect(queuedAfter[0].id).not.toBe(queuedBefore[0].id);

    await daemon.runOnce();
    const comments = h.source.commentsOf({ repo: repoRef, number: 8 }).filter((c) => c.toLowerCase().includes('budget'));
    expect(comments).toHaveLength(1);
  });

  it('un job queued dont le label a été retiré est annulé sans PR', async () => {
    const h = await makeHarness({ steps: [] });
    const ref = { repo: repoRef, number: 7 };
    await pollOnce(h.deps);
    await h.source.removeTriggerLabel(ref);
    await new Daemon(h.deps).runOnce();
    const job = h.store.listRecent(1)[0];
    expect(job.state).toBe('cancelled');
    expect(h.source.pulls).toHaveLength(0);
    expect(h.source.labelsOf(ref).some((l) => l.startsWith('sisyphe:'))).toBe(false);
  });

  it('watchCancellations n’annule pas un job passé triaging pendant l’attente réseau (course avec le poll)', async () => {
    const h = await makeHarness({ steps: [] });
    await pollOnce(h.deps);
    const queued = h.store.listByStates(['queued'])[0];
    expect(queued).toBeTruthy();

    let resolveActive: (v: boolean) => void = () => undefined;
    const pending = new Promise<boolean>((resolve) => {
      resolveActive = resolve;
    });
    h.source.isStillActive = async () => pending;

    const daemon = new Daemon(h.deps);
    const swept = daemon.watchCancellations();
    // Pendant que la vérification réseau (isStillActive) est encore en vol, le timer de poll a démarré le job.
    h.store.transition(queued.id, 'triaging');
    resolveActive(false);
    await expect(swept).resolves.toBeUndefined();

    const job = h.store.get(queued.id)!;
    expect(job.state).toBe('triaging');
  });

  it('start() balaie les annulations avant le premier tick : un job queued sans label n’est jamais démarré', async () => {
    const h = await makeHarness({ steps: [] });
    const ref = { repo: repoRef, number: 7 };
    await pollOnce(h.deps);
    await h.source.removeTriggerLabel(ref);
    const daemon = new Daemon(h.deps, QUIET);
    const started = daemon.start();
    const deadline = Date.now() + 2000;
    let job = h.store.listRecent(1)[0];
    while (!isTerminal(job.state) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      job = h.store.listRecent(1)[0];
    }
    await daemon.stop();
    await started;

    expect(job.state).toBe('cancelled');
    expect(h.source.pulls).toHaveLength(0);
    expect(h.agent.calls).toHaveLength(0); // l'agent scripté n'a jamais été appelé (aucun triage, aucune implémentation)
  });

  it('startNext() ne démarre aucun job pendant qu’une purge est en cours', async () => {
    const h = await makeHarness({
      steps: [{ output: readyVerdict }, { output: report('a'), sideEffect: writeFeature('hello\n') }],
    });
    await pollOnce(h.deps);
    expect(h.store.listByStates(['queued'])).toHaveLength(1);

    const daemon = new Daemon(h.deps) as unknown as { purging: boolean; startNext(): Promise<unknown> | null };
    daemon.purging = true;
    expect(daemon.startNext()).toBeNull();
    expect(h.store.listByStates(['queued'])).toHaveLength(1); // toujours en file, rien n'a démarré

    daemon.purging = false;
    const p = daemon.startNext();
    expect(p).not.toBeNull();
    await p;
    expect(h.store.listByStates(['queued'])).toHaveLength(0);
  });

  it('doTick() ne reprend pas le job qu’il vient de démarrer, même avec deux emplacements libres', async () => {
    const h = await makeHarness({
      steps: [{ output: readyVerdict }, { output: report('a'), sideEffect: writeFeature('hello\n') }],
      maxConcurrentJobs: 2,
    });
    // La concurrence doit venir de la config lue : à 1, `canStartJob` refuserait le second tour et ce test
    // passerait sur du code cassé.
    expect(h.deps.machine.maxConcurrentJobs).toBe(2);
    await pollOnce(h.deps);
    expect(h.store.listByStates(['queued'])).toHaveLength(1);

    // `while (startNext())` est une boucle synchrone : un job qui n'a pas quitté `queued` avant le premier
    // `await` de `runJob` se représente à chaque tour, et la boucle ne rend jamais la main. Le garde-fou la
    // borne pour que la régression se lise sur `repris`, et non sur un timeout de soixante secondes.
    const repris: string[] = [];
    const nextQueued = h.store.nextQueued.bind(h.store);
    h.store.nextQueued = () => {
      const job = nextQueued();
      if (job) repris.push(job.id);
      return repris.length > 5 ? null : job;
    };

    const daemon = new Daemon(h.deps, QUIET);
    await (daemon as unknown as { doTick(): Promise<void> }).doTick();
    expect(repris).toHaveLength(1);
    await daemon.stop();
  });
});
