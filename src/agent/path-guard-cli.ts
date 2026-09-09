import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decidePath } from './hooks.js';

/**
 * Hook PreToolUse du backend CLI : même décision que `pathGuardHook` (backend SDK), mais dans un
 * processus Node autonome lancé par `claude`, qui reçoit l'entrée du hook sur stdin et lit le worktree
 * et les motifs protégés dans l'environnement. Aucun import du SDK ici (le type importé par `hooks.ts`
 * est un `import type`, effacé à la compilation) : le script doit démarrer même sans le SDK installé.
 *
 * Ferme par défaut : toute anomalie (stdin illisible, JSON invalide, variables absentes) refuse l'écriture.
 * Un `exit 1` serait au contraire une erreur non bloquante côté Claude Code, donc un refus manqué : on
 * sort toujours en 0 en écrivant la décision sur stdout.
 */
export function guardFromHookInput(raw: string, env: NodeJS.ProcessEnv): string | null {
  const deny = (reason: string): string =>
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    });
  try {
    const input = JSON.parse(raw) as { tool_input?: Record<string, unknown> };
    const filePath = typeof input.tool_input?.file_path === 'string' ? input.tool_input.file_path : undefined;
    const patterns: unknown = JSON.parse(env.SISYPHE_GUARD_PROTECTED ?? '[]');
    if (!Array.isArray(patterns)) throw new Error('SISYPHE_GUARD_PROTECTED : tableau JSON attendu');
    const decision = decidePath(env.SISYPHE_GUARD_WORKTREE ?? '', filePath, patterns.map(String));
    return decision.allowed ? null : deny(decision.reason);
  } catch (err) {
    return deny(`Garde-fou Sisyphe indisponible, écriture refusée : ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  stream.setEncoding('utf8');
  let data = '';
  for await (const chunk of stream) data += chunk;
  return data;
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const raw = await readAll(process.stdin).catch(() => '');
  const output = guardFromHookInput(raw, process.env);
  if (output !== null) process.stdout.write(`${output}\n`);
}
