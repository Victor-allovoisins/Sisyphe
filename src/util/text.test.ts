import { describe, expect, it } from 'vitest';
import { tail } from './text.js';

describe('tail', () => {
  it('garde les N dernières lignes et signale la coupe', () => {
    expect(tail('a\nb\nc\nd', 2)).toBe('…(2 lignes coupées)\nc\nd');
    expect(tail('a', 5)).toBe('a');
  });
  it('borne en octets', () => {
    const out = tail('x'.repeat(100), 10, 20);
    expect(out.endsWith('x'.repeat(20))).toBe(true);
    expect(out).toContain('80 caractères coupés');
  });
});
