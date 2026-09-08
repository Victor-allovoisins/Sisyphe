import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { summarizeResult } from './sdk-runner.js';

const base = {
  type: 'result', duration_ms: 100, duration_api_ms: 90, is_error: false, num_turns: 4, stop_reason: null,
  total_cost_usd: 1.25, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 },
  modelUsage: {}, permission_denials: [], uuid: 'u', session_id: 'sess',
};
const success = { ...base, subtype: 'success', result: 'ok', structured_output: { a: 1 } } as unknown as SDKResultMessage;
const maxTurns = { ...base, subtype: 'error_max_turns', errors: [] } as unknown as SDKResultMessage;
const common = { sessionId: 'sess', error: null, timedOut: false, aborted: false, durationMs: 100, transcriptPath: '/t.jsonl' };

describe('summarizeResult', () => {
  it('mappe un succès avec sortie structurée', () => {
    const r = summarizeResult<{ a: number }>({ ...common, result: success });
    expect(r.output).toEqual({ a: 1 });
    expect(r.stopReason).toBe('completed');
    expect(r.costUsd).toBe(1.25);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheCreationTokens: 1 });
    expect(r.numTurns).toBe(4);
    expect(r.sessionId).toBe('sess');
  });
  it('un succès sans structured_output donne output null', () => {
    const r = summarizeResult({ ...common, result: { ...success, structured_output: undefined } as SDKResultMessage });
    expect(r.output).toBeNull();
    expect(r.stopReason).toBe('completed');
  });
  it('mappe les arrêts pour limite', () => {
    expect(summarizeResult({ ...common, result: maxTurns }).stopReason).toBe('max_turns');
    expect(summarizeResult({ ...common, result: { ...maxTurns, subtype: 'error_max_budget_usd' } as SDKResultMessage }).stopReason).toBe('max_budget');
    expect(summarizeResult({ ...common, result: { ...maxTurns, subtype: 'error_during_execution' } as SDKResultMessage }).stopReason).toBe('error');
  });
  it('priorise abort et timeout, et survit sans result', () => {
    expect(summarizeResult({ ...common, result: success, aborted: true }).stopReason).toBe('aborted');
    expect(summarizeResult({ ...common, result: null, timedOut: true, error: new Error('x') }).stopReason).toBe('timeout');
    const r = summarizeResult({ ...common, result: null, error: new Error('boom') });
    expect(r.stopReason).toBe('error');
    expect(r.errorMessage).toBe('boom');
    expect(r.costUsd).toBe(0);
    expect(r.output).toBeNull();
  });
});
