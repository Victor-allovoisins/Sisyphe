import { JOB_STATES, isTerminal, type Job, type JobState } from '../store/types.js';
import { fmtDuration } from '../util/time.js';

export interface ReportStats {
  since: string;
  total: number;
  byState: Record<JobState, number>;
  finished: number;
  withPr: number;
  merged: number;
  prOpenedRate: number;
  prMergedRate: number;
  totalCostUsd: number;
  medianCostUsd: number;
  medianDurationMs: number;
  avgAttempts: number;
  recentFailures: Array<{ id: string; repo: string; issueNumber: number; error: string | null }>;
}

/** `12h`, `30d`, `2w` → ISO. */
export function parseSince(text: string, now: Date = new Date()): string {
  const m = /^(\d+)([hdw])$/.exec(text.trim());
  if (!m) throw new Error(`Durée invalide : ${text} (attendu par exemple 12h, 30d, 2w)`);
  const n = Number(m[1]);
  const ms = m[2] === 'h' ? 3_600_000 : m[2] === 'd' ? 86_400_000 : 7 * 86_400_000;
  return new Date(now.getTime() - n * ms).toISOString();
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function buildReport(jobs: Job[], sinceIso: string): ReportStats {
  const byState = Object.fromEntries(JOB_STATES.map((s) => [s, 0])) as Record<JobState, number>;
  for (const j of jobs) byState[j.state]++;
  const finished = jobs.filter((j) => isTerminal(j.state) && j.state !== 'cancelled');
  const withPr = finished.filter((j) => j.prNumber !== null);
  const merged = withPr.filter((j) => j.prMergedAt !== null);
  const delivered = jobs.filter((j) => j.state === 'done' || j.state === 'failed');
  return {
    since: sinceIso,
    total: jobs.length,
    byState,
    finished: finished.length,
    withPr: withPr.length,
    merged: merged.length,
    prOpenedRate: finished.length ? withPr.length / finished.length : 0,
    prMergedRate: withPr.length ? merged.length / withPr.length : 0,
    totalCostUsd: jobs.reduce((s, j) => s + j.costUsd, 0),
    medianCostUsd: median(delivered.map((j) => j.costUsd)),
    medianDurationMs: median(delivered.map((j) => j.durationMs)),
    avgAttempts: delivered.length ? delivered.reduce((s, j) => s + j.attempt, 0) / delivered.length : 0,
    recentFailures: jobs
      .filter((j) => j.state === 'failed')
      .slice(-5)
      .reverse()
      .map((j) => ({ id: j.id, repo: j.repo, issueNumber: j.issueNumber, error: j.error })),
  };
}

export function renderReportMarkdown(s: ReportStats): string {
  const pct = (x: number) => `${Math.round(x * 100)} %`;
  const lines = [
    `# Sisyphe — rapport depuis ${s.since.slice(0, 10)}`,
    '',
    `- Jobs : ${s.total}`,
    `- Terminés (hors annulés) : ${s.finished}`,
    `- PR ouvertes : ${s.withPr} (${pct(s.prOpenedRate)} des jobs terminés)`,
    `- PR mergées : ${s.merged} (${pct(s.prMergedRate)} des PR ouvertes)`,
    `- Coût total : $${s.totalCostUsd.toFixed(2)} · médian par job livré : $${s.medianCostUsd.toFixed(2)}`,
    `- Durée médiane par job livré : ${fmtDuration(s.medianDurationMs)}`,
    `- Tentatives moyennes : ${s.avgAttempts.toFixed(1)}`,
    '',
    '## Par état',
    '',
    ...JOB_STATES.filter((st) => s.byState[st] > 0).map((st) => `- ${st} : ${s.byState[st]}`),
  ];
  if (s.recentFailures.length) {
    lines.push('', '## Derniers échecs', '', ...s.recentFailures.map((f) => `- ${f.repo}#${f.issueNumber} (${f.id.slice(0, 8)}) : ${f.error ?? 'sans détail'}`));
  }
  return lines.join('\n');
}
