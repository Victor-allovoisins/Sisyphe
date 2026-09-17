import { describe, expect, it } from 'vitest';
import { emptyFlags, type Job, type Phase } from '../store/types.js';
import type { VerifyResult } from '../verify/verify.js';
import {
  jobMarker, renderBlockedComment, renderConfigProblemComment, renderDoneComment,
  renderProtectedPathsComment, renderSecretsComment, labelRelaunch } from './comments.js';
import { type PrBodyInput, renderPrBody } from './pr-body.js';
import { clampForGitHub, sanitizeCodeSpan, sanitizeModelText } from './sanitize.js';

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
  scope: { steps: ['build', 'test', 'lint'], reason: 'périmètre complet', widened: false },
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

const input: PrBodyInput = { job, report, verify, phases, prTemplate: null, costUsd: 1, durationMs: 1000, ticket: null };

describe('renderPrBody', () => {
  it('assemble toutes les sections dans l’ordre', () => {
    const body = renderPrBody({ job, report, verify, phases, prTemplate: '## Checklist\n- [ ] QA', costUsd: job.costUsd, durationMs: 200_000, ticket: null });
    const order = ['## Résumé', '## Changements', '## Décisions', '## Tests', "## Points d'attention", '## Suites à donner', '## Sisyphe', '## Checklist', 'Closes #7', jobMarker('job-1')];
    let last = -1;
    for (const marker of order) {
      const idx = body.indexOf(marker);
      expect(idx, marker).toBeGreaterThan(last);
      last = idx;
    }
    expect(body.indexOf('## Checklist')).toBeLessThan(body.indexOf('Closes #7'));
    expect(body).toContain('`A.swift` : nouvelle vue');
    expect(body).toContain('build : ✅ ok (1 min 5 s)');
    expect(body).toContain('test : ⏱️ délai de vérification dépassé après 2 min');
    expect(body).toContain('lint : ⏭️ non exécutée');
    expect(body).toContain('non inclus dans ce commit : `Package.resolved`');
    expect(body).toContain('900 lignes');
    expect(body).toContain('max_budget');
    expect(body).toContain('triage (tentative 1, claude-sonnet-5) : $0.20, 6 tours');
    expect(body).toContain('Total : $3.46');
  });
  it('omet les sections vides et le template absent', () => {
    const body = renderPrBody({ job: { ...job, flags: emptyFlags() }, report: { ...report, decisions: [], follow_ups: [], risks: [] }, verify: { ...verify, driftedFiles: [] }, phases, prTemplate: null, costUsd: 1, durationMs: 1000, ticket: null });
    expect(body).not.toContain('## Décisions');
    expect(body).not.toContain("## Points d'attention");
    expect(body).not.toContain('---');
  });
  it('ouvre le corps sur le lien du ticket Jira et supprime Closes', () => {
    const body = renderPrBody({
      job, report, verify, phases, prTemplate: null, costUsd: 1, durationMs: 1000,
      ticket: { key: 'IOS-886', url: 'https://acme.atlassian.net/browse/IOS-886' },
    });
    expect(body.split('\n')[0]).toBe('Ticket: [IOS-886](https://acme.atlassian.net/browse/IOS-886)');
    expect(body).not.toContain('Closes #');
  });
  it('sans ticket Jira, le corps garde son Closes en dernier', () => {
    const body = renderPrBody({ job, report, verify, phases, prTemplate: null, costUsd: 1, durationMs: 1000, ticket: null });
    expect(body).toContain('Closes #7');
  });
  it('distingue une étape hors périmètre d’une étape avortée', () => {
    const body = renderPrBody({ ...input, verify: { ...verify,
      scope: { steps: ['setup', 'build'], reason: 'changement de libellé', widened: false },
      steps: [
        { name: 'build', status: 'ok', exitCode: 0, durationMs: 1000, logFile: '' },
        { name: 'test', status: 'out-of-scope', exitCode: 0, durationMs: 0, logFile: '', reason: 'changement de libellé' },
        { name: 'lint', status: 'skipped', exitCode: 124, durationMs: 0, logFile: '' },
      ] } });
    expect(body).toContain('changement de libellé');
    expect(body).toMatch(/test.*hors périmètre/i);
    expect(body).toMatch(/lint.*non exécutée/i);
  });
  it('dit quand Sisyphe a élargi le périmètre malgré le triage', () => {
    const body = renderPrBody({ ...input, verify: { ...verify, scope: { steps: ['setup', 'build', 'test'], reason: 'reprise après échec : …', widened: true } } });
    expect(body).toContain('reprise après échec');
  });
  it('désamorce la raison du périmètre, écrite par le modèle de triage', () => {
    const body = renderPrBody({ ...input, verify: { ...verify,
      scope: { steps: ['setup'], reason: 'Fixes #12, signalé par @alice', widened: true },
      steps: [{ name: 'build', status: 'out-of-scope', exitCode: 0, durationMs: 0, logFile: '', reason: 'Fixes #12' }] } });
    expect(body).not.toContain('Fixes #12');
    expect(body).toContain('Fixes `#12`');
    expect(body).not.toContain('@alice');
  });
});

describe('sanitizeModelText', () => {
  it('neutralise toutes les formes de fermeture, les commentaires HTML même cassés, et les mentions', () => {
    expect(sanitizeModelText('Fixes #12 et closes #3, voir #4')).toBe('Fixes `#12` et closes `#3`, voir #4');
    expect(sanitizeModelText('fixes acme/other#12, Fixes GH-12, fixes: #7')).toBe('fixes `acme/other#12`, Fixes `GH-12`, fixes: `#7`');
    expect(sanitizeModelText('resolves https://github.com/o/r/issues/12')).toBe('resolves `https://github.com/o/r/issues/12`');
    expect(sanitizeModelText('a <!-- sisyphe:job:x --> b')).toBe('a  b');
    expect(sanitizeModelText('a <!-- ouvert')).toBe('a  ouvert');
    expect(sanitizeModelText('fermé --> b')).toBe('fermé  b');
    expect(sanitizeModelText('ping @octocat et @org/team')).toBe('ping @​octocat et @​org/team');
    expect(sanitizeModelText('ligne 1\nligne 2\r\n  ligne 3')).toBe('ligne 1 ligne 2 ligne 3');
  });
  it('en mode multiligne, garde les paragraphes mais désarme en-têtes et règles horizontales', () => {
    const out = sanitizeModelText("Résumé.\n\n## Points d'attention\n- rien\n---\n***", { multiline: true });
    expect(out).toContain("\\## Points d'attention");
    expect(out).toContain('\\---');
    expect(out).toContain('\\***');
    expect(out.split('\n')).toHaveLength(6);
    expect(sanitizeModelText('Titre\n=====', { multiline: true })).toContain('\\===');
  });
  it('sanitizeCodeSpan retire les backticks', () => {
    expect(sanitizeCodeSpan('a`b\nc')).toBe('ab c');
    expect(sanitizeCodeSpan('packages/@acme/foo`.ts')).toBe('packages/@acme/foo.ts');
  });
  it('clampForGitHub préserve la fin', () => {
    const body = `${'x'.repeat(70_000)}\nCloses #7\n<!-- sisyphe:job:1 -->`;
    const out = clampForGitHub(body);
    expect(out.length).toBeLessThanOrEqual(60_000);
    expect(out.endsWith('Closes #7\n<!-- sisyphe:job:1 -->')).toBe(true);
    expect(out).toContain('caractères coupés');
    expect(clampForGitHub('court')).toBe('court');
    const withTemplate = renderPrBody({ job, report: { ...report, summary: 'x'.repeat(70_000) }, verify, phases, prTemplate: '## Checklist\n' + 'y'.repeat(4000), costUsd: 1, durationMs: 1000, ticket: null });
    const clamped = clampForGitHub(withTemplate);
    expect(clamped.endsWith(jobMarker('job-1'))).toBe(true);
    expect(clamped).toContain('Closes #7');
    expect(clampForGitHub('x'.repeat(5000), 100).length).toBeLessThanOrEqual(1200);
  });
  it('est appliqué au body de PR et au template mais pas aux lignes de Sisyphe', () => {
    const body = renderPrBody({ job, report: { ...report, summary: 'Closes #99 <!-- sisyphe:job:fake -->', risks: [...report.risks, "\n## Points d'attention forgés"] }, verify, phases, prTemplate: '## Checklist\nCloses #5', costUsd: 1, durationMs: 1000, ticket: null });
    expect(body).toContain('Closes `#99`');
    expect(body).not.toContain('sisyphe:job:fake');
    expect(body).not.toContain("\n## Points d'attention forgés");
    expect(body).toContain('## Checklist');
    expect(body).toContain('Closes #5');
    expect(body).toContain('Closes #7');
    expect(body).toContain(jobMarker('job-1'));
    expect(body.indexOf('⚠️')).toBeLessThan(body.indexOf('Vérifier le dark mode'));
  });
});

describe('comments', () => {
  it('renderBlockedComment affiche la note et les questions si needs_clarification, sans jargon de verdict', () => {
    const c = renderBlockedComment(
      { verdict: 'needs_clarification', confidence: 0.4, summary: 'Flou.', note: "Il manque un écran précis pour savoir où agir.", change_type: 'feat', plan: [], files_likely_touched: [], questions: ['Quel écran ?', 'Quelle couleur ?'], reasons: [], verification: { steps: ['build', 'test', 'lint'], why: 'périmètre complet' } },
      labelRelaunch('sisyphe'),
    );
    expect(c).not.toContain('needs_clarification');
    expect(c).not.toContain('confiance');
    expect(c).toContain('Il manque un écran précis');
    expect(c).toContain('- Quel écran ?');
    expect(c).toContain('`sisyphe:blocked`');
  });
  it('renderBlockedComment ne liste pas de questions hors needs_clarification', () => {
    const c = renderBlockedComment(
      { verdict: 'out_of_scope', confidence: 0.7, summary: 'Backend.', note: "Ça se joue côté serveur, pas dans ce dépôt.", change_type: 'fix', plan: [], files_likely_touched: [], questions: [], reasons: ['hors périmètre iOS'], verification: { steps: ['build', 'test', 'lint'], why: 'périmètre complet' } },
      labelRelaunch('sisyphe'),
    );
    expect(c).toContain('Ça se joue côté serveur');
    expect(c).not.toContain('Pour avancer');
    expect(c).not.toContain('hors périmètre iOS');
  });
  it('renderConfigProblemComment distingue fichier absent et fichier invalide', () => {
    const missing = renderConfigProblemComment('missing', 'sisyphe.yml absent sur la branche main', labelRelaunch('sisyphe'));
    expect(missing).toContain('Ajoutez un fichier');
    expect(missing).toContain('baseBranch: main');
    const invalid = renderConfigProblemComment('invalid', 'sisyphe.yml invalide :\n- commands.build : Invalid input', labelRelaunch('sisyphe'));
    expect(invalid).toContain('Corrigez');
    expect(invalid).toContain('commands.build');
    expect(invalid).not.toContain('Ajoutez un fichier');
  });
  it('renderSecretsComment promet la suppression du worktree, pas une conservation 7 jours', () => {
    const c = renderSecretsComment(['src/feature.txt (aws-access-token)'], labelRelaunch('sisyphe'));
    expect(c).toContain('- src/feature.txt (aws-access-token)');
    expect(c).toContain("n'a rien poussé");
    expect(c).toContain('worktree est supprimé');
    expect(c).toContain('`jobs/<id>/`');
    expect(c).not.toContain('7 jours');
    expect(c).toContain('`sisyphe:failed`');
  });
  it('renderProtectedPathsComment liste les chemins, rien poussé et consigne de relance', () => {
    const c = renderProtectedPathsComment(['secrets/key.txt', '.github/workflows/ci.yml'], labelRelaunch('sisyphe'));
    expect(c).toContain('- secrets/key.txt');
    expect(c).toContain('- .github/workflows/ci.yml');
    expect(c).toContain("n'a rien poussé");
    expect(c).toContain('chemins protégés');
    expect(c).toContain('worktree est supprimé');
    expect(c).toContain('`jobs/<id>/`');
    expect(c).toContain('`sisyphe:failed`');
  });
  it('renderDoneComment distingue succès et draft, et porte le marqueur de job', () => {
    expect(renderDoneComment({ jobId: 'job-1', prUrl: 'u', status: 'done', costUsd: 2, durationMs: 60_000, attempts: 1 })).toContain('PR prête');
    const failed = renderDoneComment({ jobId: 'job-1', prUrl: 'u', status: 'failed', costUsd: 2, durationMs: 60_000, attempts: 3 });
    expect(failed).toContain('draft');
    expect(failed).toContain(jobMarker('job-1'));
  });
});
