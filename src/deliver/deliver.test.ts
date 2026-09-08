import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeIssueSource } from '../../test/fakes/fake-issue-source.js';
import { createRemoteRepo, remoteBranchSha, remoteCommitMessage, writeFiles } from '../../test/helpers/git-fixture.js';
import { dataPaths } from '../config/paths.js';
import { parseRepoConfig } from '../config/repo.js';
import { Git } from '../git/git.js';
import { parseRepo } from '../github/source.js';
import { openDatabase } from '../store/db.js';
import { JobStore } from '../store/jobs.js';
import { emptyFlags, type Job } from '../store/types.js';
import type { VerifyResult } from '../verify/verify.js';
import { commitMessage, deliver, shouldBeDraft } from './deliver.js';

const REPO = 'acme/demo';
const repo = parseRepo(REPO);
const config = parseRepoConfig('baseBranch: main\ncommands:\n  build: "true"\n'); // guillemets : en YAML nu, true est un booléen
const report = { summary: 'ok', changes: [], decisions: [], tests_run: [], risks: [], follow_ups: [], confidence: 1 };
const verifyBase: Omit<VerifyResult, 'treeSha'> = { ok: true, noChanges: false, steps: [], failedStep: null, failureTail: '', files: [], changedLines: 1, driftedFiles: [], flags: { protectedPathsTouched: [], largeDiff: false, secretsFound: [] } };

describe('deliver', () => {
  let remotePath: string;
  let git: Git;
  let store: JobStore;
  let source: FakeIssueSource;
  let worktreePath: string;
  let baseSha: string;
  let verify: VerifyResult;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'sisyphe-deliver-'));
    ({ remotePath } = await createRemoteRepo(root, { 'README.md': 'x\n' }));
    git = new Git(dataPaths(join(root, 'data')));
    await git.ensureMirror(REPO, remotePath, remotePath, ['main']);
    ({ worktreePath, baseSha } = await git.createWorktree(REPO, 7, 'feature/issue-7-x', 'main'));
    await writeFiles(worktreePath, { 'a.txt': 'a\n' });
    await git.stage(worktreePath, baseSha);
    verify = { ...verifyBase, treeSha: await git.writeTree(worktreePath) };
    store = new JobStore(openDatabase(':memory:'));
    source = new FakeIssueSource();
    source.addIssue(repo, { number: 7, title: 'Titre', author: 'alice' });
  });

  function makeJob(flags: Partial<Job['flags']> = {}) {
    const j = store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Titre' });
    return store.update(j.id, {
      branch: 'feature/issue-7-x', baseSha, worktreePath, attempt: 1, costUsd: 2.5,
      verdict: { verdict: 'ready', confidence: 1, summary: 's', change_type: 'fix', plan: [], files_likely_touched: [], questions: [], reasons: [] },
      flags: { ...emptyFlags(), ...flags },
    });
  }

  const run = (job: ReturnType<typeof makeJob>) =>
    deliver({ job, issue: { repo, number: 7, title: 'Titre', body: '', author: 'alice', state: 'open', labels: [], comments: [] }, config, report, verify, phases: [], source, git, worktreePath, pushUrl: remotePath, prTemplate: null, durationMs: 5000 });

  it('pousse un commit squashé et ouvre la PR', async () => {
    const job = makeJob();
    const r = await run(job);
    expect(await remoteBranchSha(remotePath, 'feature/issue-7-x')).toBe(r.commitSha);
    expect(await remoteCommitMessage(remotePath, r.commitSha)).toBe(commitMessage(job));
    expect(source.pulls).toHaveLength(1);
    const pr = source.pulls[0];
    expect(pr.title).toBe('[#7] Titre');
    expect(pr.base).toBe('main');
    expect(pr.head).toBe('feature/issue-7-x');
    expect(pr.draft).toBe(false);
    expect(pr.labels).toEqual(['sisyphe']);
    expect(pr.reviewers).toEqual(['alice']);
    expect(source.labelsOf({ repo, number: 7 })).toContain('sisyphe:done');
    expect(source.commentsOf({ repo, number: 7 }).at(-1)).toContain('PR prête');
  });

  it('réutilise une PR existante sur la même branche', async () => {
    const job = makeJob();
    await run(job);
    await run(store.update(job.id, { costUsd: 9 }));
    expect(source.pulls).toHaveLength(1);
    expect(source.pulls[0].body).toContain('$9.00');
  });

  it('passe en draft et en failed quand la vérification a échoué', async () => {
    const job = makeJob({ verificationFailed: true });
    const r = await run(job);
    expect(r.draft).toBe(true);
    expect(source.pulls[0].draft).toBe(true);
    expect(source.labelsOf({ repo, number: 7 })).toContain('sisyphe:failed');
  });

  it('shouldBeDraft et commitMessage', () => {
    const job = makeJob({ largeDiff: true });
    expect(shouldBeDraft(job, config)).toBe(true);
    expect(shouldBeDraft({ ...job, flags: emptyFlags() }, config)).toBe(false);
    expect(commitMessage(job)).toMatch(/^fix\(#7\): Titre\n\nCloses #7\n\nCo-Authored-By: Sisyphe/);
  });
});
