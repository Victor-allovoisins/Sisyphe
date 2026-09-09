import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { execa } from 'execa';
import { appendFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { zeroUsage } from '../store/types.js';
import type { AgentResult, AgentRunOptions, AgentRunner } from './runner.js';
import { summarizeResult } from './sdk-runner.js';

/**
 * Backend agent « cli » : lance la CLI Claude Code installée sur la machine (`claude -p`) au lieu du
 * Agent SDK, pour utiliser l'abonnement claude.ai plutôt qu'une clé API. Mêmes garde-fous que le
 * backend SDK, exprimés en arguments de ligne de commande :
 * - `--setting-sources ""` + `--strict-mcp-config` : aucun réglage user/project/local, aucun serveur MCP
 *   (ni hooks perso, ni CLAUDE.md du repo — le CLAUDE.md est injecté par Sisyphe dans le system prompt) ;
 * - `--tools` (liste blanche stricte) doublé de `--allowedTools` (auto-approbation) et `--disallowedTools` ;
 * - `--permission-mode dontAsk --permission-prompts none` : rien ne peut demander une validation humaine ;
 * - `--settings` : le seul hook PreToolUse autorisé est le garde-fou de chemins de Sisyphe.
 * Le sous-processus tourne dans son propre groupe (`detached`) : au timeout ou à l'annulation, tout le
 * groupe est tué, jamais seulement le `claude` de tête.
 */
export interface CliRunnerConfig {
  /** Binaire à lancer. Défaut `claude`, résolu sur le PATH de `o.env` (pas celui du daemon). */
  claudeBin?: string;
  /** Script Node du hook de garde. Défaut : `path-guard-cli.js` à côté de ce module (donc `dist/agent/`). */
  hookScript?: string;
}

const HOOK_TIMEOUT_SECONDS = 15;
/** Délai entre le SIGTERM du groupe et le SIGKILL, puis marge d'attente avant d'abandonner le processus. */
const KILL_GRACE_MS = 5000;
const STDERR_TAIL_LINES = 20;

/**
 * Contenu de `--settings`. La commande cite le chemin et utilise le node courant plutôt que `node` :
 * sous launchd le PATH est minimal, et un hook qui ne démarre pas sort en 1, ce que Claude Code traite
 * comme une erreur NON bloquante — le garde-fou disparaîtrait en silence.
 */
export function buildCliSettings(hookScript: string, nodeBin: string = process.execPath): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Edit|Write',
          hooks: [{ type: 'command', command: `"${nodeBin}" "${hookScript}"`, timeout: HOOK_TIMEOUT_SECONDS }],
        },
      ],
    },
  };
}

export function buildCliArgs(o: AgentRunOptions, files: { appendPath: string; settingsPath?: string }): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    // Chaîne vide = aucune source de réglages chargée ; --strict-mcp-config coupe en plus les serveurs MCP,
    // que --setting-sources ne couvre pas (aucun --mcp-config n'est passé, donc zéro serveur).
    '--setting-sources', '',
    '--strict-mcp-config',
  ];
  if (files.settingsPath) args.push('--settings', files.settingsPath);
  // `--tools ""` est la façon documentée de n'autoriser aucun outil : une liste vide ne doit pas
  // faire disparaître le drapeau, ce serait « tous les outils ».
  args.push('--tools', ...(o.allowedTools.length ? o.allowedTools : ['']));
  if (o.allowedTools.length) args.push('--allowedTools', ...o.allowedTools);
  if (o.disallowedTools.length) args.push('--disallowedTools', ...o.disallowedTools);
  args.push('--model', o.model);
  args.push('--max-turns', String(o.maxTurns));
  args.push('--max-budget-usd', String(o.maxBudgetUsd));
  args.push('--append-system-prompt-file', files.appendPath);
  if (o.outputSchema) args.push('--json-schema', JSON.stringify(o.outputSchema));
  if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
  return args;
}

/** Le `result` de la CLI a la forme d'un `SDKResultMessage` ; on garantit juste `usage` avant de le passer à summarizeResult. */
function asResultMessage(raw: Record<string, unknown>): SDKResultMessage {
  const usage = (raw.usage ?? {}) as Record<string, unknown>;
  return { ...raw, usage: { input_tokens: 0, output_tokens: 0, ...usage } } as unknown as SDKResultMessage;
}

const delay = (ms: number) => new Promise<void>((resolve) => void setTimeout(resolve, ms).unref());

export class CliAgentRunner implements AgentRunner {
  private readonly claudeBin: string;
  private readonly hookScript: string;
  private calls = 0;

  constructor(cfg: CliRunnerConfig = {}) {
    this.claudeBin = cfg.claudeBin ?? 'claude';
    this.hookScript = cfg.hookScript ?? fileURLToPath(new URL('./path-guard-cli.js', import.meta.url));
  }

  async run<T>(o: AgentRunOptions): Promise<AgentResult<T>> {
    const started = Date.now();
    if (o.signal.aborted) {
      return summarizeResult<T>({ result: null, sessionId: null, error: null, timedOut: false, aborted: true, floor: zeroUsage(), durationMs: 0, transcriptPath: o.transcriptPath });
    }

    const n = ++this.calls;
    const dir = dirname(o.transcriptPath);
    const appendPath = join(dir, `system-append-${n}.md`);
    await writeFile(appendPath, o.systemPromptAppend);
    let settingsPath: string | undefined;
    if (o.pathGuard) {
      settingsPath = join(dir, `cli-settings-${n}.json`);
      await writeFile(settingsPath, `${JSON.stringify(buildCliSettings(this.hookScript), null, 2)}\n`);
    }

    // o.env est déjà l'environnement épuré de l'agent (HOME et PATH compris : `claude` en a besoin
    // pour lire ~/.claude). On n'étend pas process.env, on ajoute seulement les variables du garde-fou.
    const env: Record<string, string> = { ...o.env };
    if (o.pathGuard) {
      env.SISYPHE_GUARD_WORKTREE = o.pathGuard.worktreePath;
      env.SISYPHE_GUARD_PROTECTED = JSON.stringify(o.pathGuard.protectedPatterns);
    }

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

    let result: SDKResultMessage | null = null;
    let sessionId: string | null = null;
    // Plancher d'usage reconstitué depuis les messages assistant (dédoublonnés par id), si le result manque.
    const floor = zeroUsage();
    const seen = new Set<string>();
    const onLine = (line: string): void => {
      if (line.trim() === '') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        append({ type: 'sisyphe_raw', data: line });
        return;
      }
      append(parsed);
      const m = parsed as { type?: string; subtype?: string; session_id?: string; parent_tool_use_id?: unknown; message?: { id?: string; usage?: Record<string, number> } };
      if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') sessionId = m.session_id;
      if (m.type === 'assistant' && !m.parent_tool_use_id && m.message?.id && !seen.has(m.message.id)) {
        seen.add(m.message.id);
        const u = m.message.usage ?? {};
        floor.inputTokens += u.input_tokens ?? 0;
        floor.outputTokens += u.output_tokens ?? 0;
        floor.cacheReadTokens += u.cache_read_input_tokens ?? 0;
        floor.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
      }
      if (m.type === 'result') {
        result = asResultMessage(parsed as Record<string, unknown>);
        if (typeof m.session_id === 'string') sessionId = m.session_id;
      }
    };

    const subprocess = execa(this.claudeBin, buildCliArgs(o, { appendPath, settingsPath }), {
      cwd: o.cwd,
      env,
      extendEnv: false,
      reject: false,
      buffer: false,
      detached: true,
      input: o.prompt,
    });

    const outDecoder = new StringDecoder('utf8');
    let pending = '';
    subprocess.stdout?.on('data', (chunk: Buffer | string) => {
      pending += typeof chunk === 'string' ? chunk : outDecoder.write(chunk);
      let idx = pending.indexOf('\n');
      while (idx >= 0) {
        onLine(pending.slice(0, idx));
        pending = pending.slice(idx + 1);
        idx = pending.indexOf('\n');
      }
    });
    const errDecoder = new StringDecoder('utf8');
    const stderrChunks: string[] = [];
    subprocess.stderr?.on('data', (chunk: Buffer | string) => {
      const data = typeof chunk === 'string' ? chunk : errDecoder.write(chunk);
      if (data === '') return;
      stderrChunks.push(data);
      append({ type: 'stderr', data });
    });

    let exited = false;
    subprocess.nodeChildProcess.once('exit', () => {
      exited = true;
    });
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    let resolveKilled: () => void = () => undefined;
    const killed = new Promise<void>((resolve) => {
      resolveKilled = resolve;
    });
    const killGroup = (): void => {
      if (exited || !subprocess.pid) return;
      try {
        process.kill(-subprocess.pid, 'SIGTERM');
      } catch {
        /* groupe déjà terminé */
      }
      killTimer = setTimeout(() => {
        if (exited || !subprocess.pid) return;
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
      if (exited) return;
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
        subprocess.then((r) => r),
        killed.then(() => delay(KILL_GRACE_MS * 2)).then(() => null),
      ]);
      if (outcome) {
        exitCode = outcome.exitCode ?? -1;
        if (outcome.failed && outcome.exitCode === undefined) failure = outcome.message ?? '';
      }
    } finally {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      o.signal.removeEventListener('abort', onAbort);
      // Jamais de `claude` orphelin, même si la course ci-dessus a expiré.
      if (!exited && subprocess.pid) {
        try {
          process.kill(-subprocess.pid, 'SIGKILL');
        } catch {
          /* groupe déjà terminé */
        }
      }
      subprocess.stdout?.destroy();
      subprocess.stderr?.destroy();
    }
    if (pending !== '') onLine(pending);
    await writes;

    const tail = stderrChunks.join('').split('\n').filter((l) => l.trim() !== '').slice(-STDERR_TAIL_LINES).join('\n');
    const aborted = o.signal.aborted;
    const error =
      result || timedOut || aborted
        ? null
        : new Error(`claude s'est arrêté sans result (code ${exitCode})${tail ? ` : ${tail}` : failure ? ` : ${failure}` : ''}`);

    return summarizeResult<T>({ result, sessionId, error, timedOut, aborted, floor, durationMs: Date.now() - started, transcriptPath: o.transcriptPath });
  }
}
