import { describe, expect, it } from 'vitest';
import { JIRA_STATUSES_DEFAULT } from '../../src/config/machine.js';
import { JiraIssueTracker } from '../../src/jira/client.js';
import { runJob } from '../../src/jobs/pipeline.js';
import { REPO, makeHarness, readyVerdict, report, writeFeature } from '../helpers/harness.js';

/**
 * Le pipeline complet avec un vrai `JiraIssueTracker` en source, branché sur un Jira factice.
 *
 * Les tests unitaires du client vérifient chaque méthode isolément, et l'intégration existante passe par
 * `FakeIssueSource`, qui ne connaît ni transitions ni assignation. Ce fichier est le seul endroit où les deux
 * se rencontrent : c'est lui qui voit la marche de transitions se dérouler pendant un job, et la main être
 * rendue quand il s'arrête.
 */

const ACCOUNT = 'acc-sisyphe-ios';
const ORDER: string[] = [...JIRA_STATUSES_DEFAULT];

/** Jira factice : un statut, un assigné, et un graphe de transitions qui suit le workflow réel. */
function fakeJira(start = 'Nouveau') {
  const state = { status: start, assignee: ACCOUNT as string | null, comments: [] as string[] };
  const transitionsFrom = (s: string) => {
    const i = ORDER.indexOf(s);
    const out: { id: string; to: { name: string } }[] = [];
    if (i > 0) out.push({ id: `back-${i}`, to: { name: ORDER[i - 1] } });
    if (i >= 0 && i < ORDER.length - 1) out.push({ id: `fwd-${i}`, to: { name: ORDER[i + 1] } });
    return out;
  };

  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const p = u.pathname;

    if (p === '/rest/api/3/issue/IOS-7' && method === 'GET') {
      return json({
        key: 'IOS-7',
        fields: {
          summary: 'Ajouter feature hello',
          description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'On veut hello.' }] }] },
          status: { name: state.status, statusCategory: { key: state.status === 'Fermé' ? 'done' : 'indeterminate' } },
          reporter: { displayName: 'alice', accountId: 'acc-alice' },
          assignee: state.assignee ? { displayName: 'Sisyphe iOS', accountId: state.assignee } : null,
          labels: [],
          issuetype: { name: 'Bug PROD' },
          fixVersions: [{ name: '8.42.0' }],
        },
      });
    }
    if (p === '/rest/api/3/issue/IOS-7/comment') {
      if (method === 'POST') {
        state.comments.push(JSON.stringify(body));
        return json({ id: '1' });
      }
      return json({ comments: [] });
    }
    if (p === '/rest/api/3/issue/IOS-7/changelog') return json({ values: [{ author: { displayName: 'Victor', accountId: 'acc-victor' }, items: [{ field: 'assignee' }] }] });
    if (p === '/rest/api/3/issue/IOS-7/transitions') {
      if (method === 'GET') return json({ transitions: transitionsFrom(state.status) });
      const id = (body as { transition: { id: string } }).transition.id;
      const hop = transitionsFrom(state.status).find((t) => t.id === id);
      if (!hop) return new Response('transition invalide', { status: 400 });
      state.status = hop.to.name;
      return new Response(null, { status: 204 });
    }
    if (p === '/rest/api/3/issue/IOS-7/assignee' && method === 'PUT') {
      state.assignee = (body as { accountId: string | null }).accountId;
      return new Response(null, { status: 204 });
    }
    if (p === '/rest/api/3/search/jql') return json({ issues: [{ key: 'IOS-7' }] });
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  const tracker = new JiraIssueTracker({
    site: 'allovoisins.atlassian.net',
    email: 'bot@example.test',
    apiToken: 'jeton',
    projects: [{
      key: 'IOS', accountId: ACCOUNT, repo: REPO,
      candidateStatuses: ['Nouveau', 'En analyse'], statusesInOrder: ORDER,
      inProgressStatus: 'En développement', doneStatus: 'En relecture',
    }],
    fetchImpl,
    retry: { attempts: 1, sleep: async () => {} },
  });
  return { state, tracker };
}

const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
const signal = () => new AbortController().signal;

async function harnessOn(jiraTracker: JiraIssueTracker, steps: Parameters<typeof makeHarness>[0]['steps'], extraBranches?: string[]) {
  const h = await makeHarness({ steps, ...(extraBranches ? { extraBranches } : {}) });
  // La forge reste le faux GitHub (branches, PR) ; seul le suivi passe par Jira.
  h.deps.source = jiraTracker;
  // La config machine doit suivre : c'est elle, et non le client câblé, qui décide du texte de relance —
  // comme en production, où `createApp` ne branche Jira que si la section existe.
  h.deps.machine = {
    ...h.deps.machine,
    jira: {
      site: 'allovoisins.atlassian.net',
      email: 'bot@example.test',
      apiTokenPath: '/dev/null',
      projects: [{
        key: 'IOS', accountId: ACCOUNT, repo: REPO,
        candidateStatuses: ['Nouveau', 'En analyse'], statusesInOrder: ORDER,
        inProgressStatus: 'En développement', doneStatus: 'En relecture',
      }],
    },
  };
  return h;
}

describe('pipeline sur Jira', () => {
  it('fait avancer le ticket jusqu’à « En relecture » et ouvre la PR sur la release', async () => {
    const j = fakeJira();
    const h = await harnessOn(j.tracker, [{ output: readyVerdict }, { output: report('Créé'), sideEffect: writeFeature('hello\n') }], ['release/8.42.0']);
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());

    expect(done.state).toBe('done');
    // La marche a bien traversé les colonnes intermédiaires, sans en sauter.
    expect(j.state.status).toBe('En relecture');
    expect(j.state.assignee).toBe(ACCOUNT);
    expect(h.source.pulls[0].base).toBe('release/8.42.0');
  });

  it('rend la main, sans quitter la colonne de travail, quand le triage bloque', async () => {
    const j = fakeJira();
    const blocked = { ...readyVerdict, verdict: 'needs_clarification', note: 'Il manque un écran.', questions: ['Quel écran ?'] };
    const h = await harnessOn(j.tracker, [{ output: blocked }]);
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());

    expect(done.state).toBe('blocked');
    expect(j.state.assignee).toBe('acc-victor');
    expect(j.state.status).toBe('En développement');
    // Le message de relance parle d'assignation, pas de label : le lecteur est sur un ticket Jira.
    expect(j.state.comments.join('\n')).toContain('réassignez-le');
    expect(j.state.comments.join('\n')).not.toContain('label');
  });

  it('un job annulé ne laisse pas le ticket en cours et assigné au bot', async () => {
    const j = fakeJira();
    const controller = new AbortController();
    // L'annulation arrive pendant l'implémentation, comme le ferait le bouton Annuler de l'interface.
    const h = await harnessOn(j.tracker, [
      { output: readyVerdict },
      { output: report('v1'), sideEffect: async () => controller.abort('cancelled') },
    ]);
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const left = await runJob(job.id, h.deps, controller.signal);

    expect(left.state).toBe('cancelled');
    // Sans remise de la main, le ticket resterait « En développement » et assigné au bot : hors des statuts
    // candidats, donc jamais repris, et assigné à un compte qui ne le traitera plus.
    expect(j.state.assignee).toBe('acc-victor');
  });
});
