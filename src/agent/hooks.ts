import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { matchProtectedPaths } from '../verify/flags.js';
import { decideBash } from './bash-guard.js';

export type PathDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Décide si l'agent peut écrire `filePath`. Comparaison lexicale : ne suit pas les liens symboliques
 * (la vraie barrière contre une évasion par symlink est le sandbox, hors périmètre de ce hook).
 * Refuse hors du worktree, dans `.git` (le worktree git y stocke le lien vers le miroir et Sisyphe y
 * fait ses propres opérations) et sur les chemins protégés déclarés dans sisyphe.yml.
 */
export function decidePath(worktreePath: string, filePath: string | undefined, protectedPatterns: string[]): PathDecision {
  if (!worktreePath) throw new Error('decidePath : worktreePath vide');
  if (!filePath) return { allowed: false, reason: 'Écriture sans chemin cible refusée' };
  const root = resolve(worktreePath);
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const rel = relative(root, abs);
  if (rel === '..' || rel.startsWith(`..${sep}`)) return { allowed: false, reason: `Écriture hors du worktree refusée : ${filePath}` };
  const low = rel.toLowerCase();
  if (low === '.git' || low.startsWith(`.git${sep}`)) return { allowed: false, reason: `Écriture dans .git refusée : ${rel}` };
  if (matchProtectedPaths([rel], protectedPatterns).length > 0) return { allowed: false, reason: `Chemin protégé par sisyphe.yml : ${rel}` };
  return { allowed: true };
}

/** Hook PreToolUse pour Edit et Write : seconde barrière derrière les règles d'outils. Ferme par défaut. */
export function pathGuardHook(worktreePath: string, protectedPatterns: string[]): HookCallback {
  if (!worktreePath) throw new Error('pathGuardHook : worktreePath vide');
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;
    const decision = decidePath(worktreePath, filePath, protectedPatterns);
    if (decision.allowed) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    };
  };
}

/**
 * Hook PreToolUse pour Bash dans la phase `jira` : seul `sisyphe jira …` passe (voir `decideBash`).
 * Ferme par défaut, comme `pathGuardHook` — un `tool_input` sans commande est un refus.
 */
export function bashGuardHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const command = typeof toolInput.command === 'string' ? toolInput.command : undefined;
    const decision = decideBash(command);
    if (decision.allowed) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    };
  };
}
