import { describe, expect, it } from 'vitest';
import { fmtDuration, minutes } from './time.js';

describe('time', () => {
  it('minutes', () => {
    expect(minutes(1.5)).toBe(90_000);
  });
  it('fmtDuration couvre chaque palier et arrondit', () => {
    expect(fmtDuration(999.7)).toBe('1000 ms');
    expect(fmtDuration(59_400)).toBe('59 s');
    expect(fmtDuration(59_600)).toBe('1 min');
    expect(fmtDuration(125_000)).toBe('2 min 5 s');
    expect(fmtDuration(3_600_000)).toBe('1 h');
    expect(fmtDuration(3_660_000)).toBe('1 h 1 min');
  });
});
