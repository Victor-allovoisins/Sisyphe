import { execa } from 'execa';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CommandResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  /** Le début de la sortie a été jeté pour rester sous MAX_OUTPUT_BYTES. */
  truncated: boolean;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  logFile?: string;
  signal?: AbortSignal;
  /** Délai accordé après un kill du groupe à un petit-fils qui aurait changé de groupe en gardant stdout ouvert. Défaut 5 s. */
  killGraceMs?: number;
}

/** On garde la fin de la sortie : c'est là que sont les erreurs. */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 5000;

/**
 * Exécute une commande shell du repo cible dans son propre groupe de processus (`detached`) :
 * au timeout ou à l'annulation, tout le groupe reçoit SIGKILL, pas seulement le `sh`.
 * La sortie est lue en flux et bornée. Après un kill, on n'attend pas plus de `killGraceMs`.
 */
export async function runRepoCommand(command: string, opts: RunOptions): Promise<CommandResult> {
  const started = Date.now();
  const subprocess = execa('sh', ['-c', command], {
    cwd: opts.cwd,
    env: opts.env,
    extendEnv: false,
    reject: false,
    all: true,
    buffer: false,
    detached: true,
    stdin: 'ignore',
  });

  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  subprocess.all?.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
    size += chunk.length;
    while (size > MAX_OUTPUT_BYTES && chunks.length > 1) {
      size -= chunks.shift()!.length;
      truncated = true;
    }
  });

  let exited = false;
  let timedOut = false;
  let cancelled = false;
  let resolveKilled: () => void = () => undefined;
  const killed = new Promise<void>((resolve) => {
    resolveKilled = resolve;
  });
  subprocess.nodeChildProcess.once('exit', () => {
    exited = true;
  });
  const killGroup = () => {
    if (exited || !subprocess.pid) return;
    try {
      process.kill(-subprocess.pid, 'SIGKILL');
    } catch {
      /* groupe déjà terminé */
    }
    resolveKilled();
  };
  const timer = setTimeout(() => {
    if (exited) return;
    timedOut = true;
    killGroup();
  }, opts.timeoutMs);
  const onAbort = () => {
    if (exited) return;
    cancelled = true;
    killGroup();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });

  const grace = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const exitCode = await Promise.race([
    subprocess.then((r) => r.exitCode ?? -1),
    killed.then(() => new Promise<number>((resolve) => setTimeout(() => resolve(-1), grace))),
  ]);
  clearTimeout(timer);
  opts.signal?.removeEventListener('abort', onAbort);
  subprocess.all?.destroy();

  const output = Buffer.concat(chunks).toString('utf8');
  if (opts.logFile) {
    const tags = [`exit ${exitCode}`, timedOut && 'timeout', cancelled && 'annulé', truncated && 'sortie tronquée'].filter(Boolean).join(', ');
    const sep = output === '' || output.endsWith('\n') ? '' : '\n';
    try {
      await mkdir(dirname(opts.logFile), { recursive: true });
      await writeFile(opts.logFile, `$ ${command}\n${output}${sep}[${tags}]\n`);
    } catch {
      /* un log inaccessible ne doit pas faire échouer la commande */
    }
  }
  return { exitCode, output, timedOut, cancelled, truncated, durationMs: Date.now() - started };
}

/** Variables du daemon jamais transmises aux commandes du repo : elles donneraient un accès que le spec interdit. */
const STRIPPED_ENV = new Set(['SSH_AUTH_SOCK', 'GITHUB_TOKEN', 'GH_TOKEN', 'NPM_TOKEN', 'ANTHROPIC_API_KEY']);

/** Environnement des commandes du repo (setup, build, test, lint) : celui du daemon épuré, plus les variables SISYPHE_*. */
export function repoEnv(base: NodeJS.ProcessEnv, extra: { cacheDir: string; issueNumber: number; branch: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !STRIPPED_ENV.has(k)) env[k] = v;
  env.SISYPHE_CACHE_DIR = extra.cacheDir;
  env.SISYPHE_ISSUE_NUMBER = String(extra.issueNumber);
  env.SISYPHE_BRANCH = extra.branch;
  env.CI = 'true';
  return env;
}

/** Environnement de l'agent : comme repoEnv, plus la clé API dont le SDK a besoin (exposition connue, spec §9). */
export function agentEnv(base: NodeJS.ProcessEnv, extra: { cacheDir: string; issueNumber: number; branch: string }): Record<string, string> {
  const env = repoEnv(base, extra);
  if (base.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = base.ANTHROPIC_API_KEY;
  return env;
}
