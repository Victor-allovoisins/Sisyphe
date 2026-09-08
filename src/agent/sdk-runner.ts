import { query, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { appendFile } from 'node:fs/promises';
import { zeroUsage, type AgentUsage } from '../store/types.js';
import type { AgentResult, AgentRunOptions, AgentRunner, AgentStopReason } from './runner.js';

export interface SdkRunnerConfig {
  sandbox: boolean;
}

/** Domaines nécessaires quand le sandbox réseau est actif : GitHub et registres de packages courants. */
export const SANDBOX_ALLOWED_DOMAINS = [
  'github.com', 'api.github.com', 'objects.githubusercontent.com', 'codeload.github.com',
  'registry.npmjs.org', 'cdn.cocoapods.org', 'repo1.maven.org', 'dl.google.com', 'services.gradle.org',
];

export class SdkAgentRunner implements AgentRunner {
  constructor(private readonly cfg: SdkRunnerConfig) {}

  async run<T>(o: AgentRunOptions): Promise<AgentResult<T>> {
    const started = Date.now();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, o.timeoutMs);
    const onAbort = () => controller.abort();
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener('abort', onAbort, { once: true });

    const append = (line: unknown) => appendFile(o.transcriptPath, `${JSON.stringify(line)}\n`).catch(() => undefined);

    const options: Options = {
      cwd: o.cwd,
      model: o.model,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: o.systemPromptAppend },
      settingSources: ['project'],
      permissionMode: 'dontAsk',
      allowedTools: o.allowedTools,
      disallowedTools: o.disallowedTools,
      maxTurns: o.maxTurns,
      maxBudgetUsd: o.maxBudgetUsd,
      outputFormat: o.outputSchema ? { type: 'json_schema', schema: o.outputSchema } : undefined,
      resume: o.resumeSessionId,
      hooks: o.hooks,
      abortController: controller,
      env: o.env,
      sandbox: this.cfg.sandbox
        ? { enabled: true, autoAllowBashIfSandboxed: true, network: { allowedDomains: SANDBOX_ALLOWED_DOMAINS } }
        : undefined,
      stderr: (data) => void append({ type: 'stderr', data }),
    };

    let result: SDKResultMessage | null = null;
    let sessionId: string | null = null;
    let error: unknown = null;
    try {
      for await (const message of query({ prompt: o.prompt, options })) {
        await append(message);
        if (message.type === 'system' && message.subtype === 'init') sessionId = message.session_id;
        if (message.type === 'result') {
          result = message;
          sessionId = message.session_id;
        }
      }
    } catch (err) {
      // Attendu après un result d'erreur (max_turns, budget...) : le result est déjà capturé.
      error = err;
      await append({ type: 'sisyphe_error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
    }
    return summarizeResult<T>({ result, sessionId, error, timedOut, aborted: o.signal.aborted, durationMs: Date.now() - started, transcriptPath: o.transcriptPath });
  }
}

export function summarizeResult<T>(i: {
  result: SDKResultMessage | null;
  sessionId: string | null;
  error: unknown;
  timedOut: boolean;
  aborted: boolean;
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
    : zeroUsage();

  let stopReason: AgentStopReason;
  if (i.aborted) stopReason = 'aborted';
  else if (i.timedOut) stopReason = 'timeout';
  else if (!r) stopReason = 'error';
  else if (r.subtype === 'success') stopReason = 'completed';
  else if (r.subtype === 'error_max_turns') stopReason = 'max_turns';
  else if (r.subtype === 'error_max_budget_usd') stopReason = 'max_budget';
  else stopReason = 'error';

  const output = r && r.subtype === 'success' && r.structured_output !== undefined ? (r.structured_output as T) : null;
  const sdkErrors = r && r.subtype !== 'success' ? (r as { errors?: string[] }).errors ?? [] : [];
  const errorMessage = stopReason === 'error' ? [i.error instanceof Error ? i.error.message : i.error ? String(i.error) : '', ...sdkErrors].filter(Boolean).join(' ; ') || undefined : undefined;
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
