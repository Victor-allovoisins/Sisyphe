import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decideBash } from './bash-guard.js';

/**
 * Hook PreToolUse du backend CLI pour la phase `jira`. Même décision que côté SDK, dans un processus
 * Node autonome. Ferme par défaut : toute anomalie refuse la commande, et on sort toujours en 0 —
 * un `exit 1` serait traité comme une erreur non bloquante, donc un refus manqué.
 */
export function guardBashFromHookInput(raw: string): string | null {
  const deny = (reason: string): string =>
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    });
  try {
    const input = JSON.parse(raw) as { tool_input?: Record<string, unknown> };
    const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : undefined;
    const decision = decideBash(command);
    return decision.allowed ? null : deny(decision.reason);
  } catch (err) {
    return deny(`Garde-fou Sisyphe indisponible, commande refusée : ${err instanceof Error ? err.message : String(err)}`);
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
  const output = guardBashFromHookInput(raw);
  if (output !== null) process.stdout.write(`${output}\n`);
}
