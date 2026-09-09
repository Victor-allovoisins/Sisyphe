import { describe, expect, it } from 'vitest';
import { GitHubIssueSource, hasWriteAccess, labelNames, lastLabeler } from './client.js';
import { labelDefinitions } from './labels.js';
import type { RepoRef } from './source.js';

describe('client helpers', () => {
  it('hasWriteAccess', () => {
    expect(hasWriteAccess('admin')).toBe(true);
    expect(hasWriteAccess('write')).toBe(true);
    expect(hasWriteAccess('maintain')).toBe(true);
    expect(hasWriteAccess('read')).toBe(false);
    expect(hasWriteAccess(undefined)).toBe(false);
  });
  it('lastLabeler prend le dernier événement labeled du bon label', () => {
    const events = [
      { event: 'labeled', label: { name: 'sisyphe' }, actor: { login: 'alice' } },
      { event: 'labeled', label: { name: 'bug' }, actor: { login: 'bob' } },
      { event: 'unlabeled', label: { name: 'sisyphe' }, actor: { login: 'alice' } },
      { event: 'labeled', label: { name: 'sisyphe' }, actor: { login: 'carol' } },
    ];
    expect(lastLabeler(events, 'sisyphe')).toBe('carol');
    expect(lastLabeler(events, 'absent')).toBeNull();
  });
  it('labelNames accepte chaînes et objets', () => {
    expect(labelNames(['a', { name: 'b' }, { name: undefined }])).toEqual(['a', 'b']);
  });
});

// Erreur façon Octokit : status + éventuels en-têtes de rate limit.
const httpErr = (status: number, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`HTTP ${status}`), { status, response: { headers } });

const repo: RepoRef = { owner: 'acme', name: 'demo', full: 'acme/demo' };

/** Le client réel se valide en Task 25 ; ici on remplace juste l'Octokit interne par un stub minimal. */
function makeClient(): GitHubIssueSource {
  return new GitHubIssueSource({
    appId: 1, installationId: 1, privateKey: 'x', triggerLabel: 'sisyphe',
    retry: { sleep: async () => undefined, baseDelayMs: 0 },
  });
}

function inject(src: GitHubIssueSource, stub: unknown): void {
  (src as unknown as { octokitPromise: Promise<unknown> }).octokitPromise = Promise.resolve(stub);
}

describe('GitHubIssueSource (Octokit factice)', () => {
  it('canTrigger : aucun événement labeled mais label présent → replie sur l’auteur', async () => {
    const src = makeClient();
    inject(src, {
      rest: {
        issues: { get: async () => ({ data: { labels: ['sisyphe'], user: { login: 'alice' } } }) },
        repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: 'write' } }) },
      },
      paginate: async () => [], // aucun événement `labeled` retrouvé
      graphql: async () => ({}),
    });
    const r = await src.canTrigger({ repo, number: 1 });
    expect(r).toEqual({ ok: true, login: 'alice' });
  });

  it('canTrigger : labeler bot → ok false', async () => {
    const src = makeClient();
    inject(src, {
      rest: { issues: {}, repos: {} },
      paginate: async () => [{ event: 'labeled', label: { name: 'sisyphe' }, actor: { login: 'dependabot[bot]' } }],
      graphql: async () => ({}),
    });
    const r = await src.canTrigger({ repo, number: 1 });
    expect(r).toEqual({ ok: false, login: 'dependabot[bot]' });
  });

  it('canTrigger : erreur 4xx de la requête de permission → ok false', async () => {
    const src = makeClient();
    inject(src, {
      rest: { issues: {}, repos: { getCollaboratorPermissionLevel: async () => { throw httpErr(403); } } },
      paginate: async () => [{ event: 'labeled', label: { name: 'sisyphe' }, actor: { login: 'alice' } }],
      graphql: async () => ({}),
    });
    const r = await src.canTrigger({ repo, number: 1 });
    expect(r).toEqual({ ok: false, login: 'alice' });
  });

  it('canTrigger : une erreur 500 à la vérification de permission fait rejeter (transitoire)', async () => {
    const src = makeClient();
    inject(src, {
      rest: { issues: {}, repos: { getCollaboratorPermissionLevel: async () => { throw httpErr(500); } } },
      paginate: async () => [{ event: 'labeled', label: { name: 'sisyphe' }, actor: { login: 'alice' } }],
      graphql: async () => ({}),
    });
    await expect(src.canTrigger({ repo, number: 1 })).rejects.toThrow();
  });

  it('canTrigger : une erreur réseau (sans statut) à la vérification de permission fait rejeter', async () => {
    const src = makeClient();
    inject(src, {
      rest: { issues: {}, repos: { getCollaboratorPermissionLevel: async () => { throw new Error('ECONNRESET'); } } },
      paginate: async () => [{ event: 'labeled', label: { name: 'sisyphe' }, actor: { login: 'alice' } }],
      graphql: async () => ({}),
    });
    await expect(src.canTrigger({ repo, number: 1 })).rejects.toThrow();
  });

  it('canTrigger : un labeler humain identifié sans droits ne se replie jamais sur l’auteur', async () => {
    const src = makeClient();
    let issueGetCalled = false;
    inject(src, {
      rest: {
        issues: { get: async () => { issueGetCalled = true; return { data: { labels: ['sisyphe'], user: { login: 'author' } } }; } },
        repos: { getCollaboratorPermissionLevel: async () => ({ data: { permission: 'read' } }) },
      },
      paginate: async () => [{ event: 'labeled', label: { name: 'sisyphe' }, actor: { login: 'bob' } }],
      graphql: async () => ({}),
    });
    const r = await src.canTrigger({ repo, number: 1 });
    expect(r).toEqual({ ok: false, login: 'bob' });
    expect(issueGetCalled).toBe(false);
  });

  it('listCandidates : exclut les labels de statut et les pull_request', async () => {
    const src = makeClient();
    inject(src, {
      rest: { issues: {} },
      paginate: async () => [
        { number: 1, labels: ['sisyphe'] },
        { number: 2, labels: ['sisyphe', 'sisyphe:in-progress'] },
        { number: 3, labels: ['sisyphe'], pull_request: {} },
      ],
      graphql: async () => ({}),
    });
    const refs = await src.listCandidates(repo);
    expect(refs.map((r) => r.number)).toEqual([1]);
  });

  it('setStatus(null) retire tous les labels de statut et tolère un 404', async () => {
    const src = makeClient();
    const removed: string[] = [];
    inject(src, {
      rest: {
        issues: {
          get: async () => ({ data: { labels: ['sisyphe', 'sisyphe:in-progress', 'sisyphe:blocked'] } }),
          removeLabel: async ({ name }: { name: string }) => {
            removed.push(name);
            if (name === 'sisyphe:blocked') throw httpErr(404);
          },
        },
      },
      paginate: async () => [],
      graphql: async () => ({}),
    });
    await src.setStatus({ repo, number: 1 }, null);
    expect(removed.sort()).toEqual(['sisyphe:blocked', 'sisyphe:in-progress']);
  });

  it("setStatus('done') déjà présent n'appelle pas addLabels", async () => {
    const src = makeClient();
    let addLabelsCalled = false;
    inject(src, {
      rest: {
        issues: {
          get: async () => ({ data: { labels: ['sisyphe', 'sisyphe:done'] } }),
          addLabels: async () => { addLabelsCalled = true; return { data: [] }; },
          removeLabel: async () => ({ data: [] }),
        },
      },
      paginate: async () => [],
      graphql: async () => ({}),
    });
    await src.setStatus({ repo, number: 1 }, 'done');
    expect(addLabelsCalled).toBe(false);
  });

  it('findPullRequest : head owner:branch, uniquement les PR open', async () => {
    const src = makeClient();
    let captured: unknown;
    inject(src, {
      rest: {
        pulls: {
          list: async (params: unknown) => {
            captured = params;
            return { data: [{ number: 42, html_url: 'https://x/42' }] };
          },
        },
      },
      paginate: async () => [],
      graphql: async () => ({}),
    });
    const pr = await src.findPullRequest(repo, 'feature/x');
    expect(pr).toEqual({ repo, number: 42, url: 'https://x/42' });
    expect(captured).toMatchObject({ head: 'acme:feature/x', state: 'open' });
  });

  it('openPullRequest : addLabels qui échoue n’empêche pas de retourner la PR', async () => {
    const src = makeClient();
    inject(src, {
      rest: {
        pulls: { create: async () => ({ data: { number: 10, html_url: 'https://x/10' } }) },
        issues: { addLabels: async () => { throw httpErr(422); } },
      },
      paginate: async () => [],
      graphql: async () => ({}),
    });
    const pr = await src.openPullRequest({ repo, title: 't', head: 'h', base: 'main', body: 'b', draft: false, labels: ['sisyphe:done'], reviewers: [] });
    expect(pr).toEqual({ repo, number: 10, url: 'https://x/10' });
  });

  it('openPullRequest : requestReviewers qui échoue n’empêche pas de retourner la PR', async () => {
    const src = makeClient();
    inject(src, {
      rest: {
        pulls: { create: async () => ({ data: { number: 11, html_url: 'https://x/11' } }), requestReviewers: async () => { throw httpErr(422); } },
      },
      paginate: async () => [],
      graphql: async () => ({}),
    });
    const pr = await src.openPullRequest({ repo, title: 't', head: 'h', base: 'main', body: 'b', draft: false, labels: [], reviewers: ['bob'] });
    expect(pr).toEqual({ repo, number: 11, url: 'https://x/11' });
  });

  it('openPullRequest : pulls.create 422 → PullRef via findPullRequest', async () => {
    const src = makeClient();
    inject(src, {
      rest: {
        pulls: {
          create: async () => { throw httpErr(422); },
          list: async () => ({ data: [{ number: 55, html_url: 'https://x/55' }] }),
        },
      },
      paginate: async () => [],
      graphql: async () => ({}),
    });
    const pr = await src.openPullRequest({ repo, title: 't', head: 'h', base: 'main', body: 'b', draft: false, labels: [], reviewers: [] });
    expect(pr).toEqual({ repo, number: 55, url: 'https://x/55' });
  });

  it('ensureLabels : tous présents → zéro createLabel', async () => {
    const src = makeClient();
    let createLabelCalls = 0;
    inject(src, {
      rest: { issues: { createLabel: async () => { createLabelCalls++; return { data: {} }; } } },
      paginate: async () => labelDefinitions('sisyphe').map((d) => ({ name: d.name })),
      graphql: async () => ({}),
    });
    await src.ensureLabels(repo);
    expect(createLabelCalls).toBe(0);
  });

  it('ensureLabels : 422 sur createLabel toléré', async () => {
    const src = makeClient();
    inject(src, {
      rest: { issues: { createLabel: async () => { throw httpErr(422); } } },
      paginate: async () => [],
      graphql: async () => ({}),
    });
    await expect(src.ensureLabels(repo)).resolves.toBeUndefined();
  });

  it('addTriggerLabel : envoie le label trigger via addLabels', async () => {
    const src = makeClient();
    let captured: unknown;
    inject(src, {
      rest: { issues: { addLabels: async (params: unknown) => { captured = params; return { data: [] }; } } },
      paginate: async () => [],
      graphql: async () => ({}),
    });
    await src.addTriggerLabel({ repo, number: 1 });
    expect(captured).toEqual({ owner: 'acme', repo: 'demo', issue_number: 1, labels: ['sisyphe'] });
  });
});
