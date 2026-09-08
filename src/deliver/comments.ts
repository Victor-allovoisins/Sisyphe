import type { TriageVerdict } from '../agent/schemas.js';
import { EXAMPLE_REPO_CONFIG, REPO_CONFIG_FILENAME, type RepoConfigErrorKind } from '../config/repo.js';
import { fmtDuration } from '../util/time.js';
import { sanitizeModelText } from './sanitize.js';

export function jobMarker(jobId: string): string {
  return `<!-- sisyphe:job:${jobId} -->`;
}

function relaunch(trigger: string, status: 'blocked' | 'failed'): string {
  return `Pour relancer : répondez dans cette issue si besoin, puis retirez le label \`${trigger}:${status}\` en laissant \`${trigger}\`.`;
}

export function renderTakeoverComment(jobId: string): string {
  return `🪨 Sisyphe a pris cette issue en charge.\n\n${jobMarker(jobId)}`;
}

export function renderConfigProblemComment(kind: RepoConfigErrorKind, message: string, trigger: string): string {
  if (kind === 'invalid') {
    return [
      `🪨 Sisyphe ne peut pas traiter cette issue : ${message}`,
      '',
      `Corrigez \`${REPO_CONFIG_FILENAME}\` sur la branche par défaut du repo.`,
      '',
      relaunch(trigger, 'blocked'),
    ].join('\n');
  }
  return [
    `🪨 Sisyphe ne peut pas traiter cette issue : ${message}.`,
    '',
    `Ajoutez un fichier \`${REPO_CONFIG_FILENAME}\` à la racine de la branche par défaut, par exemple :`,
    '',
    '```yaml',
    EXAMPLE_REPO_CONFIG.trimEnd(),
    '```',
    '',
    relaunch(trigger, 'blocked'),
  ].join('\n');
}

export function renderBlockedComment(verdict: TriageVerdict, trigger: string): string {
  const lines = [
    `🪨 Sisyphe ne démarre pas l'implémentation (verdict : **${verdict.verdict}**, confiance ${Math.round(verdict.confidence * 100)} %).`,
    '',
    sanitizeModelText(verdict.summary),
    '',
  ];
  if (verdict.questions.length) lines.push('Questions :', ...verdict.questions.map((q) => `- ${sanitizeModelText(q)}`), '');
  if (verdict.reasons.length) lines.push('Raisons :', ...verdict.reasons.map((r) => `- ${sanitizeModelText(r)}`), '');
  lines.push(relaunch(trigger, 'blocked'));
  return lines.join('\n');
}

export function renderNoChangesComment(summary: string, trigger: string): string {
  return `🪨 L'agent n'a produit aucun changement.\n\n${sanitizeModelText(summary)}\n\n${relaunch(trigger, 'blocked')}`;
}

export function renderSecretsComment(found: string[], trigger: string): string {
  return [
    "🪨 Sisyphe a détecté des secrets potentiels dans le diff et n'a rien poussé :",
    '',
    ...found.map((f) => `- ${f}`),
    '',
    `Le worktree est conservé 7 jours sur la machine Sisyphe pour inspection. ${relaunch(trigger, 'failed')}`,
  ].join('\n');
}

export function renderFailedComment(jobId: string, message: string, trigger: string): string {
  return `🪨 Sisyphe a échoué : ${message}\n\nJob \`${jobId}\`. ${relaunch(trigger, 'failed')}\n\n${jobMarker(jobId)}`;
}

export function renderCancelledComment(jobId: string): string {
  return `🪨 Job annulé (label retiré ou issue fermée).\n\n${jobMarker(jobId)}`;
}

export function renderDoneComment(i: { prUrl: string; status: 'done' | 'failed'; costUsd: number; durationMs: number; attempts: number }): string {
  const head =
    i.status === 'done'
      ? `🪨 PR prête : ${i.prUrl}`
      : `🪨 La vérification a échoué après ${i.attempts} tentative(s). PR draft pour inspection : ${i.prUrl}`;
  return `${head}\n\nCoût estimé : $${i.costUsd.toFixed(2)} · Durée : ${fmtDuration(i.durationMs)} · Tentatives : ${i.attempts}`;
}

export function renderPermissionDeniedComment(login: string | null, trigger: string): string {
  return `🪨 Label \`${trigger}\` ignoré : ${login ? `@${login}` : 'son auteur'} n'a pas le droit d'écriture sur ce repo.`;
}

export function renderRestartComment(): string {
  return "🪨 Sisyphe a redémarré pendant le traitement ; l'issue est remise dans la file.";
}

export function renderBudgetPauseComment(budgetUsd: number): string {
  return `🪨 Budget quotidien atteint ($${budgetUsd}). Sisyphe reprendra demain.`;
}
