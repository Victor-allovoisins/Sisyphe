import type { Logger } from 'pino';
import type { MachineConfig } from '../config/machine.js';
import { renderPermissionDeniedComment } from '../deliver/comments.js';
import { parseRepo, type IssueRef, type IssueSource } from '../github/source.js';
import type { JobStore } from '../store/jobs.js';
import type { Job } from '../store/types.js';

export interface PollDeps {
  source: IssueSource;
  store: JobStore;
  machine: MachineConfig;
  log: Logger;
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
      try {
        const check = await d.source.canTrigger(ref);
        if (!check.ok) {
          d.log.warn({ repo: full, issue: ref.number, login: check.login }, "poll : label posé sans droit d'écriture");
          await d.source.comment(ref, renderPermissionDeniedComment(check.login, d.machine.triggerLabel));
          await d.source.removeTriggerLabel(ref);
          continue;
        }
        const issue = await d.source.getIssue(ref);
        const job = d.store.create({ repo: full, issueNumber: ref.number, issueTitle: issue.title });
        d.log.info({ jobId: job.id, repo: full, issue: ref.number }, 'poll : nouveau job');
        created.push(job);
      } catch (err) {
        d.log.warn({ err, repo: full, issue: ref.number }, 'poll : issue ignorée');
      }
    }
  }
  return created;
}
