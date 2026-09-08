import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../../app.js';
import { jobDir } from '../../config/paths.js';
import { summarizeTranscript } from '../format.js';

export async function logsCommand(jobId: string, opts: { phase?: string; raw?: boolean }): Promise<void> {
  const app = await createApp({ needsAgent: false });
  const job = app.deps.store.listRecent(1000).find((j) => j.id === jobId || j.id.startsWith(jobId));
  if (!job) throw new Error(`Job inconnu : ${jobId}`);
  const dir = jobDir(app.paths, job.id);
  const files = (await readdir(dir).catch(() => [] as string[])).sort();
  console.log(`Job ${job.id} · ${job.repo}#${job.issueNumber} · ${job.state}`);
  for (const f of files) {
    if (opts.phase && !f.includes(opts.phase)) continue;
    const text = await readFile(join(dir, f), 'utf8');
    console.log(`\n=== ${f} ===`);
    if (f.endsWith('.jsonl') && !opts.raw) console.log(summarizeTranscript(text.split('\n')).join('\n'));
    else console.log(text);
  }
}
