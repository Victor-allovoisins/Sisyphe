import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoContext } from './repo-context.js';

describe('readRepoContext', () => {
  it('concatène les fichiers présents dans l’ordre', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-ctx-'));
    await writeFile(join(dir, 'CLAUDE.md'), '# Racine\n');
    await mkdir(join(dir, '.claude'));
    await writeFile(join(dir, '.claude', 'CLAUDE.md'), 'Sous-dossier\n');
    const ctx = await readRepoContext(dir);
    expect(ctx.indexOf('## CLAUDE.md')).toBeLessThan(ctx.indexOf('## .claude/CLAUDE.md'));
    expect(ctx).toContain('# Racine');
    expect(ctx).toContain('Sous-dossier');
  });
  it('renvoie une chaîne vide sans fichier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-ctx-'));
    expect(await readRepoContext(dir)).toBe('');
  });
});
