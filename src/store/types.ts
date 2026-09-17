import type { ImplementationReport, TriageVerdict } from '../agent/schemas.js';

export const JOB_STATES = [
  'queued', 'triaging', 'implementing', 'verifying', 'delivering',
  'done', 'blocked', 'failed', 'cancelled',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<JobState> = new Set<JobState>(['done', 'blocked', 'failed', 'cancelled']);

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

export interface JobFlags {
  verificationFailed: boolean;
  protectedPathsTouched: string[];
  largeDiff: boolean;
  secretsFound: string[];
  earlyStop: string | null;
}

export function emptyFlags(): JobFlags {
  return { verificationFailed: false, protectedPathsTouched: [], largeDiff: false, secretsFound: [], earlyStop: null };
}

/** Désérialise `flags_json` en complétant les champs absents d'une ligne écrite par une version antérieure. */
export function parseFlags(json: string): JobFlags {
  return { ...emptyFlags(), ...(JSON.parse(json) as Partial<JobFlags>) };
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export function zeroUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

export interface Job {
  id: string;
  repo: string; // owner/name
  issueNumber: number;
  issueTitle: string;
  /**
   * Clé du ticket chez son traqueur (`IOS-885`), ou null : le job vient d'une issue GitHub. C'est le job qui
   * dit d'où il vient, pas la configuration actuelle de son dépôt — elle a pu basculer depuis.
   */
  issueKey: string | null;
  state: JobState;
  attempt: number;
  requeues: number;
  branch: string | null;
  baseSha: string | null;
  worktreePath: string | null;
  verdict: TriageVerdict | null;
  report: ImplementationReport | null;
  flags: JobFlags;
  prNumber: number | null;
  prUrl: string | null;
  prState: 'open' | 'closed' | null;
  prMergedAt: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** Le CHECK de la table `phases` doit suivre cette liste : un nom absent du SQL fait échouer `phases.start`. */
export const PHASE_NAMES = ['triage', 'implement', 'verify', 'deliver', 'jira'] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];
export type PhaseOutcome = 'success' | 'failure';

export interface Phase {
  id: number;
  jobId: string;
  name: PhaseName;
  attempt: number;
  model: string | null;
  sessionId: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  numTurns: number;
  stopReason: string | null;
  outcome: PhaseOutcome | null;
  startedAt: string;
  finishedAt: string | null;
}
