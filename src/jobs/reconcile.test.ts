import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REPO, makeHarness, repoRef } from '../../test/helpers/harness.js';
import { writeFiles } from '../../test/helpers/git-fixture.js';
import { reconcile } from './reconcile.js';

describe('reconcile', () => {
  it('requeue une fois les jobs interrompus, puis les passe en failed', async () => {
    const h = await makeHarness({ steps: [] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 't' });
    await h.deps.git.ensureMirror(REPO, h.remotePath, h.remotePath, ['main']);
    const wt = await h.deps.git.createWorktree(REPO, 7, 'feature/issue-7-t', 'main');
    h.store.transition(job.id, 'triaging');
    h.store.transition(job.id, 'implementing', { worktreePath: wt.worktreePath, branch: 'feature/issue-7-t', baseSha: wt.baseSha });
    await h.source.setStatus({ repo: repoRef, number: 7 }, 'in-progress');

    await reconcile(h.deps);
    let j = h.store.get(job.id)!;
    expect(j.state).toBe('queued');
    expect(j.requeues).toBe(1);
    expect(j.worktreePath).toBeNull();
    expect(existsSync(wt.worktreePath)).toBe(false);
    expect(h.source.commentsOf({ repo: repoRef, number: 7 }).at(-1)).toContain('redémarré');
    expect(h.source.labelsOf({ repo: repoRef, number: 7 })).toContain('sisyphe:in-progress'); // job encore actif

    h.store.transition(job.id, 'triaging');
    await reconcile(h.deps);
    j = h.store.get(job.id)!;
    expect(j.state).toBe('failed');
    expect(h.source.labelsOf({ repo: repoRef, number: 7 })).toContain('sisyphe:failed');
  });

  it('termine un job delivering dont la PR existe', async () => {
    const h = await makeHarness({ steps: [] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 't' });
    h.store.transition(job.id, 'triaging');
    h.store.transition(job.id, 'implementing', { branch: 'feature/issue-7-t' });
    h.store.transition(job.id, 'verifying');
    h.store.transition(job.id, 'delivering');
    await h.source.openPullRequest({ repo: repoRef, title: 't', head: 'feature/issue-7-t', base: 'main', body: '', draft: false, labels: [], reviewers: [] });

    await reconcile(h.deps);
    const j = h.store.get(job.id)!;
    expect(j.state).toBe('done');
    expect(j.prNumber).toBe(100);
  });

  it('supprime les worktrees orphelins et libère les labels in-progress sans job', async () => {
    const h = await makeHarness({ steps: [] });
    await h.deps.git.ensureMirror(REPO, h.remotePath, h.remotePath, ['main']);
    const orphan = await h.deps.git.createWorktree(REPO, 99, 'feature/issue-99-x', 'main');
    await writeFiles(orphan.worktreePath, { 'x.txt': 'x' });
    await h.source.setStatus({ repo: repoRef, number: 7 }, 'in-progress');

    await reconcile(h.deps);
    expect(existsSync(orphan.worktreePath)).toBe(false);
    expect(h.source.labelsOf({ repo: repoRef, number: 7 })).toEqual(['sisyphe']);
    expect(h.source.commentsOf({ repo: repoRef, number: 7 }).at(-1)).toContain('redémarré');
  });
});
