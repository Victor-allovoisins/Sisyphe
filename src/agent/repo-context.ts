import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Fichiers d'instructions du repo lus par Sisyphe, dans l'ordre ; concaténés s'il y en a plusieurs. */
export const REPO_CONTEXT_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md'];

/** Contenu des fichiers d'instructions présents à la racine du worktree, ou chaîne vide. */
export async function readRepoContext(worktreePath: string): Promise<string> {
  const parts: string[] = [];
  for (const name of REPO_CONTEXT_FILES) {
    try {
      const text = await readFile(join(worktreePath, name), 'utf8');
      if (text.trim()) parts.push(`## ${name}\n\n${text.trim()}`);
    } catch {
      /* absent */
    }
  }
  return parts.join('\n\n');
}
