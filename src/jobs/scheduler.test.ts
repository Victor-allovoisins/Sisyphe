import { describe, expect, it } from 'vitest';
import { canStartJob, startOfLocalDay } from './scheduler.js';

describe('canStartJob', () => {
  it('bloque sur le budget avant la concurrence', () => {
    expect(canStartJob({ activeCount: 0, maxConcurrent: 1, spentTodayUsd: 60, dailyBudgetUsd: 60 })).toEqual({ ok: false, reason: 'budget' });
    expect(canStartJob({ activeCount: 1, maxConcurrent: 1, spentTodayUsd: 0, dailyBudgetUsd: 60 })).toEqual({ ok: false, reason: 'concurrency' });
    expect(canStartJob({ activeCount: 0, maxConcurrent: 1, spentTodayUsd: 59.99, dailyBudgetUsd: 60 })).toEqual({ ok: true });
  });
});

describe('startOfLocalDay', () => {
  it('renvoie minuit local en ISO', () => {
    const iso = startOfLocalDay(new Date(2026, 8, 8, 15, 30));
    const d = new Date(iso);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getDate()).toBe(8);
  });
});
