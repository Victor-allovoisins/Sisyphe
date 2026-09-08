import { describe, expect, it } from 'vitest';
import { emptyFlags, type Job } from '../store/types.js';
import { formatJobLine, summarizeTranscript } from './format.js';

const job: Job = {
  id: '0123456789abcdef', repo: 'acme/demo', issueNumber: 7, issueTitle: 'Titre long', state: 'done', attempt: 2, requeues: 0,
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
});
