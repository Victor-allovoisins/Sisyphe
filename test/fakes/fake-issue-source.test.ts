import { describe, expect, it } from 'vitest';
import { parseRepo } from '../../src/github/source.js';
import { FakeIssueSource } from './fake-issue-source.js';

const repo = parseRepo('acme/demo');

describe('FakeIssueSource', () => {
  it('filtre les candidates sur le label trigger et l’absence de statut', async () => {
    const s = new FakeIssueSource('sisyphe');
    s.addIssue(repo, { number: 1, title: 'a' });
    s.addIssue(repo, { number: 2, title: 'b', labels: ['bug'] });
    s.addIssue(repo, { number: 3, title: 'c', labels: ['sisyphe', 'sisyphe:done'] });
    expect((await s.listCandidates(repo)).map((r) => r.number)).toEqual([1]);
    await s.setStatus({ repo, number: 1 }, 'in-progress');
    expect(await s.listCandidates(repo)).toEqual([]);
    expect(s.labelsOf({ repo, number: 1 })).toEqual(['sisyphe', 'sisyphe:in-progress']);
    await s.setStatus({ repo, number: 1 }, null);
    expect(s.labelsOf({ repo, number: 1 })).toEqual(['sisyphe']);
  });

  it('vérifie la permission du poseur de label', async () => {
    const s = new FakeIssueSource();
    s.permissions.alice = 'write';
    s.addIssue(repo, { number: 1, title: 'a', labeledBy: 'alice' });
    s.addIssue(repo, { number: 2, title: 'b', labeledBy: 'mallory' });
    expect(await s.canTrigger({ repo, number: 1 })).toEqual({ ok: true, login: 'alice' });
    expect(await s.canTrigger({ repo, number: 2 })).toEqual({ ok: false, login: 'mallory' });
  });
});
