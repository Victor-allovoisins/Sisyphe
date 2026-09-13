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

  it('isole les PR par repo et accepte maintain', async () => {
    const s = new FakeIssueSource();
    const other = parseRepo('acme/other');
    await s.openPullRequest({ repo, title: 'a', head: 'feature/issue-7-x', base: 'main', body: '', draft: false, labels: [], reviewers: [] });
    expect(await s.findPullRequest(other, 'feature/issue-7-x')).toBeNull();
    expect((await s.findPullRequest(repo, 'feature/issue-7-x'))?.number).toBe(100);
    s.permissions.carol = 'maintain';
    s.addIssue(repo, { number: 3, title: 'c', labeledBy: 'carol' });
    // Aucun événement `labeled` : repli sur l'auteur tant que le label trigger est là, comme le client réel.
    s.addIssue(repo, { number: 4, title: 'd', labeledBy: null, author: 'carol' });
    s.addIssue(repo, { number: 5, title: 'e', labeledBy: null, labels: [] });
    expect((await s.canTrigger({ repo, number: 3 })).ok).toBe(true);
    expect(await s.canTrigger({ repo, number: 4 })).toEqual({ ok: true, login: 'carol' });
    expect(await s.canTrigger({ repo, number: 5 })).toEqual({ ok: false, login: null });
  });

  it('addTriggerLabel repose le label trigger et attribue sisyphe[bot], idempotent', async () => {
    const s = new FakeIssueSource('sisyphe');
    s.permissions.alice = 'write';
    s.addIssue(repo, { number: 1, title: 'a', labels: [], author: 'alice' });
    await s.addTriggerLabel({ repo, number: 1 });
    expect(s.labelsOf({ repo, number: 1 })).toEqual(['sisyphe']);
    expect(s.calls).toEqual(['addTriggerLabel']);
    // Notre propre pose de label ne fait pas de nous le demandeur : repli sur l'auteur, jamais un refus.
    expect(await s.canTrigger({ repo, number: 1 })).toEqual({ ok: true, login: 'alice' });
    await s.addTriggerLabel({ repo, number: 1 });
    expect(s.labelsOf({ repo, number: 1 })).toEqual(['sisyphe']);
  });
});
