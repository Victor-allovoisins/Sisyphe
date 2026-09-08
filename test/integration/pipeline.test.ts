import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runJob } from '../../src/jobs/pipeline.js';
import { REPO, makeHarness, readyVerdict, repoRef, report, writeFeature } from '../helpers/harness.js';
import { remoteBranchSha, remoteCommitParents } from '../helpers/git-fixture.js';

const BRANCH = 'feature/issue-7-ajouter-feature-hello';
const issue7 = { repo: repoRef, number: 7 };
const signal = () => new AbortController().signal;

describe('runJob', () => {
  it('nominal : triage, implémentation, vérification, PR', async () => {
    const h = await makeHarness({ steps: [{ output: readyVerdict }, { output: report('Créé'), sideEffect: writeFeature('hello\n') }] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());

    expect(done.state).toBe('done');
    expect(done.attempt).toBe(1);
    expect(done.costUsd).toBeCloseTo(1.0);
    expect(done.branch).toBe(BRANCH);
    const sha = await remoteBranchSha(h.remotePath, BRANCH);
    expect(sha).not.toBeNull();
    expect(await remoteCommitParents(h.remotePath, sha!)).toEqual([h.headSha]);

    expect(h.source.pulls).toHaveLength(1);
    const pr = h.source.pulls[0];
    expect(pr.title).toBe('[#7] Ajouter feature hello');
    expect(pr.base).toBe('main');
    expect(pr.draft).toBe(false);
    expect(pr.body).toContain('Closes #7');
    expect(pr.body).toContain(`sisyphe:job:${done.id}`);
    expect(pr.reviewers).toEqual(['alice']);
    expect(done.prNumber).toBe(pr.number);

    expect(h.source.labelsOf(issue7)).toEqual(['sisyphe', 'sisyphe:done']);
    expect(h.source.commentsOf(issue7)[0]).toContain('pris cette issue');
    expect(h.phases.listForJob(done.id).map((p) => p.name)).toEqual(['triage', 'implement', 'verify', 'deliver']);
    expect(existsSync(done.worktreePath!)).toBe(false);

    expect(h.agent.calls[0].allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(h.agent.calls[0].prompt).toContain('On veut hello.');
    expect(h.agent.calls[1].disallowedTools).toContain('Bash(git push:*)');
    expect(h.agent.calls[1].hooks?.PreToolUse).toHaveLength(1);
    expect(h.agent.calls[1].prompt).toContain('1. créer src/feature.txt');
  });

  it('triage non concluant : blocked avec questions', async () => {
    const h = await makeHarness({ steps: [{ output: { ...readyVerdict, verdict: 'needs_clarification', questions: ['Quel écran ?'] } }] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());
    expect(done.state).toBe('blocked');
    expect(h.source.labelsOf(issue7)).toEqual(['sisyphe', 'sisyphe:blocked']);
    expect(h.source.commentsOf(issue7).at(-1)).toContain('Quel écran ?');
    expect(h.source.pulls).toHaveLength(0);
    expect(h.agent.calls).toHaveLength(1);
    expect(existsSync(done.worktreePath!)).toBe(false);
  });

  it('retry : la seconde tentative reprend la session avec le log d’échec', async () => {
    const h = await makeHarness({
      steps: [
        { output: readyVerdict },
        { output: report('v1'), sideEffect: writeFeature('bye\n') },
        { output: report('v2'), sideEffect: writeFeature('hello\n') },
      ],
    });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());
    expect(done.state).toBe('done');
    expect(done.attempt).toBe(2);
    expect(h.agent.calls[2].resumeSessionId).toBe('session-2');
    expect(h.agent.calls[2].prompt).toContain('« test »');
    expect(h.phases.listForJob(done.id).map((p) => `${p.name}:${p.outcome}`)).toEqual([
      'triage:success', 'implement:success', 'verify:failure', 'implement:success', 'verify:success', 'deliver:success',
    ]);
  });

  it('tentatives épuisées : failed avec PR draft et worktree conservé', async () => {
    const h = await makeHarness({
      steps: [{ output: readyVerdict }, { output: report('v1'), sideEffect: writeFeature('bye\n') }, { output: report('v2'), sideEffect: writeFeature('bye\n') }],
    });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());
    expect(done.state).toBe('failed');
    expect(done.flags.verificationFailed).toBe(true);
    expect(h.source.pulls[0].draft).toBe(true);
    expect(h.source.pulls[0].body).toContain('PR en draft');
    expect(h.source.labelsOf(issue7)).toEqual(['sisyphe', 'sisyphe:failed']);
    expect(existsSync(done.worktreePath!)).toBe(true);
  });

  it('aucun changement : blocked', async () => {
    const h = await makeHarness({ steps: [{ output: readyVerdict }, { output: report('rien à faire') }] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());
    expect(done.state).toBe('blocked');
    expect(h.source.commentsOf(issue7).at(-1)).toContain('aucun changement');
    expect(h.source.pulls).toHaveLength(0);
  });

  it('secret détecté : failed, rien poussé', async () => {
    const h = await makeHarness({ steps: [{ output: readyVerdict }, { output: report('v1'), sideEffect: writeFeature('hello\n') }] });
    h.deps.scan = async () => [{ file: 'src/feature.txt', ruleId: 'aws-access-token', line: 5 }];
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());
    expect(done.state).toBe('failed');
    expect(done.flags.secretsFound).toEqual(['src/feature.txt (aws-access-token)']);
    expect(await remoteBranchSha(h.remotePath, BRANCH)).toBeNull();
    expect(h.source.pulls).toHaveLength(0);
    expect(h.source.commentsOf(issue7).at(-1)).toContain('aws-access-token');
  });

  it('sisyphe.yml absent : blocked sans appel agent', async () => {
    const h = await makeHarness({ steps: [], withConfig: false });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());
    expect(done.state).toBe('blocked');
    expect(h.source.commentsOf(issue7).at(-1)).toContain('sisyphe.yml');
    expect(h.agent.calls).toHaveLength(0);
  });

  it('annulation pendant l’implémentation : cancelled, labels de statut retirés', async () => {
    const controller = new AbortController();
    const h = await makeHarness({
      steps: [{ output: readyVerdict }, { output: report('v1'), sideEffect: async () => controller.abort('cancelled') }],
    });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, controller.signal);
    expect(done.state).toBe('cancelled');
    expect(h.source.labelsOf(issue7)).toEqual(['sisyphe']);
    expect(h.source.commentsOf(issue7).at(-1)).toContain('annulé');
    expect(existsSync(done.worktreePath!)).toBe(false);
  });

  it('arrêt du daemon : le job reste dans son état pour la réconciliation', async () => {
    const controller = new AbortController();
    const h = await makeHarness({
      steps: [{ output: readyVerdict }, { output: report('v1'), sideEffect: async () => controller.abort('shutdown') }],
    });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const left = await runJob(job.id, h.deps, controller.signal);
    expect(left.state).toBe('implementing');
    expect(h.source.labelsOf(issue7)).toEqual(['sisyphe', 'sisyphe:in-progress']);
  });

  it('arrêt anticipé de l’agent : rapport de secours, flag earlyStop, livraison quand même', async () => {
    const h = await makeHarness({
      steps: [{ output: readyVerdict }, { output: null, stopReason: 'max_budget', sideEffect: writeFeature('hello\n') }],
    });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());
    expect(done.state).toBe('done');
    expect(done.flags.earlyStop).toBe('max_budget');
    expect(done.report?.confidence).toBe(0);
    expect(h.source.pulls[0].body).toContain('max_budget');
  });

  it('erreur technique : failed avec commentaire', async () => {
    const h = await makeHarness({ steps: [{ output: readyVerdict }, { output: report('v1'), sideEffect: async () => { throw new Error('SDK indisponible'); } }] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());
    expect(done.state).toBe('failed');
    expect(done.error).toContain('SDK indisponible');
    expect(h.source.labelsOf(issue7)).toEqual(['sisyphe', 'sisyphe:failed']);
  });
});
