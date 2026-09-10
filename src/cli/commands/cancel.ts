import { createApp } from '../../app.js';
import { ControlClient, DaemonUnreachableError } from '../../daemon/control-client.js';
import type { CommandResult } from '../../daemon/control-types.js';
import { issueRefOf, type IssueSource } from '../../github/source.js';
import { isTerminal, type Job } from '../../store/types.js';
import { resolveJob } from '../resolve-job.js';

export async function cancelCommand(jobId: string): Promise<void> {
  const app = await createApp({ needsAgent: false });
  const job = resolveJob(app.deps.store, jobId);
  if (isTerminal(job.state)) {
    console.log(`Job déjà terminé (${job.state}).`);
    return;
  }
  await cancelJob(job, { client: new ControlClient(app.paths.controlSocketPath), source: app.deps.source });
}

/**
 * Daemon joignable : annulation immédiate par la socket, journalisée. Injoignable : on retire le label
 * trigger, le daemon annulera le job à son prochain contrôle ou à son prochain démarrage. La commande part
 * directement (pas de `ping` préalable : un aller-retour de moins, et un daemon qui s'arrête entre les deux
 * n'est pas une panne). Un refus du daemon lève une erreur : la CLI l'affiche et sort en code 1.
 */
export async function cancelJob(job: Job, deps: { client: ControlClient; source: Pick<IssueSource, 'removeTriggerLabel'> }): Promise<void> {
  let res: CommandResult<Job>;
  try {
    res = await deps.client.send<Job>('cancel', { jobId: job.id }, 'cli');
  } catch (err) {
    if (!(err instanceof DaemonUnreachableError)) throw err;
    await deps.source.removeTriggerLabel(issueRefOf(job));
    console.log(`Label retiré sur ${job.repo}#${job.issueNumber}. Si le daemon tourne, il annulera le job dans la minute ; sinon il l'annulera à son prochain démarrage.`);
    return;
  }
  if (!res.ok) throw new Error(res.error);
  console.log(`Job ${job.id} annulé.`);
}
