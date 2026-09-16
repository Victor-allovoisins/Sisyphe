import { describe, expect, it } from 'vitest';
import { parseRepoConfig } from '../config/repo.js';
import { parseRepo, type Issue } from '../github/source.js';
import { releaseBranchFor, resolveBaseBranch } from './base-branch.js';

const config = parseRepoConfig(`
baseBranch: develop
commands:
  build: make build
`);

const REPO = parseRepo('ILokYou/ILokYou-iOS');

function issue(tracker?: Issue['tracker']): Issue {
  return {
    repo: REPO, number: 885, title: 't', body: '', author: 'a', state: 'open', labels: [], comments: [],
    ...(tracker ? { tracker } : {}),
  };
}

const jira = (fixVersions: string[]): Issue['tracker'] => ({ key: 'IOS-885', issueType: 'Bug PROD', fixVersions, status: 'Nouveau' });

const never = async () => false;
const always = async () => true;

describe('releaseBranchFor', () => {
  it('substitue la version dans le gabarit', () => {
    expect(releaseBranchFor(config, '8.42.0')).toBe('release/8.42.0');
    expect(releaseBranchFor(parseRepoConfig('baseBranch: main\nreleaseBranchPattern: rel-{version}\ncommands:\n  build: x\n'), '2.0')).toBe('rel-2.0');
  });
});

describe('resolveBaseBranch', () => {
  it('sans traqueur riche, garde la branche du dépôt : le comportement GitHub ne change pas', async () => {
    const r = await resolveBaseBranch({ config, issue: issue(), branchExists: always });
    expect(r).toEqual({ kind: 'ok', branch: 'develop', reason: 'branche de base du dépôt' });
  });

  it('part de la release quand elle est déjà ouverte', async () => {
    const seen: string[] = [];
    const r = await resolveBaseBranch({
      config,
      issue: issue(jira(['8.42.0'])),
      branchExists: async (b) => {
        seen.push(b);
        return true;
      },
    });
    expect(r).toEqual({ kind: 'ok', branch: 'release/8.42.0', reason: 'version 8.42.0, branche de release ouverte' });
    expect(seen).toEqual(['release/8.42.0']);
  });

  it('retombe sur le tronc quand la release n’est pas encore coupée', async () => {
    const r = await resolveBaseBranch({ config, issue: issue(jira(['9.0.0'])), branchExists: never });
    expect(r).toEqual({ kind: 'ok', branch: 'develop', reason: 'version 9.0.0, pas encore de branche de release' });
  });

  it('sans version, part du tronc : c’est un ticket de backlog, et c’est le cas le plus courant', async () => {
    const seen: string[] = [];
    const r = await resolveBaseBranch({
      config,
      issue: issue(jira([])),
      branchExists: async (b) => {
        seen.push(b);
        return true;
      },
    });
    expect(r).toEqual({ kind: 'ok', branch: 'develop', reason: 'ticket de backlog, aucune version visée' });
    // Aucune branche de release à chercher : on n'interroge même pas le distant.
    expect(seen).toEqual([]);
  });

  it('rend la main sur plusieurs versions : choisir à la place de l’équipe ouvrirait la PR au mauvais endroit', async () => {
    const r = await resolveBaseBranch({ config, issue: issue(jira(['8.42.0', '8.43.0'])), branchExists: always });
    expect(r.kind).toBe('blocked');
    expect(r.kind === 'blocked' && r.reason).toContain('8.42.0, 8.43.0');
  });

  it('refuse une version qui ne donne pas un nom de branche valide', async () => {
    const r = await resolveBaseBranch({ config, issue: issue(jira(['Sprint 42'])), branchExists: always });
    expect(r.kind).toBe('blocked');
    expect(r.kind === 'blocked' && r.reason).toContain('Sprint 42');
  });
});
