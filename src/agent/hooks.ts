import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { isAbsolute, relative, resolve } from 'node:path';
import { matchProtectedPaths } from '../verify/flags.js';

export type PathDecision = { allowed: true } | { allowed: false; reason: string };

export function decidePath(worktreePath: string, filePath: string | undefined, protectedPatterns: string[]): PathDecision {
  if (!filePath) return { allowed: true };
  const root = resolve(worktreePath);
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return { allowed: false, reason: `Écriture hors du worktree refusée : ${filePath}` };
  if (matchProtectedPaths([rel], protectedPatterns).length > 0) return { allowed: false, reason: `Chemin protégé par sisyphe.yml : ${rel}` };
  return { allowed: true };
}

/** Hook PreToolUse pour Edit et Write : seconde barrière derrière les règles d'outils. */
export function pathGuardHook(worktreePath: string, protectedPatterns: string[]): HookCallback {
  return async (input) => {
    const pre = input as PreToolUseHookInput;
    const toolInput = (pre.tool_input ?? {}) as Record<string, unknown>;
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
