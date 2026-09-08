import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../../app.js';
import { jobDir } from '../../config/paths.js';
import { tail } from '../../util/text.js';
import { parseGitleaksReport } from '../../verify/secrets.js';
import { summarizeTranscript } from '../format.js';
import { resolveJob } from '../resolve-job.js';

const TAIL_LINES = 40;

/** Une ligne de stat plutôt que le patch entier : nombre de lignes ajoutées/retirées, hors en-têtes `+++`/`---`. */
function renderDiffStat(text: string): string {
  let added = 0;
  let removed = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return `+${added}/-${removed} (${text.length} octets)`;
}

/** Une ligne par finding : fichier, règle, ligne. Jamais Match ni Secret (le rapport brut de gitleaks les contient). */
function renderGitleaksSummary(text: string): string {
  try {
    const findings = parseGitleaksReport(text);
    if (findings.length === 0) return '(aucun finding)';
    return findings.map((f) => `${f.file} · ${f.ruleId} · ligne ${f.line}`).join('\n');
  } catch (err) {
    return `(rapport gitleaks illisible : ${(err as Error).message})`;
  }
}

/**
 * Affiche le contenu d'un dossier de job. Mode résumé par défaut, jamais de fichier brut : un
 * gitleaks.json contient le secret trouvé (champs Match/Secret) et ne doit jamais atterrir tel quel
 * sur un terminal ou dans une capture de logs. `--raw` (opts.raw) lève cette garde explicitement.
 */
export async function renderJobLogs(dir: string, opts: { phase?: string; raw?: boolean }): Promise<void> {
  const files = (await readdir(dir).catch(() => [] as string[])).sort();
  for (const f of files) {
    if (opts.phase && !f.includes(opts.phase)) continue;
    const text = await readFile(join(dir, f), 'utf8');
    console.log(`\n=== ${f} ===`);
    if (opts.raw) {
      console.log(text);
    } else if (f.endsWith('.jsonl')) {
      console.log(summarizeTranscript(text.split('\n')).join('\n'));
    } else if (f === 'gitleaks.json') {
      console.log(renderGitleaksSummary(text));
    } else if (f === 'diff.patch') {
      console.log(renderDiffStat(text));
    } else {
      // verify-*.log, setup.log, et tout fichier non reconnu : les 40 dernières lignes, jamais le brut intégral.
      console.log(tail(text, TAIL_LINES));
    }
  }
}

export async function logsCommand(jobId: string, opts: { phase?: string; raw?: boolean }): Promise<void> {
  const app = await createApp({ needsAgent: false });
  const job = resolveJob(app.deps.store, jobId);
  const dir = jobDir(app.paths, job.id);
  console.log(`Job ${job.id} · ${job.repo}#${job.issueNumber} · ${job.state}`);
  await renderJobLogs(dir, opts);
}
