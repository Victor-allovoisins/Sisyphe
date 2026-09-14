import { execa } from 'execa';
import { appendFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/**
 * Socle commun aux backends CLI : lance un binaire, lit son stdout en lignes JSONL, sérialise les
 * écritures du transcript et borne le run. Le sous-processus tourne dans son propre groupe
 * (`detached`) : au timeout ou à l'annulation, tout le groupe est tué, jamais seulement la tête.
 * Chaque objet JSON est ajouté au transcript puis passé à `onLine` ; une ligne illisible est
 * conservée telle quelle sous `sisyphe_raw`. `onStderr` reçoit les mêmes données que celles
 * ajoutées au transcript (`{ type: 'stderr' }`), pour les backends qui veulent les interpréter.
 */

/** Délai entre le SIGTERM du groupe et le SIGKILL, puis marge d'attente avant d'abandonner le processus. */
const KILL_GRACE_MS = 5000;
const STDERR_TAIL_LINES = 20;

export interface RunCliProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  transcriptPath: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Appelé pour chaque objet JSON du flux, après écriture au transcript. */
  onLine: (line: Record<string, unknown>) => void;
  /** Appelé pour chaque morceau de stderr, en plus de l'anneau interne et du transcript. */
  onStderr?: (data: string) => void;
}

export interface RunCliProcessResult {
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
  /** Message d'échec de lancement (binaire absent), sans recopier la ligne de commande. */
  failure: string;
  /** Anneau des dernières lignes non vides de stderr. */
  stderrTail: string;
}

/**
 * Suffixe des fichiers écrits par appel, dérivé du nom du transcript (`transcript-implement-2.jsonl`
 * → `implement-2`) : deux phases d'un même job ne s'écrasent pas, et le nom reste stable d'un
 * redémarrage du daemon à l'autre — ce qu'un compteur porté par l'instance du runner ne garantit pas.
 */
export function callSlug(transcriptPath: string): string {
  const base = basename(transcriptPath).replace(/\.jsonl$/, '');
  return base.replace(/^transcript-?/, '') || base || 'run';
}

const delay = (ms: number) => new Promise<void>((resolve) => void setTimeout(resolve, ms).unref());

export async function runCliProcess(o: RunCliProcessOptions): Promise<RunCliProcessResult> {
  // Écritures du transcript sérialisées : l'ordre des lignes doit être celui du flux.
  let writes: Promise<void> = Promise.resolve();
  const append = (line: unknown): void => {
    let text: string;
    try {
      text = JSON.stringify(line);
    } catch {
      text = JSON.stringify({ type: 'sisyphe_unserializable' });
    }
    writes = writes.then(() => appendFile(o.transcriptPath, `${text}\n`).catch(() => undefined));
  };

  // Refus de lancer si l'annulation est déjà effective : ni transcript, ni processus.
  if (o.signal.aborted) {
    return { exitCode: -1, timedOut: false, aborted: true, failure: '', stderrTail: '' };
  }

  const subprocess = execa(o.bin, o.args, {
    cwd: o.cwd,
    env: o.env,
    extendEnv: false,
    reject: false,
    buffer: false,
    detached: true,
    input: o.stdin,
  });

  const outDecoder = new StringDecoder('utf8');
  let pending = '';
  // Une ligne illisible ou JSON non objet est conservée brute : rien à extraire, mais le transcript
  // doit rester fidèle au flux (`sisyphe logs --raw`), et déréférencer un `null` planterait le handler.
  const handleLine = (line: string): void => {
    if (line.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      append({ type: 'sisyphe_raw', data: line });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      append({ type: 'sisyphe_raw', data: line });
      return;
    }
    append(parsed);
    o.onLine(parsed as Record<string, unknown>);
  };
  subprocess.stdout?.on('data', (chunk: Buffer | string) => {
    const parts = (pending + (typeof chunk === 'string' ? chunk : outDecoder.write(chunk))).split('\n');
    pending = parts.pop() ?? '';
    for (const line of parts) handleLine(line);
  });

  // stderr : le transcript garde tout, la mémoire ne garde qu'un anneau des dernières lignes
  // (une session qui bavarde pendant une heure ne doit pas grossir indéfiniment dans le daemon).
  const errDecoder = new StringDecoder('utf8');
  const stderrRing: string[] = [];
  let stderrPending = '';
  const pushStderr = (data: string): void => {
    const parts = (stderrPending + data).split('\n');
    stderrPending = parts.pop() ?? '';
    for (const line of parts) if (line.trim() !== '') stderrRing.push(line);
    if (stderrRing.length > STDERR_TAIL_LINES) stderrRing.splice(0, stderrRing.length - STDERR_TAIL_LINES);
  };
  subprocess.stderr?.on('data', (chunk: Buffer | string) => {
    const data = typeof chunk === 'string' ? chunk : errDecoder.write(chunk);
    if (data === '') return;
    pushStderr(data);
    append({ type: 'stderr', data });
    o.onStderr?.(data);
  });

  // `settled` = la promesse execa a rendu la main (processus sorti ET stdio fermés). On ne regarde
  // JAMAIS la seule sortie de la tête : le BIN peut sortir en laissant un descendant qui garde
  // stdout ouvert, auquel cas il reste bel et bien un groupe à tuer et une attente à borner.
  let settled = false;
  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  let resolveKilled: () => void = () => undefined;
  const killed = new Promise<void>((resolve) => {
    resolveKilled = resolve;
  });
  const killGroup = (): void => {
    if (settled || !subprocess.pid) return;
    try {
      process.kill(-subprocess.pid, 'SIGTERM');
    } catch {
      /* groupe déjà terminé */
    }
    killTimer = setTimeout(() => {
      if (settled || !subprocess.pid) return;
      try {
        process.kill(-subprocess.pid, 'SIGKILL');
      } catch {
        /* groupe déjà terminé */
      }
    }, KILL_GRACE_MS);
    killTimer.unref();
    resolveKilled();
  };
  const timer = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    killGroup();
  }, o.timeoutMs);
  const onAbort = () => killGroup();
  o.signal.addEventListener('abort', onAbort, { once: true });

  let exitCode = -1;
  let failure = '';
  try {
    // Après un kill on n'attend pas indéfiniment : SIGKILL au bout de KILL_GRACE_MS, puis abandon.
    const outcome = await Promise.race([
      subprocess.then((r) => {
        settled = true;
        return r;
      }),
      killed.then(() => delay(KILL_GRACE_MS * 2)).then(() => null),
    ]);
    if (outcome) {
      exitCode = outcome.exitCode ?? -1;
      // Échec de lancement (binaire absent, permissions) : garder le binaire et le code, pas l'argv complet.
      if (outcome.failed && outcome.exitCode === undefined) {
        failure = `${o.bin} : ${(outcome as { code?: string }).code ?? 'échec du lancement'}`;
      }
    }
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    o.signal.removeEventListener('abort', onAbort);
    // Jamais de processus orphelin, même si la course ci-dessus a expiré.
    if (!settled && subprocess.pid) {
      try {
        process.kill(-subprocess.pid, 'SIGKILL');
      } catch {
        /* groupe déjà terminé */
      }
    }
    subprocess.stdout?.destroy();
    subprocess.stderr?.destroy();
  }
  if (pending !== '') handleLine(pending);
  if (stderrPending !== '') pushStderr('\n');
  await writes;

  return { exitCode, timedOut, aborted: o.signal.aborted, failure, stderrTail: stderrRing.join('\n') };
}
