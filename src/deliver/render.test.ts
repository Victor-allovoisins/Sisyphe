import { describe, expect, it } from 'vitest';
import { emptyFlags, type Job, type Phase } from '../store/types.js';
import type { VerifyResult } from '../verify/verify.js';
import { jobMarker, renderBlockedComment, renderConfigProblemComment, renderDoneComment } from './comments.js';
import { renderPrBody } from './pr-body.js';
import { sanitizeModelText } from './sanitize.js';

const job: Job = {
  id: 'job-1', repo: 'acme/demo', issueNumber: 7, issueTitle: 'Ajouter un bouton', state: 'delivering', attempt: 2, requeues: 0,
  branch: 'feature/issue-7-x', baseSha: 'abc', worktreePath: '/wt', verdict: null, report: null,
  flags: { ...emptyFlags(), largeDiff: true, protectedPathsTouched: ['App/Config.xcconfig'], earlyStop: 'max_budget' },
  prNumber: null, prUrl: null, prState: null, prMergedAt: null, costUsd: 3.4567, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  durationMs: 0, error: null, createdAt: '', startedAt: null, finishedAt: null, updatedAt: '',
};
const report = {
  summary: 'Bouton ajouté.', changes: [{ file: 'A.swift', what: 'nouvelle vue' }], decisions: ['SwiftUI plutôt que UIKit'],
  tests_run: ['xcodebuild test : ok'], risks: ['Vérifier le dark mode'], follow_ups: ['Ajouter un test UI'], confidence: 0.8,
};
const verify: VerifyResult = {
  ok: true, noChanges: false, treeSha: 'a'.repeat(40), failedStep: null, failureTail: '', files: ['A.swift'], changedLines: 900, driftedFiles: ['Package.resolved'],
  flags: { protectedPathsTouched: job.flags.protectedPathsTouched, largeDiff: job.flags.largeDiff, secretsFound: [] },
  steps: [
    { name: 'build', status: 'ok', exitCode: 0, durationMs: 65_000, logFile: '' },
    { name: 'test', status: 'timeout', exitCode: -1, durationMs: 120_000, logFile: '' },
    { name: 'lint', status: 'skipped', exitCode: 124, durationMs: 0, logFile: '' },
  ],
};
const phases: Phase[] = [
  { id: 1, jobId: 'job-1', name: 'triage', attempt: 1, model: 'claude-sonnet-5', sessionId: 's', costUsd: 0.2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, numTurns: 6, stopReason: 'completed', outcome: 'success', startedAt: '', finishedAt: '' },
  { id: 2, jobId: 'job-1', name: 'implement', attempt: 1, model: 'claude-opus-5', sessionId: 's', costUsd: 3.2, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, numTurns: 40, stopReason: 'completed', outcome: 'success', startedAt: '', finishedAt: '' },
  { id: 3, jobId: 'job-1', name: 'verify', attempt: 1, model: null, sessionId: null, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, numTurns: 0, stopReason: null, outcome: 'success', startedAt: '', finishedAt: '' },
];

describe('renderPrBody', () => {
  it('assemble toutes les sections dans l’ordre', () => {
    const body = renderPrBody({ job, report, verify, phases, prTemplate: '## Checklist\n- [ ] QA', costUsd: job.costUsd, durationMs: 200_000 });
    const order = ['## Résumé', '## Changements', '## Décisions', '## Tests', "## Points d'attention", '## Suites à donner', '## Sisyphe', 'Closes #7', jobMarker('job-1'), '## Checklist'];
    let last = -1;
    for (const marker of order) {
      const idx = body.indexOf(marker);
      expect(idx, marker).toBeGreaterThan(last);
      last = idx;
    }
    expect(body).toContain('`A.swift` : nouvelle vue');
    expect(body).toContain('build : ✅ ok (1 min 5 s)');
    expect(body).toContain('test : ⏱️ délai de vérification dépassé après 2 min');
    expect(body).toContain('lint : ⏭️ non exécutée');
    expect(body).toContain('non inclus dans ce commit : `Package.resolved`');
    expect(body).toContain('Chemins protégés modifiés : `App/Config.xcconfig`');
    expect(body).toContain('900 lignes');
    expect(body).toContain('max_budget');
    expect(body).toContain('triage (tentative 1, claude-sonnet-5) : $0.20, 6 tours');
    expect(body).toContain('Total : $3.46');
  });
  it('omet les sections vides et le template absent', () => {
    const body = renderPrBody({ job: { ...job, flags: emptyFlags() }, report: { ...report, decisions: [], follow_ups: [], risks: [] }, verify: { ...verify, driftedFiles: [] }, phases, prTemplate: null, costUsd: 1, durationMs: 1000 });
    expect(body).not.toContain('## Décisions');
    expect(body).not.toContain("## Points d'attention");
    expect(body).not.toContain('---');
  });
});

describe('sanitizeModelText', () => {
  it('neutralise les mots-clés de fermeture et les commentaires HTML', () => {
    expect(sanitizeModelText('Fixes #12 et closes #3, voir #4')).toBe('Fixes `#12` et closes `#3`, voir #4');
    expect(sanitizeModelText('a <!-- sisyphe:job:x --> b')).toBe('a  b');
    expect(sanitizeModelText('Résolu par Resolves\n#7')).toBe('Résolu par Resolves\n`#7`');
  });
  it('est appliqué au body de PR mais pas aux lignes de Sisyphe', () => {
    const body = renderPrBody({ job, report: { ...report, summary: 'Closes #99 <!-- sisyphe:job:fake -->' }, verify, phases, prTemplate: null, costUsd: 1, durationMs: 1000 });
    expect(body).toContain('Closes `#99`');
    expect(body).not.toContain('sisyphe:job:fake');
    expect(body).toContain('Closes #7');
    expect(body).toContain(jobMarker('job-1'));
  });
});

describe('comments', () => {
  it('renderBlockedComment liste les questions et la consigne de relance', () => {
    const c = renderBlockedComment({ verdict: 'needs_clarification', confidence: 0.4, summary: 'Flou.', change_type: 'feat', plan: [], files_likely_touched: [], questions: ['Quel écran ?', 'Quelle couleur ?'], reasons: [] }, 'sisyphe');
    expect(c).toContain('needs_clarification');
    expect(c).toContain('- Quel écran ?');
    expect(c).toContain('`sisyphe:blocked`');
  });
  it('renderConfigProblemComment distingue fichier absent et fichier invalide', () => {
    const missing = renderConfigProblemComment('missing', 'sisyphe.yml absent sur la branche main', 'sisyphe');
    expect(missing).toContain('Ajoutez un fichier');
    expect(missing).toContain('baseBranch: main');
    const invalid = renderConfigProblemComment('invalid', 'sisyphe.yml invalide :\n- commands.build : Invalid input', 'sisyphe');
    expect(invalid).toContain('Corrigez');
    expect(invalid).toContain('commands.build');
    expect(invalid).not.toContain('Ajoutez un fichier');
  });
  it('renderDoneComment distingue succès et draft', () => {
    expect(renderDoneComment({ prUrl: 'u', status: 'done', costUsd: 2, durationMs: 60_000, attempts: 1 })).toContain('PR prête');
    expect(renderDoneComment({ prUrl: 'u', status: 'failed', costUsd: 2, durationMs: 60_000, attempts: 3 })).toContain('draft');
  });
});
