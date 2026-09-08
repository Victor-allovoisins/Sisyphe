import { describe, expect, it } from 'vitest';
import { Daemon } from '../../src/daemon/daemon.js';
import { makeHarness, readyVerdict, repoRef, report, writeFeature } from '../helpers/harness.js';

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
});
