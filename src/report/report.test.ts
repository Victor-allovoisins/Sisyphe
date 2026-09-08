import { describe, expect, it } from 'vitest';
import { emptyFlags, type Job } from '../store/types.js';
import { buildReport, parseSince, renderReportMarkdown } from './report.js';

function job(over: Partial<Job>): Job {
  return {
    id: 'id', repo: 'a/b', issueNumber: 1, issueTitle: 't', state: 'done', attempt: 1, requeues: 0, branch: null, baseSha: null,
    worktreePath: null, verdict: null, report: null, flags: emptyFlags(), prNumber: null, prUrl: null, prState: null, prMergedAt: null,
    costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, durationMs: 0, error: null,
    createdAt: '2026-09-01T00:00:00Z', startedAt: null, finishedAt: null, updatedAt: '', ...over,
  };
}

describe('parseSince', () => {
  it('convertit h, d, w', () => {
    const now = new Date('2026-09-08T12:00:00Z');
    expect(parseSince('12h', now)).toBe('2026-09-08T00:00:00.000Z');
    expect(parseSince('1d', now)).toBe('2026-09-07T12:00:00.000Z');
    expect(parseSince('1w', now)).toBe('2026-09-01T12:00:00.000Z');
    expect(() => parseSince('abc')).toThrow(/Durée invalide/);
  });
  it('rejette une durée qui produit une date invalide', () => {
    expect(() => parseSince('99999999999d')).toThrow(/Durée invalide/);
  });
});

describe('buildReport', () => {
  const jobs = [
    job({ id: '1', state: 'done', prNumber: 1, prMergedAt: '2026-09-02T00:00:00Z', prState: 'closed', costUsd: 2, durationMs: 1000, attempt: 1 }),
    job({ id: '2', state: 'done', prNumber: 2, costUsd: 4, durationMs: 3000, attempt: 2 }),
    job({ id: '3', state: 'failed', prNumber: 3, costUsd: 12, durationMs: 30000, attempt: 3, error: 'tests rouges' }),
    job({ id: '4', state: 'blocked', costUsd: 0.5 }),
    job({ id: '5', state: 'cancelled' }),
    job({ id: '6', state: 'queued' }),
  ];
  it('calcule les taux et les médianes', () => {
    const s = buildReport(jobs, '2026-09-01T00:00:00Z');
    expect(s.total).toBe(6);
    expect(s.finished).toBe(4); // done, done, failed, blocked
    expect(s.withPr).toBe(3);
    expect(s.merged).toBe(1);
    expect(s.prOpenedRate).toBeCloseTo(0.75);
    expect(s.prMergedRate).toBeCloseTo(1 / 3);
    expect(s.totalCostUsd).toBeCloseTo(18.5);
    expect(s.medianCostUsd).toBe(4);
    expect(s.medianDurationMs).toBe(3000);
    expect(s.avgAttempts).toBe(2);
    expect(s.recentFailures).toEqual([{ id: '3', repo: 'a/b', issueNumber: 1, error: 'tests rouges' }]);
  });
  it('rend un markdown lisible', () => {
    const md = renderReportMarkdown(buildReport(jobs, '2026-09-01T00:00:00Z'));
    expect(md).toContain('# Sisyphe — rapport depuis 2026-09-01 00:00');
    expect(md).toContain('PR mergées : 1 (33 % des PR ouvertes)');
    expect(md).toContain('- done : 2');
    expect(md).toContain('tests rouges');
  });
  it('trie les échecs récents par date, indépendamment de l’ordre d’entrée', () => {
    const older = job({ id: 'older', repo: 'a/b', issueNumber: 1, state: 'failed', error: 'ancien échec', finishedAt: '2026-09-02T00:00:00Z' });
    const newer = job({ id: 'newer', repo: 'a/b', issueNumber: 1, state: 'failed', error: 'échec récent', finishedAt: '2026-09-05T00:00:00Z' });
    const s = buildReport([newer, older], '2026-09-01T00:00:00Z');
    expect(s.recentFailures.map((f) => f.id)).toEqual(['newer', 'older']);
  });
  it('gère un jeu de jobs vide sans NaN', () => {
    const s = buildReport([], '2026-09-01T00:00:00Z');
    expect(s.total).toBe(0);
    expect(s.finished).toBe(0);
    expect(s.prOpenedRate).toBe(0);
    expect(s.prMergedRate).toBe(0);
    expect(s.totalCostUsd).toBe(0);
    expect(s.medianCostUsd).toBe(0);
    expect(s.medianDurationMs).toBe(0);
    expect(s.avgAttempts).toBe(0);
    expect(s.costPerMergedPrUsd).toBeNull();
    expect(renderReportMarkdown(s)).toContain('Aucun job sur la période.');
  });
});
