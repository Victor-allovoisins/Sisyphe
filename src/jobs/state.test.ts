import { describe, expect, it } from 'vitest';
import { JOB_STATES, emptyFlags, isTerminal, parseFlags, type JobState } from '../store/types.js';
import { ALLOWED_TRANSITIONS, InvalidTransitionError, assertTransition, canTransition } from './state.js';

/** Matrice attendue, écrite indépendamment de la table : toute modification de la table doit se voir ici. */
const EXPECTED: Record<JobState, JobState[]> = {
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

describe('transitions', () => {
  it('correspond exactement à la matrice attendue sur les 81 paires', () => {
    for (const from of JOB_STATES) {
      for (const to of JOB_STATES) {
        expect(canTransition(from, to), `${from} → ${to}`).toBe(EXPECTED[from].includes(to));
      }
    }
  });

  it('les états terminaux sont exactement ceux sans sortie', () => {
    for (const s of JOB_STATES) {
      expect(isTerminal(s), s).toBe(ALLOWED_TRANSITIONS[s].length === 0);
    }
  });

  it('assertTransition ne lève que sur une paire interdite, avec from et to', () => {
    expect(() => assertTransition('queued', 'triaging')).not.toThrow();
    let caught: unknown;
    try {
      assertTransition('queued', 'done');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidTransitionError);
    const e = caught as InvalidTransitionError;
    expect(e.from).toBe('queued');
    expect(e.to).toBe('done');
    expect(e.message).toContain('queued → done');
  });
});

describe('parseFlags', () => {
  it('complète les champs manquants et conserve les valeurs présentes', () => {
    expect(parseFlags('{"largeDiff":true}')).toEqual({ ...emptyFlags(), largeDiff: true });
    expect(parseFlags(JSON.stringify(emptyFlags()))).toEqual(emptyFlags());
  });
});
