import { createApp } from '../../app.js';
import { issueRefOf } from '../../github/source.js';
import { isTerminal } from '../../store/types.js';
import { resolveJob } from '../resolve-job.js';

/** Retire le label trigger : le daemon (s'il tourne) annulera le job à son prochain contrôle, sinon à son prochain démarrage. */
export async function cancelCommand(jobId: string): Promise<void> {
  const app = await createApp({ needsAgent: false });
  const job = resolveJob(app.deps.store, jobId);
  if (isTerminal(job.state)) {
    console.log(`Job déjà terminé (${job.state}).`);
    return;
  }
  await app.deps.source.removeTriggerLabel(issueRefOf(job));
  console.log(`Label retiré sur ${job.repo}#${job.issueNumber}. Si le daemon tourne, il annulera le job dans la minute ; sinon il l'annulera à son prochain démarrage.`);
}
