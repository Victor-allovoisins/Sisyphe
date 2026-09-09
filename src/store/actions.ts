import type { DatabaseSync } from 'node:sqlite';

// Source de vérité du CHECK SQL (migration 2) : la modifier change silencieusement le schéma
// des bases neuves sans toucher les bases déjà migrées. Le test « fige le littéral des
// énumérations SQL » de store.test.ts protège contre ce genre de dérive.
export const ACTION_SOURCES = ['ui', 'cli'] as const;
export type ActionSource = (typeof ACTION_SOURCES)[number];

export const ACTION_OUTCOMES = ['ok', 'error'] as const;
export type ActionOutcome = (typeof ACTION_OUTCOMES)[number];

/** Pas de CHECK SQL sur cette colonne : la liste peut s'étendre sans nouvelle migration. */
export type ActionName = 'cancel' | 'retry' | 'enqueue' | 'poll' | 'pause' | 'resume' | 'stop' | 'start';

export interface ActionRow {
  id: number;
  at: string;
  action: ActionName;
  source: ActionSource;
  jobId: string | null;
  repo: string | null;
  issueNumber: number | null;
  outcome: ActionOutcome;
  error: string | null;
}

export interface ActionInput {
  action: ActionName;
  source: ActionSource;
  jobId?: string | null;
  repo?: string | null;
  issueNumber?: number | null;
  outcome: ActionOutcome;
  error?: string | null;
}

type Row = Record<string, unknown>;

function rowToAction(r: Row): ActionRow {
  return {
    id: r.id as number,
    at: r.at as string,
    action: r.action as ActionName,
    source: r.source as ActionSource,
    jobId: (r.job_id as string | null) ?? null,
    repo: (r.repo as string | null) ?? null,
    issueNumber: (r.issue_number as number | null) ?? null,
    outcome: r.outcome as ActionOutcome,
    error: (r.error as string | null) ?? null,
  };
}

const MAX_RECENT = 200;

/** Journal des actions déclenchées par l'UI ou la CLI, écrit par le daemon (seul écrivain de la base). */
export class ActionStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => Date = () => new Date()) {}

  record(input: ActionInput): ActionRow {
    const result = this.db
      .prepare('INSERT INTO actions (at, action, source, job_id, repo, issue_number, outcome, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        this.now().toISOString(),
        input.action,
        input.source,
        input.jobId ?? null,
        input.repo ?? null,
        input.issueNumber ?? null,
        input.outcome,
        input.error ?? null,
      );
    return this.get(Number(result.lastInsertRowid));
  }

  private get(id: number): ActionRow {
    const r = this.db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new Error(`Action inconnue : ${id}`);
    return rowToAction(r);
  }

  /** Plus récentes d'abord ; plafonné à 200 et jamais négatif ou fractionnaire, quelle que soit la limite demandée. */
  listRecent(limit: number): ActionRow[] {
    const n = Math.min(Math.max(0, Math.trunc(limit)), MAX_RECENT);
    return (this.db.prepare('SELECT * FROM actions ORDER BY at DESC, id DESC LIMIT ?').all(n) as Row[]).map(rowToAction);
  }

  listForJob(jobId: string): ActionRow[] {
    return (this.db.prepare('SELECT * FROM actions WHERE job_id = ? ORDER BY id ASC').all(jobId) as Row[]).map(rowToAction);
  }
}
