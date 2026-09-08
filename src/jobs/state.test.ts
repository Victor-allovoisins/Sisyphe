import { describe, expect, it } from 'vitest';
import { InvalidTransitionError, assertTransition, canTransition } from './state.js';
import { isTerminal } from '../store/types.js';

describe('transitions', () => {
  it('suit le chemin nominal', () => {
    expect(canTransition('queued', 'triaging')).toBe(true);
    expect(canTransition('triaging', 'implementing')).toBe(true);
    expect(canTransition('implementing', 'verifying')).toBe(true);
    expect(canTransition('verifying', 'implementing')).toBe(true); // retry
    expect(canTransition('verifying', 'delivering')).toBe(true);
    expect(canTransition('delivering', 'done')).toBe(true);
    expect(canTransition('delivering', 'failed')).toBe(true);
  });

  it('autorise le requeue depuis les états interrompus', () => {
    for (const from of ['triaging', 'implementing', 'verifying', 'delivering'] as const) {
      expect(canTransition(from, 'queued')).toBe(true);
    }
  });

  it('autorise cancelled depuis tout état actif et rien depuis un terminal', () => {
    for (const from of ['queued', 'triaging', 'implementing', 'verifying', 'delivering'] as const) {
      expect(canTransition(from, 'cancelled')).toBe(true);
    }
    for (const from of ['done', 'blocked', 'failed', 'cancelled'] as const) {
      expect(isTerminal(from)).toBe(true);
      expect(canTransition(from, 'queued')).toBe(false);
    }
  });

  it('refuse les sauts', () => {
    expect(canTransition('queued', 'done')).toBe(false);
    expect(() => assertTransition('queued', 'done')).toThrow(InvalidTransitionError);
  });
});
