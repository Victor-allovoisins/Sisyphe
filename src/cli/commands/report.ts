import { createApp } from '../../app.js';
import { buildReport, parseSince, renderReportMarkdown } from '../../report/report.js';

export async function reportCommand(opts: { since: string; repo?: string }): Promise<void> {
  const app = await createApp({ needsAgent: false });
  const since = parseSince(opts.since);
  const jobs = app.deps.store.listSince(since, opts.repo);
  console.log(renderReportMarkdown(buildReport(jobs, since)));
}
