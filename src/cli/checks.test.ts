import { describe, expect, it } from 'vitest';
import { firstWord, runChecks } from './checks.js';

describe('checks', () => {
  it('firstWord', () => {
    expect(firstWord('  xcodebuild build -scheme X')).toBe('xcodebuild');
    expect(firstWord('sh build.sh')).toBe('sh');
  });
  it('runChecks agrège succès et échecs', async () => {
    const r = await runChecks([
      { name: 'a', run: async () => 'ok' },
      { name: 'b', run: async () => { throw new Error('cassé'); } },
    ]);
    expect(r.ok).toBe(false);
    expect(r.lines).toEqual(['✅ a : ok', '❌ b : cassé']);
  });
});
