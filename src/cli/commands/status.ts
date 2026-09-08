import { createApp } from '../../app.js';
import { formatJobLine } from '../format.js';

export async function statusCommand(): Promise<void> {
  const app = await createApp({ needsAgent: false });
  const active = app.deps.store.listActive();
  const recent = app.deps.store.listRecent(20).filter((j) => !active.some((a) => a.id === j.id));
  if (active.length === 0 && recent.length === 0) {
    console.log('Aucun job.');
    return;
  }
  console.log(`Actifs (${active.length}) :`);
  for (const j of active) console.log(`  ${formatJobLine(j)}`);
  console.log(`\nRécents :`);
  for (const j of recent) console.log(`  ${formatJobLine(j)}`);
}
