import type { AgentResult, AgentRunOptions, AgentRunner, AgentStopReason } from '../../src/agent/runner.js';

export interface ScriptedStep {
  output: unknown;
  costUsd?: number;
  stopReason?: AgentStopReason;
  /** Simule le travail de l'agent dans le worktree (opts.cwd). */
  sideEffect?: (opts: AgentRunOptions) => Promise<void>;
}

/** Rejoue des résultats prédéfinis, dans l'ordre. Enregistre les appels. */
export class ScriptedAgentRunner implements AgentRunner {
  readonly calls: AgentRunOptions[] = [];

  constructor(private readonly steps: ScriptedStep[]) {}

  async run<T>(opts: AgentRunOptions): Promise<AgentResult<T>> {
    const step = this.steps.shift();
    if (!step) throw new Error(`ScriptedAgentRunner : aucune étape prévue pour l'appel ${this.calls.length + 1}`);
    this.calls.push(opts);
    await step.sideEffect?.(opts);
    return {
      output: step.output as T,
      sessionId: `session-${this.calls.length}`,
      costUsd: step.costUsd ?? 0.5,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheCreationTokens: 0 },
      numTurns: 3,
      durationMs: 10,
      stopReason: step.stopReason ?? 'completed',
      transcriptPath: opts.transcriptPath,
    };
  }
}
