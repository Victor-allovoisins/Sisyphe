import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { AgentUsage } from '../store/types.js';

export type AgentStopReason = 'completed' | 'max_turns' | 'max_budget' | 'timeout' | 'aborted' | 'error';

export interface AgentRunOptions {
  cwd: string;
  model: string;
  systemPromptAppend: string;
  prompt: string;
  outputSchema?: Record<string, unknown>;
  maxTurns: number;
  maxBudgetUsd: number;
  resumeSessionId?: string;
  allowedTools: string[];
  disallowedTools: string[];
  hooks?: Options['hooks'];
  /** Environnement du processus agent (agentEnv : daemon épuré + SISYPHE_* + clé API). */
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
  /** Fichier JSONL où chaque message SDK est ajouté. */
  transcriptPath: string;
}

export interface AgentResult<T> {
  /** null si arrêt anticipé ou sortie non conforme au schéma. */
  output: T | null;
  sessionId: string | null;
  costUsd: number;
  usage: AgentUsage;
  numTurns: number;
  durationMs: number;
  stopReason: AgentStopReason;
  transcriptPath: string;
}

export interface AgentRunner {
  run<T>(opts: AgentRunOptions): Promise<AgentResult<T>>;
}
