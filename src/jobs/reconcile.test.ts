import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { REPO, makeHarness, repoRef } from '../../test/helpers/harness.js';
import { writeFiles } from '../../test/helpers/git-fixture.js';
import { emptyFlags } from '../store/types.js';
import { purgeOrphanWorktrees, reconcile } from './reconcile.js';

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

  it("ne purge pas le worktree d'un job actif", async () => {
    const h = await makeHarness({ steps: [] });
    await h.deps.git.ensureMirror(REPO, h.remotePath, h.remotePath, ['main']);

    const wt = await h.deps.git.createWorktree(REPO, 7, 'feature/issue-7-t', 'main');
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 't' });
    h.store.transition(job.id, 'triaging');
    h.store.transition(job.id, 'implementing', { worktreePath: wt.worktreePath, branch: 'feature/issue-7-t', baseSha: wt.baseSha });

    // Variante : worktreePath pas encore renseigné en base, mais le dossier existe déjà (créé avant l'écriture en base).
    const wt2 = await h.deps.git.createWorktree(REPO, 8, 'feature/issue-8-t', 'main');
    const job2 = h.store.create({ repo: REPO, issueNumber: 8, issueTitle: 't2' });
    h.store.transition(job2.id, 'triaging');
    h.store.transition(job2.id, 'implementing', { branch: 'feature/issue-8-t' });

    await purgeOrphanWorktrees(h.deps);
    expect(existsSync(wt.worktreePath)).toBe(true);
    expect(existsSync(wt2.worktreePath)).toBe(true);
  });

  it("conserve le worktree d'un job failed récent et le purge après le TTL", async () => {
    const h = await makeHarness({ steps: [] });
    await h.deps.git.ensureMirror(REPO, h.remotePath, h.remotePath, ['main']);
    const wt = await h.deps.git.createWorktree(REPO, 7, 'feature/issue-7-t', 'main');
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 't' });
    h.store.transition(job.id, 'triaging');
    h.store.transition(job.id, 'implementing', { worktreePath: wt.worktreePath, branch: 'feature/issue-7-t', baseSha: wt.baseSha });
    h.store.transition(job.id, 'failed', { worktreePath: wt.worktreePath, error: 'x' });

    await purgeOrphanWorktrees(h.deps);
    expect(existsSync(wt.worktreePath)).toBe(true);

    h.store.update(job.id, { finishedAt: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    await purgeOrphanWorktrees(h.deps);
    expect(existsSync(wt.worktreePath)).toBe(false);
  });

  it('libère le label in-progress et poste le commentaire de fin quand delivering retrouve sa PR', async () => {
    const h = await makeHarness({ steps: [] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 't' });
    h.store.transition(job.id, 'triaging');
    h.store.transition(job.id, 'implementing', { branch: 'feature/issue-7-t' });
    h.store.transition(job.id, 'verifying');
    h.store.transition(job.id, 'delivering');
    const pr = await h.source.openPullRequest({ repo: repoRef, title: 't', head: 'feature/issue-7-t', base: 'main', body: '', draft: false, labels: [], reviewers: [] });
    await h.source.setStatus({ repo: repoRef, number: 7 }, 'in-progress');

    await reconcile(h.deps);
    const j = h.store.get(job.id)!;
    expect(j.state).toBe('done');
    const labels = h.source.labelsOf({ repo: repoRef, number: 7 });
    expect(labels).toContain('sisyphe:done');
    expect(labels).not.toContain('sisyphe:in-progress');
    const comments = h.source.commentsOf({ repo: repoRef, number: 7 });
    expect(comments.some((c) => c.includes('redémarré'))).toBe(false);
    expect(comments.at(-1)).toContain(pr.url);
  });

  it("réinitialise les flags et l'erreur au requeue d'un job delivering sans PR", async () => {
    const h = await makeHarness({ steps: [] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 't' });
    h.store.transition(job.id, 'triaging');
    h.store.transition(job.id, 'implementing', { branch: 'feature/issue-7-t' });
    h.store.transition(job.id, 'verifying');
    h.store.transition(job.id, 'delivering');
    h.store.update(job.id, { flags: { ...emptyFlags(), verificationFailed: true }, error: 'boom' });

    await reconcile(h.deps);
    const j = h.store.get(job.id)!;
    expect(j.state).toBe('queued');
    expect(j.requeues).toBe(1);
    expect(j.flags.verificationFailed).toBe(false);
    expect(j.error).toBeNull();
  });

  it('marque failed et supprime le worktree quand la vérification avait échoué mais la PR existe', async () => {
    const h = await makeHarness({ steps: [] });
    await h.deps.git.ensureMirror(REPO, h.remotePath, h.remotePath, ['main']);
    const wt = await h.deps.git.createWorktree(REPO, 7, 'feature/issue-7-t', 'main');
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 't' });
    h.store.transition(job.id, 'triaging');
    h.store.transition(job.id, 'implementing', { worktreePath: wt.worktreePath, branch: 'feature/issue-7-t', baseSha: wt.baseSha });
    h.store.transition(job.id, 'verifying');
    h.store.transition(job.id, 'delivering', { flags: { ...emptyFlags(), verificationFailed: true } });
    await h.source.openPullRequest({ repo: repoRef, title: 't', head: 'feature/issue-7-t', base: 'main', body: '', draft: false, labels: [], reviewers: [] });

    await reconcile(h.deps);
    const j = h.store.get(job.id)!;
    expect(j.state).toBe('failed');
    expect(j.prNumber).toBe(100);
    expect(h.source.labelsOf({ repo: repoRef, number: 7 })).toContain('sisyphe:failed');
    // Chemin jumeau de `runJob` : le TTL des worktrees de jobs failed garderait celui-ci, la réconciliation le supprime.
    expect(existsSync(wt.worktreePath)).toBe(false);
  });

  it('corrige un label in-progress resté en place quand le job est déjà done avec une PR ouverte', async () => {
    const h = await makeHarness({ steps: [] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 't' });
    h.store.transition(job.id, 'triaging');
    h.store.transition(job.id, 'implementing', { branch: 'feature/issue-7-t' });
    h.store.transition(job.id, 'verifying');
    h.store.transition(job.id, 'delivering');
    h.store.transition(job.id, 'done', { prNumber: 100, prUrl: 'https://example.test/pr/100', prState: 'open', branch: 'feature/issue-7-t' });
    // Livraison réussie mais le setStatus final avait échoué (warning côté deliver) : le label est resté en place.
    await h.source.setStatus({ repo: repoRef, number: 7 }, 'in-progress');

    await reconcile(h.deps);
    const j = h.store.get(job.id)!;
    expect(j.state).toBe('done');
    const labels = h.source.labelsOf({ repo: repoRef, number: 7 });
    expect(labels).toContain('sisyphe:done');
    expect(labels).not.toContain('sisyphe:in-progress');
    const comments = h.source.commentsOf({ repo: repoRef, number: 7 });
    expect(comments.some((c) => c.includes('redémarré'))).toBe(false);
  });

  it('corrige un label in-progress resté en place quand le job est déjà failed avec une PR ouverte', async () => {
    const h = await makeHarness({ steps: [] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 't' });
    h.store.transition(job.id, 'triaging');
    h.store.transition(job.id, 'implementing', { branch: 'feature/issue-7-t' });
    h.store.transition(job.id, 'verifying');
    h.store.transition(job.id, 'delivering');
    h.store.transition(job.id, 'failed', { prNumber: 100, prUrl: 'https://example.test/pr/100', prState: 'open', branch: 'feature/issue-7-t' });
    await h.source.setStatus({ repo: repoRef, number: 7 }, 'in-progress');

    await reconcile(h.deps);
    const j = h.store.get(job.id)!;
    expect(j.state).toBe('failed');
    const labels = h.source.labelsOf({ repo: repoRef, number: 7 });
    expect(labels).toContain('sisyphe:failed');
    expect(labels).not.toContain('sisyphe:in-progress');
    const comments = h.source.commentsOf({ repo: repoRef, number: 7 });
    expect(comments.some((c) => c.includes('redémarré'))).toBe(false);
  });

  it('laisse le job en delivering si findPullRequest échoue', async () => {
    const h = await makeHarness({ steps: [] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 't' });
    h.store.transition(job.id, 'triaging');
    h.store.transition(job.id, 'implementing', { branch: 'feature/issue-7-t' });
    h.store.transition(job.id, 'verifying');
    h.store.transition(job.id, 'delivering');
    h.source.findPullRequest = async () => {
      throw new Error('rate limit');
    };

    await reconcile(h.deps);
    const j = h.store.get(job.id)!;
    expect(j.state).toBe('delivering');
    expect(j.requeues).toBe(0);
    expect(h.source.commentsOf({ repo: repoRef, number: 7 })).toEqual([]);
  });

  it("une exception sur un job n'empêche pas la réconciliation des autres", async () => {
    const h = await makeHarness({
      steps: [],
      issues: [
        { number: 7, title: 't7' },
        { number: 8, title: 't8' },
        { number: 9, title: 't9' },
      ],
    });

    const job7 = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 't7' });
    h.store.transition(job7.id, 'triaging');
    h.store.transition(job7.id, 'implementing', { branch: 'feature/issue-7-t' });
    h.store.transition(job7.id, 'verifying');
    h.store.transition(job7.id, 'delivering');

    const job8 = h.store.create({ repo: REPO, issueNumber: 8, issueTitle: 't8' });
    h.store.transition(job8.id, 'triaging');
    h.store.transition(job8.id, 'implementing', { branch: 'feature/issue-8-t' });
    h.store.transition(job8.id, 'verifying');
    h.store.transition(job8.id, 'delivering');
    await h.source.openPullRequest({ repo: repoRef, title: 't8', head: 'feature/issue-8-t', base: 'main', body: '', draft: false, labels: [], reviewers: [] });

    await h.source.setStatus({ repo: repoRef, number: 9 }, 'in-progress');

    const originalTransition = h.store.transition.bind(h.store);
    vi.spyOn(h.store, 'transition').mockImplementation((id, to, patch) => {
      if (id === job7.id) throw new Error('boom');
      return originalTransition(id, to, patch);
    });

    await reconcile(h.deps);

    expect(h.store.get(job7.id)!.state).toBe('delivering');
    const j8 = h.store.get(job8.id)!;
    expect(j8.state).toBe('done');
    expect(j8.prNumber).toBe(100);
    expect(h.source.labelsOf({ repo: repoRef, number: 8 })).toContain('sisyphe:done');
    expect(h.source.labelsOf({ repo: repoRef, number: 9 })).not.toContain('sisyphe:in-progress');
    expect(h.source.commentsOf({ repo: repoRef, number: 9 }).at(-1)).toContain('redémarré');
  });
});
