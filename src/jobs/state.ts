import type { JobState } from '../store/types.js';

export const ALLOWED_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['triaging', 'cancelled', 'failed'],
  triaging: ['implementing', 'blocked', 'failed', 'cancelled', 'queued'],
  implementing: ['verifying', 'failed', 'cancelled', 'queued'],
  verifying: ['implementing', 'delivering', 'blocked', 'failed', 'cancelled', 'queued'],
  delivering: ['done', 'failed', 'cancelled', 'queued'],
  done: [],
  blocked: [],
  failed: [],
  cancelled: [],
};

export class InvalidTransitionError extends Error {
  constructor(public readonly from: JobState, public readonly to: JobState) {
    super(`Transition invalide : ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: JobState, to: JobState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobState, to: JobState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
