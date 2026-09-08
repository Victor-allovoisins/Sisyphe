import { createApp } from '../../app.js';
import { issueRefOf } from '../../github/source.js';
import { isTerminal } from '../../store/types.js';

/** Retire le label trigger : le daemon annulera le job à son prochain contrôle (60 s au plus). */
export async function cancelCommand(jobId: string): Promise<void> {
  const app = await createApp({ needsAgent: false });
  const job = app.deps.store.listRecent(1000).find((j) => j.id === jobId || j.id.startsWith(jobId));
  if (!job) throw new Error(`Job inconnu : ${jobId}`);
  if (isTerminal(job.state)) {
    console.log(`Job déjà terminé (${job.state}).`);
    return;
  }
  await app.deps.source.removeTriggerLabel(issueRefOf(job));
  console.log(`Label retiré sur ${job.repo}#${job.issueNumber}. Le daemon annulera le job dans la minute.`);
}
