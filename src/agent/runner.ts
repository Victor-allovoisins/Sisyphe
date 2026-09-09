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
  /** Liste blanche : seuls ces outils existent pour l'agent (option SDK `tools`) et ils sont auto-approuvés (option `allowedTools`). */
  allowedTools: string[];
  disallowedTools: string[];
  /** Garde-fou d'écriture : chaque backend le traduit dans son propre mécanisme de hook PreToolUse. */
  pathGuard?: { worktreePath: string; protectedPatterns: string[] };
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
  /** Détail SDK quand la session ne s'est pas terminée normalement (erreur, limite, timeout) ; absent sinon. */
  errorMessage?: string;
}

export interface AgentRunner {
  run<T>(opts: AgentRunOptions): Promise<AgentResult<T>>;
}
