import type { ImplementationReport } from '../agent/schemas.js';
import type { RepoConfig } from '../config/repo.js';
import { SISYPHE_AUTHOR, type Git } from '../git/git.js';
import { parseRepo, type Issue, type IssueSource, type PullRef } from '../github/source.js';
import type { Job, Phase } from '../store/types.js';
import type { VerifyResult } from '../verify/verify.js';
import { renderDoneComment } from './comments.js';
import { renderPrBody } from './pr-body.js';

export interface DeliverInput {
  job: Job;
  issue: Issue;
  config: RepoConfig;
  report: ImplementationReport;
  verify: VerifyResult;
  phases: Phase[];
  source: IssueSource;
  git: Git;
  worktreePath: string;
  pushUrl: string;
  prTemplate: string | null;
  durationMs: number;
}

export interface DeliverResult {
  prNumber: number;
  prUrl: string;
  commitSha: string;
  draft: boolean;
}

export function commitMessage(job: Job): string {
  const type = job.verdict?.change_type ?? 'chore';
  return `${type}(#${job.issueNumber}): ${job.issueTitle}\n\nCloses #${job.issueNumber}\n\nCo-Authored-By: ${SISYPHE_AUTHOR.name} <${SISYPHE_AUTHOR.email}>`;
}

export function shouldBeDraft(job: Job, config: RepoConfig): boolean {
  return config.pr.draft || job.flags.verificationFailed || job.flags.protectedPathsTouched.length > 0 || job.flags.largeDiff;
}

/** Squash, push, PR (créée ou mise à jour), puis statut et commentaire sur l'issue. */
export async function deliver(i: DeliverInput): Promise<DeliverResult> {
  const { job, config, source } = i;
  if (!job.branch || !job.baseSha) throw new Error('Job sans branche ou base : livraison impossible');
  const repo = parseRepo(job.repo);

  if (!i.verify.treeSha) throw new Error('Aucun arbre vérifié : livraison impossible');
  // On commite l'arbre exact que la vérification a inspecté, pas l'état du worktree après build/test.
  const commitSha = await i.git.commitTree(i.worktreePath, job.branch, i.verify.treeSha, job.baseSha, commitMessage(job));
  await i.git.push(i.worktreePath, i.pushUrl, job.branch, commitSha);

  const draft = shouldBeDraft(job, config);
  const title = `[#${job.issueNumber}] ${job.issueTitle}`;
  const body = renderPrBody({ job, report: i.report, verify: i.verify, phases: i.phases, prTemplate: i.prTemplate, costUsd: job.costUsd, durationMs: i.durationMs });

  const existing = await source.findPullRequest(repo, job.branch);
  let pr: PullRef;
  if (existing) {
    await source.updatePullRequest(existing, { title, body, draft });
    pr = existing;
  } else {
    const reviewers = config.pr.reviewers.length > 0 ? config.pr.reviewers : [i.issue.author];
    pr = await source.openPullRequest({ repo, title, head: job.branch, base: config.baseBranch, body, draft, labels: config.pr.labels, reviewers });
  }

  const status = job.flags.verificationFailed ? 'failed' : 'done';
  const issueRef = { repo, number: job.issueNumber };
  await source.setStatus(issueRef, status);
  await source.comment(issueRef, renderDoneComment({ prUrl: pr.url, status, costUsd: job.costUsd, durationMs: i.durationMs, attempts: job.attempt }));
  return { prNumber: pr.number, prUrl: pr.url, commitSha, draft };
}
