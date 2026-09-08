import type { Job } from '../store/types.js';
import { fmtDuration } from '../util/time.js';

export function formatJobLine(j: Job): string {
  const pr = j.prUrl ? ` · ${j.prUrl}` : '';
  return `${j.id.slice(0, 8)}  ${j.state.padEnd(12)} ${j.repo}#${j.issueNumber} · ${j.issueTitle} · $${j.costUsd.toFixed(2)} · ${fmtDuration(j.durationMs)} · ${j.attempt} tentative(s)${pr}`;
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
        if (block.type === 'text' && block.text?.trim()) out.push(`💬 ${block.text.trim().slice(0, 200)}`);
        if (block.type === 'tool_use') {
          const i = block.input ?? {};
          const target = (i.file_path ?? i.command ?? i.pattern ?? i.path ?? '') as string;
          out.push(`🔧 ${block.name} ${String(target).slice(0, 160)}`.trimEnd());
        }
      }
    } else if (msg.type === 'result') {
      out.push(`${msg.subtype === 'success' ? '✅' : '❌'} result ${msg.subtype} · $${(msg.total_cost_usd ?? 0).toFixed(2)} · ${msg.num_turns ?? 0} tours`);
    }
  }
  return out;
}
