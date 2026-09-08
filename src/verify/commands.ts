import { execa } from 'execa';
import { writeFile } from 'node:fs/promises';

export interface CommandResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

/**
 * Exécute une commande shell du repo cible. `detached` crée un groupe de
 * processus : au timeout ou à l'annulation on tue tout le groupe, pas seulement
 * le `sh`, sinon un xcodebuild orphelin continuerait à tourner.
 */
export async function runRepoCommand(
  command: string,
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number; logFile?: string; signal?: AbortSignal },
): Promise<CommandResult> {
  const started = Date.now();
  const subprocess = execa('sh', ['-c', command], {
    cwd: opts.cwd,
    env: opts.env,
    extendEnv: false,
    reject: false,
    all: true,
    detached: true,
    stripFinalNewline: false,
  });
  let timedOut = false;
  let cancelled = false;
  const killGroup = () => {
    try {
      if (subprocess.pid) process.kill(-subprocess.pid, 'SIGKILL');
    } catch {
      /* groupe déjà terminé */
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup();
  }, opts.timeoutMs);
  const onAbort = () => {
    cancelled = true;
    killGroup();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });

  const result = await subprocess;
  clearTimeout(timer);
  opts.signal?.removeEventListener('abort', onAbort);

  const output = typeof result.all === 'string' ? result.all : '';
  const exitCode = result.exitCode ?? -1;
  if (opts.logFile) {
    await writeFile(opts.logFile, `$ ${command}\n${output}\n[exit ${exitCode}${timedOut ? ', timeout' : ''}${cancelled ? ', annulé' : ''}]\n`);
  }
  return { exitCode, output, timedOut, cancelled, durationMs: Date.now() - started };
}

/** Environnement des commandes du repo et de l'agent : celui du daemon plus les variables SISYPHE_*. */
export function repoEnv(base: NodeJS.ProcessEnv, extra: { cacheDir: string; issueNumber: number; branch: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env.SISYPHE_CACHE_DIR = extra.cacheDir;
  env.SISYPHE_ISSUE_NUMBER = String(extra.issueNumber);
  env.SISYPHE_BRANCH = extra.branch;
  env.CI = '1';
  return env;
}
