import type { Job } from '../store/types.js';
import { fmtDuration } from '../util/time.js';

/** Contrôle C0 (codes 0x00 à 0x1F) ou C1 (0x7F, et 0x80 à 0x9F) : jamais affiché tel quel (ANSI, retours arrière, etc.). */
function isControlCodePoint(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * Nettoie une chaîne d'origine externe (titre d'issue, transcript de l'agent) avant affichage terminal :
 * retire les caractères de contrôle C0/C1, aplatit les suites de blancs (dont les retours à la ligne)
 * en un seul espace, puis tronque à `max` caractères avec un « … » final.
 */
export function safeText(s: string, max: number): string {
  // Les blancs (dont les retours à la ligne) sont aplatis en espace avant le retrait des caractères de
  // contrôle : sinon un saut de ligne entre deux mots disparaîtrait sans laisser de séparateur.
  const collapsed = s.replace(/\s+/g, ' ');
  let stripped = '';
  for (const ch of collapsed) {
    if (!isControlCodePoint(ch.codePointAt(0) ?? 0)) stripped += ch;
  }
  const cleaned = stripped.trim();
  return cleaned.length > max ? `${cleaned.slice(0, Math.max(0, max - 1))}…` : cleaned;
}

export function formatJobLine(j: Job): string {
  const pr = j.prUrl ? ` · ${j.prUrl}` : '';
  const title = safeText(j.issueTitle, 48);
  return `${j.id.slice(0, 8)}  ${j.state.padEnd(12)} ${j.repo}#${j.issueNumber} · ${title} · $${j.costUsd.toFixed(2)} · ${fmtDuration(j.durationMs)} · ${j.attempt} tentative(s)${pr}`;
}

type Block = { type: string; text?: string; name?: string; input?: Record<string, unknown> };

/** Résumé lisible d'un transcript JSONL : texte de l'assistant, outils appelés, résultat. */
export function summarizeTranscript(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let msg: { type?: string; subtype?: string; message?: { content?: Block[] }; total_cost_usd?: number; num_turns?: number };
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === 'assistant') {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) out.push(`💬 ${safeText(block.text, 200)}`);
        if (block.type === 'tool_use') {
          const i = block.input ?? {};
          const target = (i.file_path ?? i.command ?? i.pattern ?? i.path ?? '') as string;
          out.push(`🔧 ${block.name} ${safeText(String(target), 160)}`.trimEnd());
        }
      }
    } else if (msg.type === 'result') {
      out.push(`${msg.subtype === 'success' ? '✅' : '❌'} result ${msg.subtype} · $${(msg.total_cost_usd ?? 0).toFixed(2)} · ${msg.num_turns ?? 0} tours`);
    }
  }
  return out;
}
