import { describe, expect, it } from 'vitest';
import { ActionStore } from './actions.js';
import { openDatabase } from './db.js';

function setup(now?: () => Date) {
  const db = openDatabase(':memory:');
  return { db, actions: new ActionStore(db, now) };
}

describe('ActionStore', () => {
  it('enregistre une action avec un horodatage injectable', () => {
    const at = new Date('2026-09-09T10:00:00.000Z');
    const { actions } = setup(() => at);
    const row = actions.record({ action: 'retry', source: 'ui', jobId: 'job-1', repo: 'a/b', issueNumber: 7, outcome: 'ok' });
    expect(row).toMatchObject({
      at: '2026-09-09T10:00:00.000Z', action: 'retry', source: 'ui', jobId: 'job-1', repo: 'a/b', issueNumber: 7, outcome: 'ok', error: null,
    });
    expect(row.id).toBeGreaterThan(0);
  });

  it('champs optionnels absents → NULL', () => {
    const { actions } = setup();
    const row = actions.record({ action: 'poll', source: 'cli', outcome: 'error', error: 'boom' });
    expect(row.jobId).toBeNull();
    expect(row.repo).toBeNull();
    expect(row.issueNumber).toBeNull();
    expect(row.error).toBe('boom');
  });

  it('listRecent trie du plus récent au plus ancien, y compris à horodatage égal', () => {
    const at = new Date('2026-09-09T10:00:00.000Z');
    const { actions } = setup(() => at);
    const a = actions.record({ action: 'enqueue', source: 'ui', outcome: 'ok' });
    const b = actions.record({ action: 'cancel', source: 'ui', outcome: 'ok' });
    const c = actions.record({ action: 'pause', source: 'cli', outcome: 'ok' });
    expect(actions.listRecent(10).map((r) => r.id)).toEqual([c.id, b.id, a.id]);
    expect(actions.listRecent(2).map((r) => r.id)).toEqual([c.id, b.id]);
  });

  it('listRecent plafonne à 200 même si on demande plus', () => {
    const { actions } = setup();
    for (let n = 0; n < 205; n++) actions.record({ action: 'poll', source: 'cli', outcome: 'ok' });
    expect(actions.listRecent(10_000)).toHaveLength(200);
  });

  it('listForJob filtre par job et trie du plus ancien au plus récent', () => {
    const { actions } = setup();
    const a = actions.record({ action: 'enqueue', source: 'ui', jobId: 'job-1', outcome: 'ok' });
    const b = actions.record({ action: 'retry', source: 'ui', jobId: 'job-1', outcome: 'ok' });
    actions.record({ action: 'cancel', source: 'ui', jobId: 'job-2', outcome: 'ok' });
    expect(actions.listForJob('job-1').map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it('le CHECK SQL refuse une source ou un outcome hors énumération', () => {
    const { db } = setup();
    expect(() =>
      db.prepare(`INSERT INTO actions (at, action, source, outcome) VALUES ('t', 'poll', 'bogus', 'ok')`).run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare(`INSERT INTO actions (at, action, source, outcome) VALUES ('t', 'poll', 'ui', 'bogus')`).run(),
    ).toThrow(/CHECK/);
  });
});
