import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    issue_title TEXT NOT NULL,
    state TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    requeues INTEGER NOT NULL DEFAULT 0,
    branch TEXT,
    base_sha TEXT,
    worktree_path TEXT,
    verdict_json TEXT,
    report_json TEXT,
    flags_json TEXT NOT NULL,
    pr_number INTEGER,
    pr_url TEXT,
    pr_state TEXT,
    pr_merged_at TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX jobs_state ON jobs(state);
  CREATE INDEX jobs_repo_issue ON jobs(repo, issue_number);
  CREATE TABLE phases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    name TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    model TEXT,
    session_id TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    num_turns INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT,
    outcome TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX phases_job ON phases(job_id);
  `,
];

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec('COMMIT');
  }
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
