import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../jobs/state.js';
import { openDatabase } from './db.js';
import { JobStore } from './jobs.js';
import { PhaseStore } from './phases.js';

function setup() {
  const db = openDatabase(':memory:');
  return { db, jobs: new JobStore(db), phases: new PhaseStore(db) };
}

describe('JobStore', () => {
  it('crée un job queued avec des flags vides', () => {
    const { jobs } = setup();
    const job = jobs.create({ repo: 'a/b', issueNumber: 7, issueTitle: 'Titre' });
    expect(job.state).toBe('queued');
    expect(job.attempt).toBe(0);
    expect(job.requeues).toBe(0);
    expect(job.flags).toEqual({ verificationFailed: false, protectedPathsTouched: [], largeDiff: false, secretsFound: [], earlyStop: null });
    expect(jobs.get(job.id)?.issueTitle).toBe('Titre');
  });

  it('applique et refuse les transitions', () => {
    const { jobs } = setup();
    const job = jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    const t = jobs.transition(job.id, 'triaging');
    expect(t.state).toBe('triaging');
    expect(t.startedAt).not.toBeNull();
    expect(() => jobs.transition(job.id, 'done')).toThrow(InvalidTransitionError);
    const b = jobs.transition(job.id, 'blocked', { error: 'questions' });
    expect(b.finishedAt).not.toBeNull();
    expect(b.error).toBe('questions');
  });

  it('sérialise les colonnes JSON', () => {
    const { jobs } = setup();
    const job = jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    const verdict = { verdict: 'ready' as const, confidence: 1, summary: 's', change_type: 'fix' as const, plan: ['p'], files_likely_touched: [], questions: [], reasons: [] };
    const u = jobs.update(job.id, { verdict, flags: { ...job.flags, largeDiff: true }, branch: 'feature/x' });
    expect(u.verdict?.plan).toEqual(['p']);
    expect(u.flags.largeDiff).toBe(true);
    expect(u.branch).toBe('feature/x');
  });

  it('retrouve le job actif d’une issue et le plus ancien queued', () => {
    const { jobs } = setup();
    const j1 = jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    const j2 = jobs.create({ repo: 'a/b', issueNumber: 2, issueTitle: 't' });
    expect(jobs.nextQueued()?.id).toBe(j1.id);
    expect(jobs.findActiveByIssue('a/b', 2)?.id).toBe(j2.id);
    jobs.transition(j1.id, 'cancelled');
    expect(jobs.findActiveByIssue('a/b', 1)).toBeNull();
    expect(jobs.nextQueued()?.id).toBe(j2.id);
    expect(jobs.listActive().map((j) => j.id)).toEqual([j2.id]);
    expect(jobs.listByStates(['cancelled']).map((j) => j.id)).toEqual([j1.id]);
  });

  it('liste les jobs avec PR ouverte', () => {
    const { jobs } = setup();
    const j = jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    jobs.update(j.id, { prNumber: 12, prUrl: 'u' });
    expect(jobs.listWithOpenPr(30)).toHaveLength(1);
    jobs.update(j.id, { prState: 'closed', prMergedAt: '2026-09-08T00:00:00Z' });
    expect(jobs.listWithOpenPr(30)).toHaveLength(0);
  });
});

describe('PhaseStore', () => {
  it('enregistre une phase et cumule les coûts', () => {
    const { jobs, phases } = setup();
    const job = jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    const p = phases.start({ jobId: job.id, name: 'triage', attempt: 1, model: 'claude-sonnet-5' });
    expect(p.outcome).toBeNull();
    const f = phases.finish(p.id, {
      sessionId: 's1', costUsd: 0.42, numTurns: 5, stopReason: 'completed', outcome: 'success',
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 0 },
    });
    expect(f.costUsd).toBe(0.42);
    expect(f.cacheReadTokens).toBe(30);
    expect(phases.listForJob(job.id)).toHaveLength(1);
    expect(phases.costSince('2000-01-01T00:00:00Z')).toBeCloseTo(0.42);
    expect(phases.costSince('2999-01-01T00:00:00Z')).toBe(0);
  });
});
