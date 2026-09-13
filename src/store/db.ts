import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ACTION_OUTCOMES, ACTION_SOURCES } from './actions.js';
import { JOB_STATES, TERMINAL_STATES } from './types.js';

export const sqlList = (values: Iterable<string>) => [...values].map((s) => `'${s}'`).join(',');
const STATES = sqlList(JOB_STATES);
const TERMINALS = sqlList(TERMINAL_STATES);
const ACTION_SOURCES_SQL = sqlList(ACTION_SOURCES);
const ACTION_OUTCOMES_SQL = sqlList(ACTION_OUTCOMES);

// Append-only : une migration livrée ne se modifie jamais. Ajouter un état à JOB_STATES exige
// une nouvelle migration qui reconstruit la table (SQLite ne modifie pas un CHECK en place) ; le test
// « littéral figé » de store.test.ts force cette décision.
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    issue_title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (${STATES})),
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
    pr_state TEXT CHECK (pr_state IS NULL OR pr_state IN ('open','closed')),
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
  CREATE INDEX jobs_state ON jobs(state, created_at);
  CREATE INDEX jobs_repo_issue ON jobs(repo, issue_number);
  CREATE INDEX jobs_pr ON jobs(pr_number) WHERE pr_number IS NOT NULL;
  CREATE UNIQUE INDEX jobs_active_issue ON jobs(repo, issue_number) WHERE state NOT IN (${TERMINALS});
  CREATE TABLE phases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    name TEXT NOT NULL CHECK (name IN ('triage','implement','verify','deliver')),
    attempt INTEGER NOT NULL,
    model TEXT,
    session_id TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    num_turns INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT,
    outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success','failure')),
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX phases_job ON phases(job_id);
  CREATE INDEX phases_finished ON phases(finished_at);
  `,
  `
  CREATE TABLE actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    action TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN (${ACTION_SOURCES_SQL})),
    job_id TEXT,
    repo TEXT,
    issue_number INTEGER,
    outcome TEXT NOT NULL CHECK (outcome IN (${ACTION_OUTCOMES_SQL})),
    error TEXT
  );
  CREATE INDEX actions_at ON actions(at);
  CREATE INDEX actions_job ON actions(job_id);
  `,
];

/** Version de schéma attendue : `PRAGMA user_version` d'une base à jour. L'UI s'en sert pour savoir s'il faut migrer. */
export const SCHEMA_VERSION = MIGRATIONS.length;

const userVersion = (db: DatabaseSync): number => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

/**
 * Applique les migrations manquantes à partir de `from`, une transaction chacune. Le daemon n'est plus
 * seul à migrer (`sisyphe ui` et `sisyphe setup` le font aussi) : deux processus peuvent donc partir du
 * même `from`. `BEGIN IMMEDIATE` prend le verrou d'écriture d'entrée de jeu — le second attend
 * (`busy_timeout`) au lieu d'échouer à la première écriture — et la version est relue *dans* la
 * transaction : si l'autre est passé avant, on saute la migration au lieu de la rejouer. Pas de
 * `CREATE TABLE IF NOT EXISTS`, qui masquerait une migration à moitié appliquée.
 * Exporté pour que le test puisse rejouer le plan périmé du perdant.
 */
export function applyMigrations(db: DatabaseSync, from: number): void {
  for (let v = from; v < MIGRATIONS.length; v++) {
    try {
      db.exec('BEGIN IMMEDIATE');
      if (userVersion(db) > v) {
        // Migration déjà appliquée par un autre processus pendant qu'on attendait le verrou.
        db.exec('ROLLBACK');
        continue;
      }
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* aucune transaction ouverte */
      }
      db.close();
      throw new Error(`Migration ${v + 1} échouée : ${(err as Error).message}`, { cause: err });
    }
  }
}

/**
 * Ouvre (ou crée) la base et applique les migrations manquantes, chacune dans une transaction.
 * L'index unique `jobs_active_issue` rend structurel l'invariant « un seul job actif par issue ».
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  applyMigrations(db, userVersion(db));
  return db;
}

/**
 * Ouvre la base en lecture seule : aucune migration, aucun PRAGMA d'écriture, le daemon n'est pas gêné.
 * Sert l'UI locale. Une base absente est une erreur explicite plutôt qu'un `unable to open database file`.
 */
export function openDatabaseReadOnly(path: string): DatabaseSync {
  if (!existsSync(path)) {
    throw new Error(`Aucune base Sisyphe à ${path} : elle est créée par \`sisyphe setup\`, par \`sisyphe ui\` ou au premier démarrage du daemon.`);
  }
  return new DatabaseSync(path, { readOnly: true });
}

export function nowIso(): string {
  return new Date().toISOString();
}
