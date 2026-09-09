import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { execa } from 'execa';
import { appendFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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
 *
 * La parité avec le backend SDK n'est pas totale : il n'y a pas d'équivalent en ligne de commande de
 * `managedSettings.strictPluginOnlyCustomization`, et `--setting-sources ""` ne couvre que les réglages
 * user/project/local — des managed settings (MDM) resteraient chargés et pourraient ajouter des hooks.
 * Le garde-fou de chemins reste donc, ici, la seule barrière côté hooks que Sisyphe contrôle.
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
 * Suffixe des fichiers écrits par appel, dérivé du nom du transcript (`transcript-implement-2.jsonl`
 * → `implement-2`) : deux phases d'un même job ne s'écrasent pas, et le nom reste stable d'un
 * redémarrage du daemon à l'autre — ce qu'un compteur porté par l'instance du runner ne garantit pas.
 */
export function callSlug(transcriptPath: string): string {
  const base = basename(transcriptPath).replace(/\.jsonl$/, '');
  return base.replace(/^transcript-?/, '') || base || 'run';
}

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

  constructor(cfg: CliRunnerConfig = {}) {
    this.claudeBin = cfg.claudeBin ?? 'claude';
    this.hookScript = cfg.hookScript ?? fileURLToPath(new URL('./path-guard-cli.js', import.meta.url));
  }

  async run<T>(o: AgentRunOptions): Promise<AgentResult<T>> {
    const started = Date.now();
    if (o.signal.aborted) {
      return summarizeResult<T>({ result: null, sessionId: null, error: null, timedOut: false, aborted: true, floor: zeroUsage(), durationMs: 0, transcriptPath: o.transcriptPath });
    }

    // Un hook qui ne démarre pas sort en 1, ce que Claude Code traite comme une erreur NON bloquante :
    // un dist incomplet donnerait un agent silencieusement non gardé. Mieux vaut ne pas lancer du tout.
    if (o.pathGuard) {
      try {
        await stat(this.hookScript);
      } catch {
        throw new Error(`Garde-fou introuvable (${this.hookScript}) : run refusé plutôt que non gardé.`);
      }
    }

    const slug = callSlug(o.transcriptPath);
    const dir = dirname(o.transcriptPath);
    const appendPath = join(dir, `system-append-${slug}.md`);
    await writeFile(appendPath, o.systemPromptAppend);
    let settingsPath: string | undefined;
    if (o.pathGuard) {
      settingsPath = join(dir, `cli-settings-${slug}.json`);
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
      // JSON valide mais pas un objet (`null`, `3`, `"x"`) : rien à extraire, et le déréférencer planterait
      // le handler `data`, donc la lecture du flux entier.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
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
      const parts = (pending + (typeof chunk === 'string' ? chunk : outDecoder.write(chunk))).split('\n');
      pending = parts.pop() ?? '';
      for (const line of parts) onLine(line);
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
    });

    // `settled` = la promesse execa a rendu la main (processus sorti ET stdio fermés). On ne regarde
    // JAMAIS la seule sortie de la tête : `claude` peut sortir en laissant un descendant qui garde
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
          failure = `${this.claudeBin} : ${(outcome as { code?: string }).code ?? 'échec du lancement'}`;
        }
      }
    } finally {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      o.signal.removeEventListener('abort', onAbort);
      // Jamais de `claude` orphelin, même si la course ci-dessus a expiré.
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
    if (pending !== '') onLine(pending);
    if (stderrPending !== '') pushStderr('\n');
    await writes;

    const tail = stderrRing.join('\n');
    const aborted = o.signal.aborted;
    const error =
      result || timedOut || aborted
        ? null
        : new Error(`claude s'est arrêté sans result (code ${exitCode})${tail ? ` : ${tail}` : failure ? ` : ${failure}` : ''}`);

    return summarizeResult<T>({ result, sessionId, error, timedOut, aborted, floor, durationMs: Date.now() - started, transcriptPath: o.transcriptPath });
  }
}
