import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from './db.js';
import type { AgentUsage, Phase, PhaseName, PhaseOutcome } from './types.js';

type Row = Record<string, unknown>;

function rowToPhase(r: Row): Phase {
  return {
    id: r.id as number,
    jobId: r.job_id as string,
    name: r.name as PhaseName,
    attempt: r.attempt as number,
    model: (r.model as string | null) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
    costUsd: r.cost_usd as number,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    numTurns: r.num_turns as number,
    stopReason: (r.stop_reason as string | null) ?? null,
    outcome: (r.outcome as PhaseOutcome | null) ?? null,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
  };
}

export interface PhaseFinish {
  sessionId?: string | null;
  costUsd?: number;
  usage?: AgentUsage;
  numTurns?: number;
  stopReason?: string | null;
  outcome: PhaseOutcome;
}

export class PhaseStore {
  constructor(private readonly db: DatabaseSync) {}

  start(input: { jobId: string; name: PhaseName; attempt: number; model?: string | null }): Phase {
    const result = this.db
      .prepare('INSERT INTO phases (job_id, name, attempt, model, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.jobId, input.name, input.attempt, input.model ?? null, nowIso());
    return this.get(Number(result.lastInsertRowid));
  }

  finish(id: number, f: PhaseFinish): Phase {
    this.db
      .prepare(
        `UPDATE phases SET session_id = ?, cost_usd = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
         num_turns = ?, stop_reason = ?, outcome = ?, finished_at = ? WHERE id = ?`,
      )
      .run(
        f.sessionId ?? null,
        f.costUsd ?? 0,
        f.usage?.inputTokens ?? 0,
        f.usage?.outputTokens ?? 0,
        f.usage?.cacheReadTokens ?? 0,
        f.numTurns ?? 0,
        f.stopReason ?? null,
        f.outcome,
        nowIso(),
        id,
      );
    return this.get(id);
  }

  get(id: number): Phase {
    const r = this.db.prepare('SELECT * FROM phases WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new Error(`Phase inconnue : ${id}`);
    return rowToPhase(r);
  }

  listForJob(jobId: string): Phase[] {
    return (this.db.prepare('SELECT * FROM phases WHERE job_id = ? ORDER BY id ASC').all(jobId) as Row[]).map(rowToPhase);
  }

  /** Somme des coûts des phases terminées depuis l'instant donné (budget quotidien). */
  costSince(sinceIso: string): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM phases WHERE finished_at >= ?').get(sinceIso) as { total: number };
    return r.total;
  }
}
