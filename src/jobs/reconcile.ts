import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { MachineConfig } from '../config/machine.js';
import { worktreePath, type DataPaths } from '../config/paths.js';
import { renderDoneComment, renderFailedComment, renderRestartComment } from '../deliver/comments.js';
import type { Git } from '../git/git.js';
import { issueRefOf, parseRepo, type IssueSource, type PullRef } from '../github/source.js';
import type { JobStore } from '../store/jobs.js';
import { emptyFlags, type Job } from '../store/types.js';

export interface ReconcileDeps {
  store: JobStore;
  source: IssueSource;
  git: Git;
  paths: DataPaths;
  machine: MachineConfig;
  log: Logger;
}

export const MAX_REQUEUES = 1;
export const FAILED_WORKTREE_TTL_DAYS = 7;
/** Fenêtre pendant laquelle une PR encore ouverte fait foi pour corriger un label in-progress orphelin. */
const PR_LOOKBACK_DAYS = 30;

/** Remet le système d'aplomb après un redémarrage. GitHub fait foi si la base a été perdue. */
export async function reconcile(d: ReconcileDeps): Promise<void> {
  for (const job of d.store.listByStates(['triaging', 'implementing', 'verifying'])) {
    try {
      await requeueOrFail(job, d);
    } catch (err) {
      d.log.error({ err, jobId: job.id }, 'réconciliation : job ignoré');
    }
  }

  for (const job of d.store.listByStates(['delivering'])) {
    try {
      let pr: PullRef | null = null;
      if (job.branch) {
        try {
          pr = await d.source.findPullRequest(parseRepo(job.repo), job.branch);
        } catch (err) {
          d.log.warn({ err, jobId: job.id }, 'réconciliation : findPullRequest a échoué, job laissé en delivering');
          continue;
        }
      }
      if (pr) {
        const final = job.flags.verificationFailed ? 'failed' : 'done';
        d.store.transition(job.id, final, { prNumber: pr.number, prUrl: pr.url, prState: 'open' });
        const ref = issueRefOf(job);
        await d.source.setStatus(ref, final).catch(() => undefined);
        await d.source
          .comment(
            ref,
            renderDoneComment({ jobId: job.id, prUrl: pr.url, status: final, costUsd: job.costUsd, durationMs: job.durationMs, attempts: job.attempt }),
          )
          .catch(() => undefined);
        if (job.worktreePath && final === 'done') await d.git.removeWorktree(job.repo, job.worktreePath, job.branch ?? undefined).catch(() => undefined);
        d.log.info({ jobId: job.id, pr: pr.url }, 'réconciliation : PR retrouvée');
      } else {
        await requeueOrFail(job, d);
      }
    } catch (err) {
      d.log.error({ err, jobId: job.id }, 'réconciliation : job ignoré');
    }
  }

  await purgeOrphanWorktrees(d);
  await releaseStaleInProgressLabels(d);
}

async function requeueOrFail(job: Job, d: ReconcileDeps): Promise<void> {
  const ref = issueRefOf(job);
  if (job.worktreePath) await d.git.removeWorktree(job.repo, job.worktreePath, job.branch ?? undefined).catch(() => undefined);
  if (job.requeues < MAX_REQUEUES) {
    d.store.transition(job.id, 'queued', {
      requeues: job.requeues + 1, attempt: 0, worktreePath: null, branch: null, baseSha: null, flags: emptyFlags(), error: null,
    });
    await d.source.comment(ref, renderRestartComment()).catch(() => undefined);
    d.log.info({ jobId: job.id }, 'réconciliation : job requeué');
  } else {
    const reason = `interrompu ${MAX_REQUEUES + 1} fois par un redémarrage du daemon`;
    d.store.transition(job.id, 'failed', { error: reason });
    await d.source.comment(ref, renderFailedComment(job.id, reason, d.machine.triggerLabel)).catch(() => undefined);
    await d.source.setStatus(ref, 'failed').catch(() => undefined);
    d.log.warn({ jobId: job.id }, 'réconciliation : job abandonné');
  }
}

/** Supprime les worktrees qui n'appartiennent ni à un job actif ni à un job failed récent. */
export async function purgeOrphanWorktrees(d: ReconcileDeps): Promise<void> {
  const keep = new Set<string>();
  for (const j of d.store.listActive()) {
    // Le pipeline crée le dossier avant d'écrire worktreePath en base : couvrir aussi le chemin calculé.
    keep.add(worktreePath(d.paths, j.repo, j.issueNumber));
    if (j.worktreePath) keep.add(j.worktreePath);
  }
  const cutoff = Date.now() - FAILED_WORKTREE_TTL_DAYS * 86_400_000;
  for (const j of d.store.listByStates(['failed'])) {
    if (j.worktreePath && j.finishedAt && Date.parse(j.finishedAt) > cutoff) keep.add(j.worktreePath);
  }
  let repoDirs: string[] = [];
  try {
    repoDirs = await readdir(d.paths.workDir);
  } catch {
    return;
  }
  for (const repoDir of repoDirs) {
    const repo = repoDir.replace('__', '/');
    let entries: string[] = [];
    try {
      entries = await readdir(join(d.paths.workDir, repoDir));
    } catch {
      continue;
    }
    for (const name of entries) {
      const wt = join(d.paths.workDir, repoDir, name);
      if (keep.has(wt)) continue;
      await d.git.removeWorktree(repo, wt).catch(() => rm(wt, { recursive: true, force: true }));
      d.log.info({ wt }, 'réconciliation : worktree orphelin supprimé');
    }
  }
}

async function releaseStaleInProgressLabels(d: ReconcileDeps): Promise<void> {
  const withPr = new Map<string, Job>();
  for (const j of d.store.listWithOpenPr(PR_LOOKBACK_DAYS)) withPr.set(`${j.repo}#${j.issueNumber}`, j);

  for (const full of d.machine.repos) {
    const repo = parseRepo(full);
    let refs;
    try {
      refs = await d.source.listWithStatus(repo, 'in-progress');
    } catch (err) {
      d.log.warn({ err, repo: full }, 'réconciliation : listWithStatus a échoué');
      continue;
    }
    for (const ref of refs) {
      if (d.store.findActiveByIssue(full, ref.number)) continue;
      const prJob = withPr.get(`${full}#${ref.number}`);
      if (prJob) {
        await d.source.setStatus(ref, prJob.state === 'done' ? 'done' : 'failed').catch(() => undefined);
        d.log.info({ repo: full, issue: ref.number, jobId: prJob.id }, "réconciliation : label in-progress corrigé d'après la PR");
        continue;
      }
      await d.source.setStatus(ref, null).catch(() => undefined);
      await d.source.comment(ref, renderRestartComment()).catch(() => undefined);
      d.log.info({ repo: full, issue: ref.number }, 'réconciliation : label in-progress libéré');
    }
  }
}
