import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { nowIso, openDatabase } from '../store/db.js';
import { JobStore } from '../store/jobs.js';
import { emptyFlags } from '../store/types.js';
import { resolveJob } from './resolve-job.js';

/** Insertion directe (hors JobStore.create, qui génère un uuid) pour maîtriser les ids en test. */
function insertJob(db: DatabaseSync, id: string, repo: string, issueNumber: number, issueTitle: string): void {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO jobs (id, repo, issue_number, issue_title, state, flags_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
  ).run(id, repo, issueNumber, issueTitle, JSON.stringify(emptyFlags()), ts, ts);
}

describe('resolveJob', () => {
  it('un id exact gagne sur un préfixe partagé par un job plus récent', () => {
    const db = openDatabase(':memory:');
    const store = new JobStore(db);
    insertJob(db, 'abc123', 'acme/demo', 1, 'A');
    insertJob(db, 'abc123xyz', 'acme/demo', 2, 'B'); // partage le préfixe de A, créé après A

    expect(resolveJob(store, 'abc123').id).toBe('abc123');
  });

  it('lève avec la liste des candidats sur un préfixe ambigu', () => {
    const db = openDatabase(':memory:');
    const store = new JobStore(db);
    insertJob(db, 'abc111', 'acme/demo', 1, 'A');
    insertJob(db, 'abc222', 'acme/demo', 2, 'B');

    // L'ordre exact (le plus récent d'abord) est un détail de listRecent, pas la garantie testée ici.
    let message = '';
    try {
      resolveJob(store, 'abc');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('2 jobs correspondent au préfixe abc :');
    expect(message).toContain('abc111');
    expect(message).toContain('abc222');
  });

  it('lève « Job inconnu » quand rien ne correspond', () => {
    const store = new JobStore(openDatabase(':memory:'));
    expect(() => resolveJob(store, 'zzzzzzzz')).toThrow('Job inconnu : zzzzzzzz');
  });
});
