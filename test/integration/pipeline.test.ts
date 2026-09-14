import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jobDir } from '../../src/config/paths.js';
import { runJob } from '../../src/jobs/pipeline.js';
import { REPO, SISYPHE_YML, makeHarness, readyVerdict, repoRef, report, writeFeature } from '../helpers/harness.js';
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
    expect(h.agent.calls[1].pathGuard).toEqual({ worktreePath: h.agent.calls[1].cwd, protectedPatterns: ['secrets/**'] });
    expect(h.agent.calls[1].prompt).toContain('1. créer src/feature.txt');
  });

  it('accumule durationMs au lieu de l’écraser (cas d’un job requeué)', async () => {
    const h = await makeHarness({ steps: [{ output: readyVerdict }, { output: report('Créé'), sideEffect: writeFeature('hello\n') }] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    h.store.update(job.id, { durationMs: 3_600_000 });
    const done = await runJob(job.id, h.deps, signal());
    expect(done.state).toBe('done');
    expect(done.durationMs).toBeGreaterThan(3_600_000);
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

  it('tentatives épuisées : failed avec PR draft, worktree supprimé et dossier de job conservé', async () => {
    const h = await makeHarness({
      steps: [{ output: readyVerdict }, { output: report('v1'), sideEffect: writeFeature('bye\n') }, { output: report('v2'), sideEffect: writeFeature('bye\n') }],
    });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());
    expect(done.state).toBe('failed');
    expect(done.flags.verificationFailed).toBe(true);
    expect(h.source.pulls[0].draft).toBe(true);
    expect(h.source.pulls[0].body).toContain('PR en draft');
    expect(done.prNumber).not.toBeNull();
    expect(h.source.labelsOf(issue7)).toEqual(['sisyphe', 'sisyphe:failed']);
    // Le clone part, le dossier de job reste : le post-mortem se fait sur les transcripts et la PR.
    expect(existsSync(done.worktreePath!)).toBe(false);
    expect(existsSync(jobDir(h.paths, done.id))).toBe(true);
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
    expect(existsSync(done.worktreePath!)).toBe(false);
    expect(existsSync(jobDir(h.paths, done.id))).toBe(true);
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
    expect(existsSync(done.worktreePath!)).toBe(false);
    expect(existsSync(jobDir(h.paths, done.id))).toBe(true);
  });

  it('injecte le CLAUDE.md du repo dans le system prompt et refuse un sisyphe.yml invalide', async () => {
    const h = await makeHarness({
      steps: [{ output: readyVerdict }, { output: report('a'), sideEffect: writeFeature('hello\n') }],
      files: { 'CLAUDE.md': '# Conventions maison\nSwift only.' },
    });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    await runJob(job.id, h.deps, signal());
    expect(h.agent.calls[0].systemPromptAppend).toContain('Swift only.');

    const bad = await makeHarness({ steps: [], files: { 'sisyphe.yml': 'baseBranch: main\ncommands:\n  buidl: x\n' } });
    const job2 = bad.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job2.id, bad.deps, signal());
    expect(done.state).toBe('blocked');
    expect(bad.source.commentsOf(issue7).at(-1)).toContain('Corrigez');
    expect(bad.agent.calls).toHaveLength(0);
  });

  it('exécute la commande setup et échoue proprement si elle casse', async () => {
    const withSetup = 'baseBranch: main\ncommands:\n  setup: echo prêt > setup-ran.txt\n  build: sh build.sh\n  test: sh test.sh\n';
    const ok = await makeHarness({
      steps: [{ output: readyVerdict }, { output: report('a'), sideEffect: writeFeature('hello\n') }],
      files: { 'sisyphe.yml': withSetup },
    });
    const okJob = ok.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    expect((await runJob(okJob.id, ok.deps, signal())).state).toBe('done');
    expect(ok.agent.calls[1].prompt).toContain('setup : `echo prêt > setup-ran.txt`');

    // Le setup casse avant tout appel agent : c'est bien le pipeline, et non la vérification, qui l'a exécuté.
    const ko = await makeHarness({ steps: [], files: { 'sisyphe.yml': withSetup.replace('echo prêt > setup-ran.txt', 'exit 7') } });
    const koJob = ko.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(koJob.id, ko.deps, signal());
    expect(done.state).toBe('failed');
    expect(done.error).toContain('commands.setup');
    expect(ko.source.commentsOf(issue7).at(-1)).toContain('échoué');
    expect(ko.agent.calls).toHaveLength(0);
  });

  it('rafraîchit une branche de base différente de la branche par défaut et y lit le template de PR', async () => {
    const h = await makeHarness({
      steps: [{ output: readyVerdict }, { output: report('a'), sideEffect: writeFeature('hello\n') }],
      defaultBranch: 'trunk',
      extraBranches: ['develop'],
      files: { 'sisyphe.yml': SISYPHE_YML.replace('baseBranch: main', 'baseBranch: develop'), '.github/PULL_REQUEST_TEMPLATE.md': '## Checklist repo\n- [ ] QA' },
    });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());
    expect(done.state).toBe('done');
    expect(h.source.pulls[0].base).toBe('develop');
    expect(h.source.pulls[0].body).toContain('## Checklist repo');
  });

  it('un triage sans JSON exploitable bloque avec un verdict synthétique', async () => {
    const h = await makeHarness({ steps: [{ output: null, stopReason: 'max_turns' }] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());
    expect(done.state).toBe('blocked');
    expect(done.verdict?.verdict).toBe('needs_clarification');
    expect(h.source.commentsOf(issue7).at(-1)).toContain('max_turns');
    expect(h.phases.listForJob(done.id).map((p) => p.outcome)).toEqual(['failure']);
  });

  it('un abort sans raison laisse le job en place ; une exception ferme la phase', async () => {
    const controller = new AbortController();
    const h = await makeHarness({ steps: [{ output: readyVerdict }, { output: report('v1'), sideEffect: async () => controller.abort() }] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const left = await runJob(job.id, h.deps, controller.signal);
    expect(left.state).toBe('implementing');

    const h2 = await makeHarness({ steps: [{ output: readyVerdict }, { output: report('v1'), sideEffect: async () => { throw new Error('SDK indisponible'); } }] });
    const job2 = h2.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    await runJob(job2.id, h2.deps, signal());
    const implementPhase = h2.phases.listForJob(job2.id).find((p) => p.name === 'implement');
    expect(implementPhase?.outcome).toBe('failure');
    expect(implementPhase?.finishedAt).not.toBeNull();
  });
});
