import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../jobs/state.js';
import { ACTION_OUTCOMES, ACTION_SOURCES, ActionStore } from './actions.js';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, applyMigrations, openDatabase, sqlList } from './db.js';
import { JobStore } from './jobs.js';
import { PhaseStore } from './phases.js';
import { PHASE_NAMES } from './types.js';
import { JOB_STATES, TERMINAL_STATES } from './types.js';

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
    const verdict = {
      verdict: 'ready' as const, confidence: 1, summary: 's', note: '', change_type: 'fix' as const, plan: ['p'], files_likely_touched: [], questions: [], reasons: [],
      verification: { steps: ['build', 'test', 'lint'] as ('build' | 'test' | 'lint')[], why: 'périmètre complet' },
    };
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

  it('accepte chaque nom de PHASE_NAMES et refuse les autres', () => {
    const { db, jobs, phases } = setup();
    const job = jobs.create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    for (const name of PHASE_NAMES) expect(phases.start({ jobId: job.id, name, attempt: 1 }).name).toBe(name);
    expect(() =>
      db.prepare('INSERT INTO phases (job_id, name, attempt, started_at) VALUES (?, ?, ?, ?)').run(job.id, 'bogus', 1, 'now'),
    ).toThrow(/CHECK/);
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
    expect((b.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect((b.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    b.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('migre une base existante en version 1 jusqu’à la dernière sans toucher aux jobs/phases', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-db-'));
    const file = join(dir, 'sisyphe.db');
    // Fabrique une base v1 authentique : ouvre en v2, puis redescend artificiellement à v1
    // en supprimant ce que la migration 2 a ajouté.
    const a = openDatabase(file);
    const job = new JobStore(a).create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    const phase = new PhaseStore(a).start({ jobId: job.id, name: 'triage', attempt: 1 });
    a.exec('DROP TABLE actions');
    a.exec('PRAGMA user_version = 1');
    a.close();

    const b = openDatabase(file);
    expect((b.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(new JobStore(b).get(job.id)?.issueTitle).toBe('t');
    expect(new PhaseStore(b).listForJob(job.id).map((p) => p.id)).toEqual([phase.id]);
    // La table `phases` a été reconstruite : la phase `jira`, refusée par le CHECK d'origine, passe.
    expect(new PhaseStore(b).start({ jobId: job.id, name: 'jira', attempt: 1 }).name).toBe('jira');
    expect(b.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'actions'").get()).toBeTruthy();
    expect(new ActionStore(b).record({ action: 'retry', source: 'ui', outcome: 'ok' }).outcome).toBe('ok');
    b.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('deux migrateurs concurrents sur la même base : le second ne rejoue rien et les deux finissent à jour', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-db-'));
    const file = join(dir, 'sisyphe.db');
    const seed = openDatabase(file);
    seed.exec('DROP TABLE actions');
    seed.exec('PRAGMA user_version = 1'); // base v1, comme avant la migration 2
    seed.close();

    // Le gagnant migre. Le perdant a lu `user_version` avant lui : il repart donc du plan périmé « v1 »,
    // exactement ce que fait un second processus (daemon, `sisyphe ui`, `sisyphe setup`) parti en même temps.
    const winner = openDatabase(file);
    const loser = new DatabaseSync(file);
    loser.exec('PRAGMA busy_timeout = 5000;');
    applyMigrations(loser, 1);

    const version = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    expect(version(winner)).toBe(SCHEMA_VERSION);
    expect(version(loser)).toBe(SCHEMA_VERSION);
    // Une seule table `actions` : la migration n'a pas été rejouée par-dessus elle-même.
    expect(new ActionStore(loser).record({ action: 'retry', source: 'ui', outcome: 'ok' }).outcome).toBe('ok');
    winner.close();
    loser.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('fige le littéral des énumérations SQL : le changer exige une nouvelle migration', () => {
    expect(sqlList(JOB_STATES)).toBe("'queued','triaging','implementing','verifying','delivering','done','blocked','failed','cancelled'");
    expect(sqlList(TERMINAL_STATES)).toBe("'done','blocked','failed','cancelled'");
    expect(sqlList(ACTION_SOURCES)).toBe("'ui','cli'");
    expect(sqlList(ACTION_OUTCOMES)).toBe("'ok','error'");
  });
});

describe('requêtes de lecture de JobStore', () => {
  function seed() {
    const { jobs, db } = setup();
    const mk = (repo: string, issueNumber: number, state: string, createdAt: string) => {
      const job = jobs.create({ repo, issueNumber, issueTitle: `t${issueNumber}` });
      db.prepare('UPDATE jobs SET state = ?, created_at = ? WHERE id = ?').run(state, createdAt, job.id);
      return job.id;
    };
    return {
      jobs,
      a: mk('acme/one', 1, 'done', '2026-09-01T10:00:00.000Z'),
      b: mk('acme/two', 2, 'done', '2026-09-02T10:00:00.000Z'),
      c: mk('acme/one', 3, 'failed', '2026-09-03T10:00:00.000Z'),
      d: mk('acme/one', 4, 'implementing', '2026-09-04T10:00:00.000Z'),
    };
  }

  it('countByState compte tous les états, zéros compris', () => {
    const { jobs } = seed();

    const counts = jobs.countByState();

    expect(counts.done).toBe(2);
    expect(counts.failed).toBe(1);
    expect(counts.implementing).toBe(1);
    expect(counts.queued).toBe(0);
    expect(Object.keys(counts).sort()).toEqual([...JOB_STATES].sort());
  });

  it('listFiltered filtre en SQL et trie du plus récent au plus ancien', () => {
    const s = seed();

    expect(s.jobs.listFiltered({ limit: 100 }).map((j) => j.id)).toEqual([s.d, s.c, s.b, s.a]);
    expect(s.jobs.listFiltered({ state: 'done', limit: 100 }).map((j) => j.id)).toEqual([s.b, s.a]);
    expect(s.jobs.listFiltered({ repo: 'acme/one', limit: 100 }).map((j) => j.id)).toEqual([s.d, s.c, s.a]);
    expect(s.jobs.listFiltered({ state: 'done', repo: 'acme/one', limit: 100 }).map((j) => j.id)).toEqual([s.a]);
  });

  it('listFiltered applique la limite après le filtre, jamais avant', () => {
    const s = seed();

    // Une limite de 1 sans filtre rendrait `d` (implementing) : le filtre doit être en SQL, pas en mémoire.
    expect(s.jobs.listFiltered({ state: 'done', limit: 1 }).map((j) => j.id)).toEqual([s.b]);
  });
});
