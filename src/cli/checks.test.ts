import { describe, expect, it } from 'vitest';
import { firstWord, runChecks, which } from './checks.js';

describe('checks', () => {
  it('firstWord', () => {
    expect(firstWord('  xcodebuild build -scheme X')).toBe('xcodebuild');
    expect(firstWord('sh build.sh')).toBe('sh');
  });
  it('firstWord ignore les préfixes VAR=valeur et une quote englobante', () => {
    expect(firstWord('FOO=bar cmd --x')).toBe('cmd');
    expect(firstWord('FOO=bar BAZ=qux cmd')).toBe('cmd');
    expect(firstWord('"my tool" --x')).toBe('my tool');
    expect(firstWord('')).toBe('');
  });
  it('runChecks agrège succès et échecs', async () => {
    const r = await runChecks([
      { name: 'a', run: async () => 'ok' },
      { name: 'b', run: async () => { throw new Error('cassé'); } },
    ]);
    expect(r.ok).toBe(false);
    expect(r.lines).toEqual(['✅ a : ok', '❌ b : cassé']);
  });
  it("runChecks : un échec en warn s'affiche en ⚠️ et ne fait pas échouer ok", async () => {
    const r = await runChecks([
      { name: 'a', run: async () => { throw new Error('mineur'); }, warn: true },
    ]);
    expect(r.ok).toBe(true);
    expect(r.lines).toEqual(['⚠️ a : mineur']);
  });
  it('which : réussit sur un binaire présent, lève sur un binaire absent', async () => {
    await expect(which('sh')).resolves.toContain('sh');
    await expect(which('binaire-inexistant-xyz')).rejects.toThrow('introuvable sur le PATH');
  });
});
