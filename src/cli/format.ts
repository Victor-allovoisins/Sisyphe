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
  // Un caractère de contrôle entouré d'espaces (ex. "a  b" après retrait d'un octet isolé) peut
  // laisser un double espace : un second aplatissement referme cette fenêtre avant le trim final.
  const cleaned = stripped.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, Math.max(0, max - 1))}…` : cleaned;
}

export function formatJobLine(j: Job): string {
  const pr = j.prUrl ? ` · ${j.prUrl}` : '';
  const title = safeText(j.issueTitle, 48);
  return `${j.id.slice(0, 8)}  ${j.state.padEnd(12)} ${j.repo}#${j.issueNumber} · ${title} · $${j.costUsd.toFixed(2)} · ${fmtDuration(j.durationMs)} · ${j.attempt} tentative(s)${pr}`;
}

type Json = Record<string, unknown>;

const asString = (v: unknown): string => (typeof v === 'string' ? v : '');
const asObject = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `item.completed` de codex : message assistant, commande exécutée ou fichiers modifiés. */
function summarizeCodexItem(item: Json | null, out: string[]): void {
  if (!item) return;
  // Les formes `item.completed` viennent du schéma codex-rs, pas d'une capture : un run réussi n'a pas
  // pu être obtenu sur la machine (quota ChatGPT). La lecture reste tolérante en attendant un échantillon.
  const type = asString(item.type);
  if (type === 'agent_message') {
    const text = asString(item.text);
    if (text.trim()) out.push(`💬 ${safeText(text, 200)}`);
  } else if (type === 'command_execution') {
    const command = asString(item.command);
    if (command.trim()) out.push(`🔧 ${safeText(command, 160)}`.trimEnd());
  } else if (type === 'file_change') {
    // codex rend `{ changes: [{ path, kind }] }` (cf. codex-rs exec_events.rs) : on n'affiche que les chemins.
    const paths = asArray(item.changes)
      .map((change) => asString(asObject(change)?.path))
      .filter(Boolean);
    if (paths.length > 0) out.push(`📝 ${safeText(paths.join(', '), 200)}`);
  }
}

/**
 * Parties `part` du flux opencode (`--format json`, épinglé sur 1.18) : `part.type` vaut `text` ou
 * `tool`, l'outil porte `part.tool` et son entrée dans `part.state.input` (clé variable selon l'outil :
 * `command`, `filePath`, `pattern`…), d'où la lecture tolérante de plusieurs clés.
 */
function summarizeOpenCodePart(part: Json | null, out: string[]): void {
  if (!part) return;
  if (part.type === 'text') {
    const text = asString(part.text);
    if (text.trim()) out.push(`💬 ${safeText(text, 200)}`);
  } else if (part.type === 'tool') {
    const name = asString(part.tool);
    const state = asObject(part.state);
    const input = asObject(state?.input) ?? {};
    const target = asString(input.command ?? input.filePath ?? input.file_path ?? input.path ?? input.pattern ?? state?.title);
    out.push(`🔧 ${[name, target].filter(Boolean).join(' ')}`.trimEnd());
  }
}

/** Résumé lisible d'un transcript JSONL : messages Claude, événements codex, parties opencode. */
export function summarizeTranscript(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    if (msg.type === 'assistant') {
      for (const block of asArray(asObject(msg.message)?.content)) {
        const b = asObject(block);
        if (!b) continue;
        if (b.type === 'text' && asString(b.text).trim()) out.push(`💬 ${safeText(asString(b.text), 200)}`);
        if (b.type === 'tool_use') {
          const i = asObject(b.input) ?? {};
          const target = (i.file_path ?? i.command ?? i.pattern ?? i.path ?? '') as string;
          out.push(`🔧 ${b.name} ${safeText(String(target), 160)}`.trimEnd());
        }
      }
    } else if (msg.type === 'result') {
      const subtype = asString(msg.subtype);
      const cost = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : 0;
      const turns = typeof msg.num_turns === 'number' ? msg.num_turns : 0;
      out.push(`${subtype === 'success' ? '✅' : '❌'} result ${subtype} · $${cost.toFixed(2)} · ${turns} tours`);
    } else if (msg.type === 'item.completed') {
      summarizeCodexItem(asObject(msg.item), out);
    } else if (msg.type === 'turn.completed') {
      // codex sur abonnement : le coût n'est pas communiqué (cf. §8 du design).
      out.push('✅ result · coût non communiqué');
    } else {
      summarizeOpenCodePart(asObject(msg.part), out);
    }
  }
  return out;
}
