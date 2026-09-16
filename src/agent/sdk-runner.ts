import { query as sdkQuery, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { appendFile } from 'node:fs/promises';
import { zeroUsage, type AgentUsage } from '../store/types.js';
import { bashGuardHook, pathGuardHook } from './hooks.js';
import { agentPluginPath } from './plugin-path.js';
import type { AgentResult, AgentRunOptions, AgentRunner, AgentStopReason } from './runner.js';

/**
 * Pont vers le Claude Agent SDK. Trois contrats non évidents :
 * - un `query()` en mode simple LÈVE après avoir émis un result d'erreur : on capture le result avant le catch ;
 * - `env` REMPLACE l'environnement du CLI (rien n'est hérité du daemon au-delà de ce que agentEnv fournit) ;
 * - le sandbox ne gate que les commandes Bash, pas les outils in-process ni le trafic API du CLI.
 * `settingSources: []` : rien n'est chargé depuis le repo cible (ni settings, ni hooks, ni MCP, ni CLAUDE.md) ;
 * le CLAUDE.md est injecté par Sisyphe dans `systemPromptAppend`, ce qui rend la protection indépendante d'un
 * éventuel tier MDM qui ferait ignorer `managedSettings`.
 */
export interface SdkRunnerConfig {
  sandbox: boolean;
}

export type QueryFn = typeof sdkQuery;

/** Domaines nécessaires quand le sandbox réseau est actif : GitHub et registres de packages courants. */
export const SANDBOX_ALLOWED_DOMAINS = [
  'github.com', 'api.github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com', 'codeload.github.com',
  'registry.npmjs.org', 'cdn.cocoapods.org', 'repo1.maven.org', 'dl.google.com', 'services.gradle.org',
];

/** Les hooks PreToolUse du run : garde de chemins pour les écritures, garde Bash pour la phase `jira`. */
function buildHooks(o: AgentRunOptions): Options['hooks'] {
  const entries: NonNullable<Options['hooks']>['PreToolUse'] = [];
  if (o.pathGuard) entries.push({ matcher: 'Edit|Write', hooks: [pathGuardHook(o.pathGuard.worktreePath, o.pathGuard.protectedPatterns)] });
  if (o.bashGuard) entries.push({ matcher: 'Bash', hooks: [bashGuardHook()] });
  return entries.length ? { PreToolUse: entries } : undefined;
}

export function buildOptions(o: AgentRunOptions, cfg: SdkRunnerConfig, controller: AbortController, onStderr: (data: string) => void): Options {
  return {
    cwd: o.cwd,
    model: o.model,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: o.systemPromptAppend },
    settingSources: [],
    managedSettings: { strictPluginOnlyCustomization: ['hooks', 'mcp'] },
    permissionMode: 'dontAsk',
    tools: o.allowedTools,
    allowedTools: o.allowedTools,
    disallowedTools: o.disallowedTools,
    maxTurns: o.maxTurns,
    maxBudgetUsd: o.maxBudgetUsd,
    outputFormat: o.outputSchema ? { type: 'json_schema', schema: o.outputSchema } : undefined,
    resume: o.resumeSessionId,
    plugins: o.skills?.length ? [{ type: 'local', path: agentPluginPath() }] : undefined,
    skills: o.skills,
    hooks: buildHooks(o),
    abortController: controller,
    env: o.env,
    // `enabled: true` implique failIfUnavailable : sur une plateforme sans sandbox, échec explicite plutôt que dégradation silencieuse.
    sandbox: cfg.sandbox ? { enabled: true, autoAllowBashIfSandboxed: true, network: { allowedDomains: SANDBOX_ALLOWED_DOMAINS } } : undefined,
    stderr: onStderr,
  };
}

export class SdkAgentRunner implements AgentRunner {
  constructor(private readonly cfg: SdkRunnerConfig, private readonly queryFn: QueryFn = sdkQuery) {}

  async run<T>(o: AgentRunOptions): Promise<AgentResult<T>> {
    const started = Date.now();
    if (o.signal.aborted) {
      return summarizeResult<T>({ result: null, sessionId: null, error: null, timedOut: false, aborted: true, floor: zeroUsage(), durationMs: 0, transcriptPath: o.transcriptPath });
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, o.timeoutMs);
    const onAbort = () => controller.abort();
    o.signal.addEventListener('abort', onAbort, { once: true });

    const append = (line: unknown) => {
      let text: string;
      try {
        text = JSON.stringify(line);
      } catch {
        text = JSON.stringify({ type: 'sisyphe_unserializable' });
      }
      return appendFile(o.transcriptPath, `${text}\n`).catch(() => undefined);
    };

    let result: SDKResultMessage | null = null;
    let sessionId: string | null = null;
    let error: unknown = null;
    // Plancher d'usage reconstitué depuis les messages assistant (dédoublonnés par id), pour le cas où le result manque.
    const floor = zeroUsage();
    const seen = new Set<string>();
    try {
      for await (const message of this.queryFn({ prompt: o.prompt, options: buildOptions(o, this.cfg, controller, (data) => void append({ type: 'stderr', data })) })) {
        await append(message);
        if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
        if (message.type === 'assistant' && !message.parent_tool_use_id && !seen.has(message.message.id)) {
          seen.add(message.message.id);
          const u = message.message.usage;
          floor.inputTokens += u.input_tokens;
          floor.outputTokens += u.output_tokens;
          floor.cacheReadTokens += u.cache_read_input_tokens ?? 0;
          floor.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
        }
        if (message.type === 'result') {
          result = message;
          sessionId = message.session_id;
        }
      }
    } catch (err) {
      // Attendu après un result d'erreur (limites, abort) : le result est déjà capturé.
      error = err;
      await append({ type: 'sisyphe_error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
    }
    return summarizeResult<T>({ result, sessionId, error, timedOut, aborted: o.signal.aborted, floor, durationMs: Date.now() - started, transcriptPath: o.transcriptPath });
  }
}

export function summarizeResult<T>(i: {
  result: SDKResultMessage | null;
  sessionId: string | null;
  error: unknown;
  timedOut: boolean;
  aborted: boolean;
  floor: AgentUsage;
  durationMs: number;
  transcriptPath: string;
}): AgentResult<T> {
  const r = i.result;
  const usage: AgentUsage = r
    ? {
        inputTokens: r.usage.input_tokens,
        outputTokens: r.usage.output_tokens,
        cacheReadTokens: r.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: r.usage.cache_creation_input_tokens ?? 0,
      }
    : i.floor;

  let stopReason: AgentStopReason;
  if (r && r.subtype === 'success' && !r.is_error) stopReason = 'completed';
  else if (i.timedOut) stopReason = 'timeout';
  else if (i.aborted) stopReason = 'aborted';
  else if (!r) stopReason = 'error';
  else if (r.subtype === 'error_max_turns') stopReason = 'max_turns';
  else if (r.subtype === 'error_max_budget_usd') stopReason = 'max_budget';
  else stopReason = 'error';

  const parts: string[] = [];
  if (r && r.subtype === 'success' && r.is_error) parts.push(r.result);
  if (r && r.subtype !== 'success') parts.push(...((r as { errors?: string[] }).errors ?? []));
  if (i.error) parts.push(i.error instanceof Error ? i.error.message : String(i.error));
  if (!r && (i.timedOut || i.aborted)) parts.push('session interrompue avant le result : coût inconnu, usage reconstitué depuis les messages');
  const errorMessage = stopReason === 'completed' ? undefined : parts.filter(Boolean).join(' ; ') || undefined;

  const output = stopReason === 'completed' && r && r.subtype === 'success' && r.structured_output !== undefined ? (r.structured_output as T) : null;
  return {
    output,
    sessionId: i.sessionId,
    costUsd: r?.total_cost_usd ?? 0,
    usage,
    numTurns: r?.num_turns ?? 0,
    durationMs: i.durationMs,
    stopReason,
    errorMessage,
    transcriptPath: i.transcriptPath,
  };
}
