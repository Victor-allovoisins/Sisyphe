import { describe, expect, it, vi } from 'vitest';
import { firstWord, installHint, runChecks, which, whichOrHint } from './checks.js';

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
  it("runChecks : run() peut renvoyer { warn: true, message } sans lever, sans faire échouer ok", async () => {
    const r = await runChecks([
      { name: 'a', run: async () => ({ warn: true as const, message: 'dégradé' }) },
      { name: 'b', run: async () => 'ok' },
    ]);
    expect(r.ok).toBe(true);
    expect(r.lines).toEqual(['⚠️ a : dégradé', '✅ b : ok']);
  });
  it('which : réussit sur un binaire présent, lève sur un binaire absent', async () => {
    await expect(which('sh')).resolves.toContain('sh');
    await expect(which('binaire-inexistant-xyz')).rejects.toThrow('introuvable sur le PATH');
  });
  it('installHint : la commande de la plateforme, rien ailleurs ni pour un outil inconnu', () => {
    expect(installHint('gitleaks', 'darwin')).toBe('brew install gitleaks');
    expect(installHint('gitleaks', 'linux')).toBe('https://github.com/gitleaks/gitleaks/releases');
    expect(installHint('claude', 'linux')).toBe('npm install -g @anthropic-ai/claude-code');
    expect(installHint('gitleaks', 'freebsd')).toBeNull();
    expect(installHint('xcodebuild', 'darwin')).toBeNull();
  });
  it('whichOrHint : l’échec cite la consigne d’installation, ou reste brut sans consigne connue', async () => {
    await expect(whichOrHint('sh', 'darwin')).resolves.toContain('sh');
    // PATH vidé : plus aucun binaire joignable, `git` échoue à coup sûr.
    vi.stubEnv('PATH', '/sisyphe-aucun-binaire');
    try {
      await expect(whichOrHint('git', 'darwin')).rejects.toThrow('git introuvable sur le PATH — installer : brew install git');
      await expect(whichOrHint('git', 'linux')).rejects.toThrow('sudo apt-get install -y git');
      await expect(whichOrHint('xcodebuild', 'darwin')).rejects.toThrow(/^xcodebuild introuvable sur le PATH$/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
