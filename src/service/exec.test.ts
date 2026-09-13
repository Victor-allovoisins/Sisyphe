import { describe, expect, it } from 'vitest';
import { EXIT_NOT_FOUND, realExec } from './exec.js';

describe('realExec', () => {
  it('un exécutable introuvable rend exitCode 127 et un stderr explicatif, sans rejeter', async () => {
    const r = await realExec('/nonexistent/sisyphe-binaire-absent', ['--version']);
    expect(r.exitCode).toBe(EXIT_NOT_FOUND);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/ENOENT/);
  });

  it('un code de sortie non nul remonte tel quel avec la sortie', async () => {
    const r = await realExec(process.execPath, ['-e', 'console.log("out"); console.error("err"); process.exit(3)']);
    expect(r).toEqual({ exitCode: 3, stdout: 'out', stderr: 'err' });
  });
});
