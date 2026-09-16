import { describe, expect, it } from 'vitest';
import { runJob } from '../../src/jobs/pipeline.js';
import type { Issue } from '../../src/github/source.js';
import { REPO, makeHarness, readyVerdict, repoRef, report, writeFeature } from '../helpers/harness.js';

/**
 * Le ticket Jira décide de la branche de base, là où une issue GitHub s'en remet au `sisyphe.yml`.
 * Ces cas passent par le vrai pipeline et un vrai dépôt git : ils vérifient sur quoi la PR est ouverte,
 * pas seulement ce que le résolveur a calculé.
 */
const ticket = (fixVersions: string[]): Issue['tracker'] => ({
  key: 'IOS-7',
  issueType: 'Bug PROD',
  fixVersions,
  status: 'Nouveau',
});

const signal = () => new AbortController().signal;
const steps = () => [{ output: readyVerdict }, { output: report('Créé'), sideEffect: writeFeature('hello\n') }];
const issue7 = { repo: repoRef, number: 7 };

describe('branche de base depuis le ticket', () => {
  it('part de la release quand elle existe sur le distant', async () => {
    const h = await makeHarness({
      steps: steps(),
      extraBranches: ['release/8.42.0'],
      issues: [{ number: 7, title: 'Ajouter feature hello', tracker: ticket(['8.42.0']) }],
    });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());

    expect(done.state).toBe('done');
    expect(h.source.pulls[0].base).toBe('release/8.42.0');
  });

  it('retombe sur la branche du dépôt quand la release n’est pas encore coupée', async () => {
    const h = await makeHarness({
      steps: steps(),
      issues: [{ number: 7, title: 'Ajouter feature hello', tracker: ticket(['9.9.9']) }],
    });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());

    expect(done.state).toBe('done');
    expect(h.source.pulls[0].base).toBe('main');
  });

  it('rend la main, sans rien pousser, quand le ticket ne porte aucune version', async () => {
    const h = await makeHarness({
      steps: steps(),
      issues: [{ number: 7, title: 'Ajouter feature hello', tracker: ticket([]) }],
    });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());

    expect(done.state).toBe('blocked');
    expect(h.source.pulls).toHaveLength(0);
    const comment = h.source.commentsOf(issue7).join('\n');
    expect(comment).toContain('ne sait pas sur quelle version');
    expect(comment).toContain('aucune version cible');
    // Le message est pour l'auteur du ticket : aucun terme de plomberie.
    expect(comment).not.toContain('fixVersions');
    expect(comment).not.toContain('baseBranch');
  });

  it('une issue GitHub, sans ticket, garde le comportement d’avant', async () => {
    const h = await makeHarness({ steps: steps(), issues: [{ number: 7, title: 'Ajouter feature hello' }] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());

    expect(done.state).toBe('done');
    expect(h.source.pulls[0].base).toBe('main');
  });
});
