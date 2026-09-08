import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { assertTransition } from '../jobs/state.js';
import { nowIso } from './db.js';
import { TERMINAL_STATES, emptyFlags, isTerminal, parseFlags, type Job, type JobState } from './types.js';

type Row = Record<string, unknown>;

const TERMINAL_LIST = [...TERMINAL_STATES].map((s) => `'${s}'`).join(',');

function rowToJob(r: Row): Job {
  return {
    id: r.id as string,
    repo: r.repo as string,
    issueNumber: r.issue_number as number,
    issueTitle: r.issue_title as string,
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
  repo: 'repo', issueNumber: 'issue_number', issueTitle: 'issue_title', attempt: 'attempt', requeues: 'requeues',
  branch: 'branch', baseSha: 'base_sha', worktreePath: 'worktree_path',
  verdict: 'verdict_json', report: 'report_json', flags: 'flags_json',
  prNumber: 'pr_number', prUrl: 'pr_url', prState: 'pr_state', prMergedAt: 'pr_merged_at',
  costUsd: 'cost_usd', inputTokens: 'input_tokens', outputTokens: 'output_tokens', cacheReadTokens: 'cache_read_tokens',
  durationMs: 'duration_ms', error: 'error', startedAt: 'started_at', finishedAt: 'finished_at',
};
const JSON_KEYS = new Set<keyof JobPatch>(['verdict', 'report', 'flags']);

export class JobStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: { repo: string; issueNumber: number; issueTitle: string }): Job {
    const id = randomUUID();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO jobs (id, repo, issue_number, issue_title, state, flags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
      )
      .run(id, input.repo, input.issueNumber, input.issueTitle, JSON.stringify(emptyFlags()), ts, ts);
    return this.get(id)!;
  }

  get(id: string): Job | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToJob(r) : null;
  }

  findActiveByIssue(repo: string, issueNumber: number): Job | null {
    const r = this.db
      .prepare(`SELECT * FROM jobs WHERE repo = ? AND issue_number = ? AND state NOT IN (${TERMINAL_LIST}) ORDER BY created_at DESC LIMIT 1`)
      .get(repo, issueNumber) as Row | undefined;
    return r ? rowToJob(r) : null;
  }

  listActive(): Job[] {
    return (this.db.prepare(`SELECT * FROM jobs WHERE state NOT IN (${TERMINAL_LIST}) ORDER BY created_at ASC`).all() as Row[]).map(rowToJob);
  }

  listByStates(states: JobState[]): Job[] {
    if (states.length === 0) return [];
    const marks = states.map(() => '?').join(',');
    return (this.db.prepare(`SELECT * FROM jobs WHERE state IN (${marks}) ORDER BY created_at ASC`).all(...states) as Row[]).map(rowToJob);
  }

  listRecent(limit: number): Job[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]).map(rowToJob);
  }

  listSince(sinceIso: string, repo?: string): Job[] {
    const rows = repo
      ? this.db.prepare('SELECT * FROM jobs WHERE created_at >= ? AND repo = ? ORDER BY created_at ASC').all(sinceIso, repo)
      : this.db.prepare('SELECT * FROM jobs WHERE created_at >= ? ORDER BY created_at ASC').all(sinceIso);
    return (rows as Row[]).map(rowToJob);
  }

  listWithOpenPr(maxAgeDays: number): Job[] {
    const since = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    return (
      this.db
        .prepare(`SELECT * FROM jobs WHERE pr_number IS NOT NULL AND (pr_state IS NULL OR pr_state = 'open') AND created_at >= ?`)
        .all(since) as Row[]
    ).map(rowToJob);
  }

  nextQueued(): Job | null {
    const r = this.db.prepare(`SELECT * FROM jobs WHERE state = 'queued' ORDER BY created_at ASC LIMIT 1`).get() as Row | undefined;
    return r ? rowToJob(r) : null;
  }

  update(id: string, patch: JobPatch): Job {
    const keys = Object.keys(patch) as (keyof JobPatch)[];
    if (keys.length > 0) {
      const sets = keys.map((k) => `${COLUMNS[k]} = ?`);
      const values = keys.map((k) => {
        const v = patch[k];
        if (JSON_KEYS.has(k)) return v === null || v === undefined ? null : JSON.stringify(v);
        return v === undefined ? null : (v as string | number | null);
      });
      this.db.prepare(`UPDATE jobs SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
    }
    const job = this.get(id);
    if (!job) throw new Error(`Job inconnu : ${id}`);
    return job;
  }

  transition(id: string, to: JobState, patch: JobPatch = {}): Job {
    const job = this.get(id);
    if (!job) throw new Error(`Job inconnu : ${id}`);
    assertTransition(job.state, to);
    const ts = nowIso();
    const extra: JobPatch = { ...patch };
    if (job.state === 'queued' && !job.startedAt) extra.startedAt = ts;
    if (isTerminal(to)) extra.finishedAt = ts;
    this.update(id, extra);
    this.db.prepare('UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?').run(to, ts, id);
    return this.get(id)!;
  }
}
