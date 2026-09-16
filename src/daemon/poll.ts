import type { Logger } from 'pino';
import type { MachineConfig } from '../config/machine.js';
import { renderPermissionDeniedComment } from '../deliver/comments.js';
import { relaunchFor } from '../jobs/relaunch.js';
import { parseRepo, type IssueRef, type IssueTracker } from '../github/source.js';
import type { JobStore } from '../store/jobs.js';
import type { Job } from '../store/types.js';

export interface PollDeps {
  source: IssueTracker;
  store: JobStore;
  machine: MachineConfig;
  log: Logger;
}

/**
 * Issues `blocked` dont le dernier commentaire est une réponse (pas la nôtre) d'un compte avec accès write :
 * on retire le statut pour qu'elles redeviennent candidates au `pollOnce` qui suit. À appeler avant lui.
 */
export async function resumeBlocked(d: PollDeps): Promise<void> {
  for (const full of d.machine.repos) {
    const repo = parseRepo(full);
    let refs: IssueRef[];
    try {
      refs = await d.source.listWithStatus(repo, 'blocked');
    } catch (err) {
      d.log.warn({ err, repo: full }, 'resumeBlocked : listWithStatus a échoué');
      continue;
    }
    for (const ref of refs) {
      try {
        if (await d.source.resumeIfCommented(ref)) d.log.info({ repo: full, issue: ref.number }, 'resumeBlocked : relancée sur commentaire');
      } catch (err) {
        d.log.warn({ err, repo: full, issue: ref.number }, 'resumeBlocked : issue ignorée');
      }
    }
  }
}

/** Un cycle de détection : les issues candidates deviennent des jobs `queued`. */
export async function pollOnce(d: PollDeps): Promise<Job[]> {
  const created: Job[] = [];
  for (const full of d.machine.repos) {
    const repo = parseRepo(full);
    let candidates: IssueRef[];
    try {
      candidates = await d.source.listCandidates(repo);
    } catch (err) {
      d.log.warn({ err, repo: full }, 'poll : listCandidates a échoué');
      continue;
    }
    for (const ref of candidates) {
      if (d.store.findActiveByIssue(full, ref.number)) continue;
      let step: 'canTrigger' | 'refuse' | 'getIssue' | 'create' = 'canTrigger';
      try {
        const check = await d.source.canTrigger(ref);
        if (!check.ok) {
          d.log.warn({ repo: full, issue: ref.number, login: check.login }, "poll : label posé sans droit d'écriture");
          step = 'refuse';
          await d.source.removeTriggerLabel(ref);
          await d.source.comment(ref, renderPermissionDeniedComment(check.login, relaunchFor(d.machine, full)));
          continue;
        }
        step = 'getIssue';
        const issue = await d.source.getIssue(ref);
        step = 'create';
        const job = d.store.create({ repo: full, issueNumber: ref.number, issueTitle: issue.title });
        d.log.info({ jobId: job.id, repo: full, issue: ref.number }, 'poll : nouveau job');
        created.push(job);
      } catch (err) {
        d.log.warn({ err, repo: full, issue: ref.number, step }, 'poll : issue ignorée');
      }
    }
  }
  return created;
}
