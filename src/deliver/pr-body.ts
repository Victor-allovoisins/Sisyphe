import type { ImplementationReport } from '../agent/schemas.js';
import type { Job, Phase } from '../store/types.js';
import { fmtDuration } from '../util/time.js';
import type { VerifyResult, VerifyStep } from '../verify/verify.js';
import { jobMarker } from './comments.js';
import { sanitizeCodeSpan, sanitizeModelText } from './sanitize.js';

export interface PrBodyInput {
  job: Job;
  report: ImplementationReport;
  verify: VerifyResult;
  phases: Phase[];
  prTemplate: string | null;
  costUsd: number;
  durationMs: number;
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`);

const STEP_LABEL: Record<VerifyStep['status'], (s: VerifyStep) => string> = {
  ok: (s) => `✅ ok (${fmtDuration(s.durationMs)})`,
  failed: (s) => `❌ code ${s.exitCode} (${fmtDuration(s.durationMs)})`,
  timeout: (s) => `⏱️ délai de vérification dépassé après ${fmtDuration(s.durationMs)}`,
  skipped: () => '⏭️ non exécutée (étape précédente en échec ou délai de vérification épuisé)',
};

/** Copie du rapport dont tout texte venant du modèle est passé par sanitizeModelText. */
export function sanitizeReport(r: ImplementationReport): ImplementationReport {
  const s = (text: string) => sanitizeModelText(text);
  return {
    ...r,
    summary: sanitizeModelText(r.summary, { multiline: true }),
    changes: r.changes.map((c) => ({ file: sanitizeCodeSpan(c.file), what: s(c.what) })),
    decisions: r.decisions.map(s),
    tests_run: r.tests_run.map(s),
    risks: r.risks.map(s),
    follow_ups: r.follow_ups.map(s),
  };
}

export function renderPrBody(i: PrBodyInput): string {
  const { job, verify } = i;
  const report = sanitizeReport(i.report);
  const lines: string[] = ['## Résumé', '', report.summary, ''];

  if (report.changes.length) lines.push('## Changements', '', ...report.changes.map((c) => `- \`${c.file}\` : ${c.what}`), '');
  if (report.decisions.length) lines.push('## Décisions', '', ...bullets(report.decisions), '');

  lines.push('## Tests', '', "Exécutés par l'agent :", '');
  lines.push(...(report.tests_run.length ? bullets(report.tests_run) : ['- aucun déclaré']), '');
  lines.push('Vérification indépendante par Sisyphe :', '');
  lines.push(...verify.steps.map((s) => `- ${s.name} : ${STEP_LABEL[s.status](s)}`), '');

  const attention: string[] = [];
  if (job.flags.verificationFailed) attention.push(`⚠️ La vérification a échoué après ${job.attempt} tentative(s) : PR en draft pour inspection.`);
  if (job.flags.protectedPathsTouched.length) attention.push(`⚠️ Chemins protégés modifiés : ${job.flags.protectedPathsTouched.map((p) => `\`${p}\``).join(', ')}`);
  if (job.flags.largeDiff) attention.push(`⚠️ Diff volumineux : ${verify.changedLines} lignes modifiées.`);
  if (job.flags.earlyStop) attention.push(`⚠️ L'agent s'est arrêté avant la fin : ${job.flags.earlyStop}.`);
  if (verify.driftedFiles.length) {
    const shown = verify.driftedFiles.slice(0, 20).map((f) => `\`${f}\``).join(', ');
    const more = verify.driftedFiles.length > 20 ? ` et ${verify.driftedFiles.length - 20} autres` : '';
    attention.push(`ℹ️ La vérification (setup/build/test) a modifié des fichiers suivis, non inclus dans ce commit : ${shown}${more}.`);
  }
  attention.push(...report.risks);
  if (attention.length) lines.push("## Points d'attention", '', ...bullets(attention), '');

  if (report.follow_ups.length) lines.push('## Suites à donner', '', ...bullets(report.follow_ups), '');

  lines.push('## Sisyphe', '');
  for (const p of i.phases.filter((p) => p.name === 'triage' || p.name === 'implement')) {
    lines.push(`- ${p.name} (tentative ${p.attempt}, ${p.model ?? '?'}) : $${p.costUsd.toFixed(2)}, ${p.numTurns} tours`);
  }
  lines.push(`- Total : $${i.costUsd.toFixed(2)}, ${fmtDuration(i.durationMs)}, ${job.attempt} tentative(s)`, '');
  lines.push(`Closes #${job.issueNumber}`, '', jobMarker(job.id));
  // Le template vient du worktree après le passage de l'agent (fichier PR template versionné, possiblement modifié) : il n'est pas de confiance.
  if (i.prTemplate?.trim()) lines.push('', '---', '', sanitizeModelText(i.prTemplate.trim(), { multiline: true }));
  return lines.join('\n');
}
