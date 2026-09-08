import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('conserve startedAt lors d’un requeue', () => {
    const { jobs } = setup();
    const job = jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    const started = jobs.transition(job.id, 'triaging').startedAt;
    expect(started).not.toBeNull();
    jobs.transition(job.id, 'queued', { requeues: 1 });
    expect(jobs.transition(job.id, 'triaging').startedAt).toBe(started);
  });

  it('nextQueued et listRecent restent ordonnés à created_at égal', () => {
    const { db, jobs } = setup();
    const j1 = jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    const j2 = jobs.create({ repo: 'a/b', issueNumber: 2, issueTitle: 't' });
    db.prepare('UPDATE jobs SET created_at = ?').run('2026-09-08T00:00:00.000Z');
    expect(jobs.nextQueued()?.id).toBe(j1.id);
    expect(jobs.listRecent(2).map((j) => j.id)).toEqual([j2.id, j1.id]);
  });

  it('update : patch vide sans écriture, undefined explicite écrit NULL', () => {
    const { jobs } = setup();
    const job = jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    const before = jobs.update(job.id, { branch: 'feature/x' });
    expect(jobs.update(job.id, {}).updatedAt).toBe(before.updatedAt);
    expect(jobs.update(job.id, { branch: undefined }).branch).toBeNull();
  });

  it('listSince filtre par date et par repo', () => {
    const { db, jobs } = setup();
    const old = jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', old.id);
    const recent = jobs.create({ repo: 'c/d', issueNumber: 2, issueTitle: 't' });
    expect(jobs.listSince('2026-01-01T00:00:00.000Z').map((j) => j.id)).toEqual([recent.id]);
    expect(jobs.listSince('2000-01-01T00:00:00.000Z', 'a/b').map((j) => j.id)).toEqual([old.id]);
  });

  it('listWithOpenPr se base sur la fin du job, pas sur sa création', () => {
    const { db, jobs } = setup();
    const j = jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    for (const s of ['triaging', 'implementing', 'verifying', 'delivering'] as const) jobs.transition(j.id, s);
    jobs.transition(j.id, 'done', { prNumber: 5, prUrl: 'u', prState: 'open' });
    db.prepare('UPDATE jobs SET created_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', j.id);
    expect(jobs.listWithOpenPr(30)).toHaveLength(1);
  });

  it('refuse un second job actif pour la même issue, mais pas après un job terminé', () => {
    const { jobs } = setup();
    const j = jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    expect(() => jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' })).toThrow(/UNIQUE/);
    jobs.transition(j.id, 'cancelled');
    expect(() => jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' })).not.toThrow();
  });

  it('refuse un état hors énumération au niveau SQL', () => {
    const { db, jobs } = setup();
    const j = jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    expect(() => db.prepare('UPDATE jobs SET state = ? WHERE id = ?').run('bogus', j.id)).toThrow(/CHECK/);
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

  it('costSince inclut la borne et exclut les phases en cours', () => {
    const { jobs, phases } = setup();
    const job = jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    const p = phases.start({ jobId: job.id, name: 'triage', attempt: 1 });
    phases.finish(p.id, { costUsd: 1, outcome: 'success' });
    const finishedAt = phases.get(p.id).finishedAt!;
    phases.start({ jobId: job.id, name: 'implement', attempt: 1 });
    expect(phases.costSince(finishedAt)).toBeCloseTo(1);
    expect(phases.costSince(new Date(Date.parse(finishedAt) + 1).toISOString())).toBe(0);
  });
});

describe('openDatabase', () => {
  it('persiste sur fichier, active WAL et ne rejoue pas la migration', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-db-'));
    const file = join(dir, 'sisyphe.db');
    const a = openDatabase(file);
    new JobStore(a).create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    a.close();
    const b = openDatabase(file);
    expect(new JobStore(b).listActive()).toHaveLength(1);
    expect((b.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
    expect((b.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    b.close();
    await rm(dir, { recursive: true, force: true });
  });
});
