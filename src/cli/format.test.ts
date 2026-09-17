import { describe, expect, it } from 'vitest';
import { emptyFlags, type Job } from '../store/types.js';
import { formatJobLine, safeText, summarizeTranscript } from './format.js';

const job: Job = {
  id: '0123456789abcdef', repo: 'acme/demo', issueNumber: 7, issueTitle: 'Titre long', issueKey: null, state: 'done', attempt: 2, requeues: 0,
  branch: null, baseSha: null, worktreePath: null, verdict: null, report: null, flags: emptyFlags(), prNumber: 12,
  prUrl: 'https://github.com/acme/demo/pull/12', prState: 'open', prMergedAt: null, costUsd: 3.456, inputTokens: 0, outputTokens: 0,
  cacheReadTokens: 0, durationMs: 125_000, error: null, createdAt: '2026-09-08T20:00:00Z', startedAt: null, finishedAt: null, updatedAt: '',
};

describe('formatJobLine', () => {
  it('résume un job sur une ligne', () => {
    const line = formatJobLine(job);
    expect(line).toContain('01234567');
    expect(line).toContain('done');
    expect(line).toContain('acme/demo#7');
    expect(line).toContain('$3.46');
    expect(line).toContain('2 min 5 s');
    expect(line).toContain('pull/12');
  });

  it('gère un job sans PR (prUrl null)', () => {
    const line = formatJobLine({ ...job, prNumber: null, prUrl: null, prState: null });
    expect(line).not.toContain('pull/');
    expect(line).toContain('acme/demo#7');
  });

  it('nettoie un titre hostile (échappement ANSI, retour à la ligne) et le tronque', () => {
    const esc = String.fromCharCode(27);
    const hostileTitle = `Titre ${esc}[31mavec un retour\nà la ligne et un texte largement plus long que la largeur d'affichage fixe prévue pour les titres`;
    const line = formatJobLine({ ...job, issueTitle: hostileTitle });
    for (const ch of line) {
      const code = ch.codePointAt(0) ?? 0;
      expect(code <= 0x1f || (code >= 0x7f && code <= 0x9f)).toBe(false);
    }
    expect(line).toContain('…');
  });
});

describe('safeText', () => {
  it('retire les caractères de contrôle, aplatit les blancs et tronque avec …', () => {
    const esc = String.fromCharCode(27);
    expect(safeText(`a${esc}[31mb\n\tc   d`, 100)).toBe('a[31mb c d');
    expect(safeText('abcdef', 4)).toBe('abc…');
    expect(safeText('  déjà propre  ', 100)).toBe('déjà propre');
  });

  it("ne laisse pas de double espace quand un caractère de contrôle isolé est entouré d'espaces", () => {
    const esc = String.fromCharCode(27);
    expect(safeText(`a ${esc} b`, 100)).toBe('a b');
  });
});

describe('summarizeTranscript', () => {
  it('extrait outils, texte et résultat', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Je regarde le code.' }, { type: 'tool_use', name: 'Read', input: { file_path: '/wt/A.swift' } }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'xcodebuild build' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 1.5, num_turns: 3 }),
    ];
    expect(summarizeTranscript(lines)).toEqual([
      '💬 Je regarde le code.',
      '🔧 Read /wt/A.swift',
      '🔧 Bash xcodebuild build',
      '✅ result success · $1.50 · 3 tours',
    ]);
  });

  it('ignore une ligne vide finale et une ligne non-JSON', () => {
    expect(summarizeTranscript(['', 'ceci ne parse pas {', ''])).toEqual([]);
  });

  it('marque un résultat non réussi avec ❌', () => {
    const lines = [JSON.stringify({ type: 'result', subtype: 'error_max_turns', total_cost_usd: 0.2, num_turns: 10 })];
    expect(summarizeTranscript(lines)).toEqual(['❌ result error_max_turns · $0.20 · 10 tours']);
  });

  it('aplatit une commande Bash multi-lignes en une seule ligne', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo a\n  echo b\n  echo c' } }] } }),
    ];
    expect(summarizeTranscript(lines)).toEqual(['🔧 Bash echo a echo b echo c']);
  });

  it('résume un échantillon codex (message, commande, fichier, résultat)', () => {
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't-1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Réfléchit**' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', aggregated_output: '', exit_code: 0, status: 'completed' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }], status: 'completed' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'C’est fini.\nDeux fichiers.' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 5, output_tokens: 20 } }),
    ];
    expect(summarizeTranscript(lines)).toEqual([
      '🔧 bash -lc ls',
      '📝 src/a.ts, src/b.ts',
      '💬 C’est fini. Deux fichiers.',
      '✅ result · coût non communiqué',
    ]);
  });

  it('résume un échantillon opencode (parties texte et outil, formes réelles)', () => {
    const lines = [
      JSON.stringify({ type: 'step_start', sessionID: 'ses-1', part: { type: 'step-start', messageID: 'msg-1' } }),
      JSON.stringify({ type: 'text', sessionID: 'ses-1', part: { type: 'text', text: 'Je regarde.', messageID: 'msg-1' } }),
      JSON.stringify({ type: 'tool_use', sessionID: 'ses-1', part: { type: 'tool', tool: 'bash', callID: 'call-1', state: { status: 'completed', input: { command: 'ls -la' }, title: 'Liste' }, messageID: 'msg-1' } }),
      JSON.stringify({ type: 'tool_use', sessionID: 'ses-1', part: { type: 'tool', tool: 'edit', callID: 'call-2', state: { status: 'completed', input: { filePath: 'src/a.ts' } }, messageID: 'msg-1' } }),
      JSON.stringify({ type: 'step_finish', sessionID: 'ses-1', part: { type: 'step-finish', tokens: { input: 100, output: 20, cache: { read: 0, write: 0 } }, cost: 0.03, messageID: 'msg-1' } }),
    ];
    expect(summarizeTranscript(lines)).toEqual(['💬 Je regarde.', '🔧 bash ls -la', '🔧 edit src/a.ts']);
  });

  it('ignore un événement codex ou opencode inconnu', () => {
    const lines = [
      JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', id: 'item_9' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'web_search', id: 'item_10' } }),
      JSON.stringify({ type: 'session.idle', sessionID: 'ses-1' }),
    ];
    expect(summarizeTranscript(lines)).toEqual([]);
  });
});
