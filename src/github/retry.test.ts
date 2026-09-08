import { describe, expect, it } from 'vitest';
import { isRetryable, rateLimitWaitMs, withRetry } from './retry.js';

const http = (status: number, headers: Record<string, string> = {}) => Object.assign(new Error(`HTTP ${status}`), { status, response: { headers } });

describe('withRetry', () => {
  it('réessaie sur 5xx puis réussit', async () => {
    let n = 0;
    const sleeps: number[] = [];
    const r = await withRetry(async () => { n++; if (n < 3) throw http(503); return 'ok'; }, { sleep: async (ms) => { sleeps.push(ms); }, baseDelayMs: 100 });
    expect(r).toBe('ok');
    expect(sleeps).toEqual([100, 200]);
  });
  it('ne réessaie pas sur 404', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw http(404); }, { sleep: async () => {} })).rejects.toThrow('HTTP 404');
    expect(n).toBe(1);
  });
  it('attend la fin du rate limit', async () => {
    const now = 1_000_000_000_000;
    const reset = String(Math.floor(now / 1000) + 30);
    let n = 0;
    const sleeps: number[] = [];
    await withRetry(async () => { n++; if (n === 1) throw http(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }); }, { sleep: async (ms) => { sleeps.push(ms); }, now: () => now });
    expect(sleeps).toEqual([31_000]);
  });
  it('helpers', () => {
    expect(isRetryable(http(500))).toBe(true);
    expect(isRetryable(http(422))).toBe(false);
    expect(isRetryable(new Error('ECONNRESET'))).toBe(true);
    expect(rateLimitWaitMs(http(429, { 'retry-after': '5' }), 0)).toBe(5000);
    expect(rateLimitWaitMs(http(403), 0)).toBeNull();
  });
});
