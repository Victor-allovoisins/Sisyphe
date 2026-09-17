import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { assertTransition } from '../jobs/state.js';
import { nowIso, sqlList } from './db.js';
import { JOB_STATES, TERMINAL_STATES, emptyFlags, isTerminal, parseFlags, type Job, type JobState } from './types.js';

type Row = Record<string, unknown>;

const TERMINAL_LIST = sqlList(TERMINAL_STATES);

function rowToJob(r: Row): Job {
  return {
    id: r.id as string,
    repo: r.repo as string,
    issueNumber: r.issue_number as number,
    issueTitle: r.issue_title as string,
    issueKey: (r.issue_key as string | null) ?? null,
    state: r.state as JobState,
    attempt: r.attempt as number,
    requeues: r.requeues as number,
    branch: (r.branch as string | null) ?? null,
    baseSha: (r.base_sha as string | null) ?? null,
    worktreePath: (r.worktree_path as string | null) ?? null,
    verdict: r.verdict_json ? JSON.parse(r.verdict_json as string) : null,
    report: r.report_json ? JSON.parse(r.report_json as string) : null,
    flags: parseFlags(r.flags_json as string),
    prNumber: (r.pr_number as number | null) ?? null,
    prUrl: (r.pr_url as string | null) ?? null,
    prState: (r.pr_state as 'open' | 'closed' | null) ?? null,
    prMergedAt: (r.pr_merged_at as string | null) ?? null,
    costUsd: r.cost_usd as number,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    durationMs: r.duration_ms as number,
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
    updatedAt: r.updated_at as string,
  };
}

export type JobPatch = Partial<Omit<Job, 'id' | 'createdAt' | 'updatedAt' | 'state'>>;

const COLUMNS: Record<keyof JobPatch, string> = {
  repo: 'repo', issueNumber: 'issue_number', issueTitle: 'issue_title', issueKey: 'issue_key', attempt: 'attempt', requeues: 'requeues',
  branch: 'branch', baseSha: 'base_sha', worktreePath: 'worktree_path',
  verdict: 'verdict_json', report: 'report_json', flags: 'flags_json',
  prNumber: 'pr_number', prUrl: 'pr_url', prState: 'pr_state', prMergedAt: 'pr_merged_at',
  costUsd: 'cost_usd', inputTokens: 'input_tokens', outputTokens: 'output_tokens', cacheReadTokens: 'cache_read_tokens',
  durationMs: 'duration_ms', error: 'error', startedAt: 'started_at', finishedAt: 'finished_at',
};
const JSON_KEYS = new Set<keyof JobPatch>(['verdict', 'report', 'flags']);

export class JobStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: { repo: string; issueNumber: number; issueTitle: string; issueKey?: string | null }): Job {
    const id = randomUUID();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO jobs (id, repo, issue_number, issue_title, issue_key, state, flags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(id, input.repo, input.issueNumber, input.issueTitle, input.issueKey ?? null, JSON.stringify(emptyFlags()), ts, ts);
    return this.must(id);
  }

  get(id: string): Job | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToJob(r) : null;
  }

  findActiveByIssue(repo: string, issueNumber: number): Job | null {
    const r = this.db
      .prepare(`SELECT * FROM jobs WHERE repo = ? AND issue_number = ? AND state NOT IN (${TERMINAL_LIST}) ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(repo, issueNumber) as Row | undefined;
    return r ? rowToJob(r) : null;
  }

  listActive(): Job[] {
    return (this.db.prepare(`SELECT * FROM jobs WHERE state NOT IN (${TERMINAL_LIST}) ORDER BY created_at ASC, rowid ASC`).all() as Row[]).map(rowToJob);
  }

  listByStates(states: JobState[]): Job[] {
    if (states.length === 0) return [];
    const marks = states.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM jobs WHERE state IN (${marks}) ORDER BY created_at ASC, rowid ASC`).all(...states) as Row[]).map(rowToJob);
  }

  listRecent(limit: number): Job[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Row[]).map(rowToJob);
  }

  /** Nombre de jobs par état, tous les états présents (zéro compris) : compteurs de l'UI sans charger les lignes. */
  countByState(): Record<JobState, number> {
    const counts = Object.fromEntries(JOB_STATES.map((s) => [s, 0])) as Record<JobState, number>;
    for (const r of this.db.prepare('SELECT state, COUNT(*) AS c FROM jobs GROUP BY state').all() as Row[]) {
      counts[r.state as JobState] = r.c as number;
    }
    return counts;
  }

  /** Liste filtrée du plus récent au plus ancien. Le filtrage est fait en SQL : une limite basse ne doit pas amputer le filtre. */
  listFiltered(o: { state?: JobState; repo?: string; limit: number }): Job[] {
    const where: string[] = [];
    const values: (string | number)[] = [];
    if (o.state) {
      where.push('state = ?');
      values.push(o.state);
    }
    if (o.repo) {
      where.push('repo = ?');
      values.push(o.repo);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT * FROM jobs ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...values, o.limit) as Row[]).map(rowToJob);
  }

  listSince(sinceIso: string, repo?: string): Job[] {
    const rows = repo
      ? this.db.prepare('SELECT * FROM jobs WHERE created_at >= ? AND repo = ? ORDER BY created_at ASC, rowid ASC').all(sinceIso, repo)
      : this.db.prepare('SELECT * FROM jobs WHERE created_at >= ? ORDER BY created_at ASC, rowid ASC').all(sinceIso);
    return (rows as Row[]).map(rowToJob);
  }

  listWithOpenPr(maxAgeDays: number): Job[] {
    const since = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    return (
      this.db
        .prepare(`SELECT * FROM jobs WHERE pr_number IS NOT NULL AND (pr_state IS NULL OR pr_state = 'open') AND COALESCE(finished_at, created_at) >= ?`)
        .all(since) as Row[]
    ).map(rowToJob);
  }

  nextQueued(): Job | null {
    const r = this.db.prepare(`SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at ASC, rowid ASC LIMIT 1`).get() as Row | undefined;
    return r ? rowToJob(r) : null;
  }

  private must(id: string): Job {
    const job = this.get(id);
    if (!job) throw new Error(`Job inconnu : ${id}`);
    return job;
  }

  /** Une seule instruction UPDATE pour le patch et, le cas échéant, l'état : pas d'écriture déchirée. */
  private write(id: string, patch: JobPatch, state?: JobState): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const k of Object.keys(patch) as (keyof JobPatch)[]) {
      const column = COLUMNS[k];
      if (!column) throw new Error(`Colonne inconnue : ${String(k)}`);
      const v = patch[k];
      sets.push(`${column} = ?`);
      if (JSON_KEYS.has(k)) values.push(v === null || v === undefined ? null : JSON.stringify(v));
      else values.push(v === undefined ? null : (v as string | number | null));
    }
    if (state) {
      sets.push('state = ?');
      values.push(state);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE jobs SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
  }

  /** Un champ présent avec la valeur `undefined` écrit NULL ; un patch vide n'écrit rien. */
  update(id: string, patch: JobPatch): Job {
    this.write(id, patch);
    return this.must(id);
  }

  transition(id: string, to: JobState, patch: JobPatch = {}): Job {
    const job = this.must(id);
    assertTransition(job.state, to);
    const ts = nowIso();
    const extra: JobPatch = { ...patch };
    if (job.state === 'queued' && !job.startedAt) extra.startedAt = ts;
    if (isTerminal(to)) extra.finishedAt = ts;
    this.write(id, extra, to);
    return this.must(id);
  }
}
