import type { TriageVerdict } from '../agent/schemas.js';
import { EXAMPLE_REPO_CONFIG, REPO_CONFIG_FILENAME, type RepoConfigErrorKind } from '../config/repo.js';
import { statusLabelName } from '../github/labels.js';
import { fmtDuration } from '../util/time.js';
import { sanitizeModelText } from './sanitize.js';

export function jobMarker(jobId: string): string {
  return `<!-- sisyphe:job:${jobId} -->`;
}

/**
 * Comment reprendre la main dépend du traqueur, pas du message : sur GitHub on retire un label, sur Jira on
 * réassigne le ticket. Passer le descriptif plutôt que le nom du label évite d'imprimer, sur un ticket Jira,
 * une consigne qui ne veut rien dire pour son lecteur.
 */
export type Relaunch = { kind: 'label'; trigger: string } | { kind: 'assignee'; who: string };

export const labelRelaunch = (trigger: string): Relaunch => ({ kind: 'label', trigger });

function relaunch(r: Relaunch, status: 'blocked' | 'failed'): string {
  if (r.kind === 'assignee') {
    return `Pour relancer : répondez dans ce ticket si besoin, puis réassignez-le à \`${r.who}\`.`;
  }
  return `Pour relancer : répondez dans cette issue si besoin, puis retirez le label \`${statusLabelName(r.trigger, status)}\` en laissant \`${r.trigger}\`.`;
}

export function renderConfigProblemComment(kind: RepoConfigErrorKind, message: string, trigger: Relaunch): string {
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

/**
 * Le ticket n'indique pas sur quoi brancher. Message à l'intention de son auteur, pas d'un développeur :
 * il dit quoi renseigner, pas pourquoi git ne sait pas quoi faire.
 */
export function renderMissingVersionComment(reason: string, trigger: Relaunch): string {
  return [
    "🪨 Sisyphe ne sait pas sur quelle version corriger ce ticket.",
    '',
    reason.charAt(0).toUpperCase() + reason.slice(1) + '.',
    '',
    relaunch(trigger, 'blocked'),
  ].join('\n');
}

export function renderBlockedComment(verdict: TriageVerdict, trigger: Relaunch): string {
  const lines = ['🪨 Sisyphe met cette issue en pause.', '', sanitizeModelText(verdict.note || verdict.summary, { multiline: true }), ''];
  if (verdict.verdict === 'needs_clarification' && verdict.questions.length) {
    lines.push('Pour avancer :', ...verdict.questions.map((q) => `- ${sanitizeModelText(q)}`), '');
  }
  lines.push(relaunch(trigger, 'blocked'));
  return lines.join('\n');
}

export function renderNoChangesComment(summary: string, trigger: Relaunch): string {
  return `🪨 L'agent n'a produit aucun changement.\n\n${sanitizeModelText(summary)}\n\n${relaunch(trigger, 'blocked')}`;
}

const WORKTREE_REMOVED = 'Le worktree est supprimé ; le dossier `jobs/<id>/` de la machine Sisyphe garde le matériel de post-mortem (transcripts, logs, diff).';

export function renderSecretsComment(found: string[], trigger: Relaunch): string {
  return [
    "🪨 Sisyphe a détecté des secrets potentiels dans le diff et n'a rien poussé :",
    '',
    ...found.map((f) => `- ${f}`),
    '',
    `${WORKTREE_REMOVED} ${relaunch(trigger, 'failed')}`,
  ].join('\n');
}

export function renderProtectedPathsComment(found: string[], trigger: Relaunch): string {
  return [
    "🪨 Sisyphe a détecté des chemins protégés modifiés dans le diff et n'a rien poussé :",
    '',
    ...found.map((f) => `- ${f}`),
    '',
    `${WORKTREE_REMOVED} ${relaunch(trigger, 'failed')}`,
  ].join('\n');
}

export function renderFailedComment(jobId: string, message: string, trigger: Relaunch): string {
  // La sortie de `commands.setup` et les noms de fichiers choisis par l'agent finissent ici : texte non fiable.
  return `🪨 Sisyphe a échoué : ${sanitizeModelText(message, { multiline: true })}\n\nJob \`${jobId}\`. ${relaunch(trigger, 'failed')}\n\n${jobMarker(jobId)}`;
}

export function renderCancelledComment(jobId: string): string {
  return `🪨 Job annulé (label retiré ou issue fermée).\n\n${jobMarker(jobId)}`;
}

export function renderDoneComment(i: { jobId: string; prUrl: string; status: 'done' | 'failed'; costUsd: number; durationMs: number; attempts: number }): string {
  const head =
    i.status === 'done'
      ? `🪨 PR prête : ${i.prUrl}`
      : `🪨 La vérification a échoué après ${i.attempts} tentative(s). PR draft pour inspection : ${i.prUrl}`;
  return `${head}\n\nCoût estimé : $${i.costUsd.toFixed(2)} · Durée : ${fmtDuration(i.durationMs)} · Tentatives : ${i.attempts}\n\n${jobMarker(i.jobId)}`;
}

export function renderPermissionDeniedComment(login: string | null, trigger: Relaunch): string {
  const who = login ? `@${login}` : 'son auteur';
  if (trigger.kind === 'assignee') return `🪨 Assignation ignorée : ${who} n'a pas le droit de confier ce ticket à Sisyphe.`;
  return `🪨 Label \`${trigger.trigger}\` ignoré : ${who} n'a pas le droit d'écriture sur ce repo.`;
}

export function renderRestartComment(): string {
  return "🪨 Sisyphe a redémarré pendant le traitement ; l'issue est remise dans la file.";
}

export function renderBudgetPauseComment(budgetUsd: number): string {
  return `🪨 Budget quotidien atteint ($${budgetUsd.toFixed(2)}). Sisyphe reprendra demain.`;
}
