import { describe, expect, it } from 'vitest';
import { WORKFLOW, jiraProject } from '../../test/fakes/jira-workflow.js';
import { parseRepo, type IssueRef } from '../github/source.js';
import { JiraIssueTracker, jqlQuote, numberFromKey, type JiraProject } from './client.js';

const REPO = parseRepo('acme/demo');
const REF: IssueRef = { repo: REPO, number: 885 };
const ACCOUNT = 'acc-bot';

const PROJECT: JiraProject = jiraProject() as JiraProject;

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Jira miniature : les routes répondent depuis `routes`, et chaque appel est enregistré. */
function harness(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname + u.search, body });
    const key = `${method} ${u.pathname}`;
    if (!(key in routes)) return new Response('not found', { status: 404 });
    const v = routes[key];
    const payload = typeof v === 'function' ? (v as (b: unknown) => unknown)(body) : v;
    // Un 204 exige un corps null : `''` fait lever le constructeur de Response.
    if (payload === undefined) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;

  const tracker = new JiraIssueTracker({
    site: 'acme.atlassian.net',
    email: 'bot@example.test',
    apiToken: 'jeton',
    projects: [PROJECT],
    fetchImpl,
    retry: { attempts: 1, sleep: async () => {} },
  });
  return { tracker, calls };
}

const issueJson = (over: Record<string, unknown> = {}) => ({
  key: 'PROJ-885',
  fields: {
    summary: 'La photo de profil revient à l’ancienne',
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Elle revient après enregistrement.' }] }] },
    status: { name: 'À faire', statusCategory: { key: 'new' } },
    reporter: { displayName: 'Testeuse', accountId: 'acc-testeuse' },
    assignee: { displayName: 'Robot', accountId: ACCOUNT },
    labels: ['recette'],
    issuetype: { name: 'Bug' },
    fixVersions: [{ name: '8.42.0' }],
    ...over,
  },
});

describe('helpers', () => {
  it('numberFromKey extrait le numéro et refuse ce qui n’en est pas', () => {
    expect(numberFromKey('PROJ-885')).toBe(885);
    expect(numberFromKey('OTHER-12')).toBe(12);
    expect(numberFromKey('sans-numero-')).toBeNull();
  });

  it('jqlQuote échappe les guillemets, pour qu’un statut ne puisse pas casser la requête', () => {
    expect(jqlQuote('En cours')).toBe('"En cours"');
    expect(jqlQuote('a"b')).toBe('"a\\"b"');
  });
});

describe('listCandidates', () => {
  it('interroge le projet, le compte dédié et les statuts candidats', async () => {
    const h = harness({ 'POST /rest/api/3/search/jql': { issues: [{ key: 'PROJ-885' }, { key: 'PROJ-12' }] } });
    const refs = await h.tracker.listCandidates(REPO);
    expect(refs).toEqual([{ repo: REPO, number: 885 }, { repo: REPO, number: 12 }]);
    const jql = (h.calls[0].body as { jql: string }).jql;
    expect(jql).toContain('project = "PROJ"');
    expect(jql).toContain(`assignee = "${ACCOUNT}"`);
    expect(jql).toContain('status IN ("À faire", "En analyse")');
  });

  it('n’envoie pas nextPageToken au premier appel : Jira le refuserait', async () => {
    let n = 0;
    const h = harness({
      'POST /rest/api/3/search/jql': () => (n++ === 0 ? { issues: [{ key: 'PROJ-1' }], nextPageToken: 'tok' } : { issues: [{ key: 'PROJ-2' }] }),
    });
    const refs = await h.tracker.listCandidates(REPO);
    expect(refs.map((r) => r.number)).toEqual([1, 2]);
    expect(h.calls[0].body).not.toHaveProperty('nextPageToken');
    expect((h.calls[1].body as { nextPageToken: string }).nextPageToken).toBe('tok');
  });

  it('ignore une clé illisible plutôt que de faire échouer tout le cycle', async () => {
    const h = harness({ 'POST /rest/api/3/search/jql': { issues: [{ key: 'PROJ-7' }, { key: 'bizarre' }] } });
    expect((await h.tracker.listCandidates(REPO)).map((r) => r.number)).toEqual([7]);
  });
});

describe('listWithStatus', () => {
  it('ne cherche rien pour « blocked » : un ticket rendu n’est plus assigné au compte dédié', async () => {
    const h = harness({});
    expect(await h.tracker.listWithStatus(REPO, 'blocked')).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  it('traduit « in-progress » par le statut configuré', async () => {
    const h = harness({ 'POST /rest/api/3/search/jql': { issues: [{ key: 'PROJ-3' }] } });
    await h.tracker.listWithStatus(REPO, 'in-progress');
    expect((h.calls[0].body as { jql: string }).jql).toContain('status = "En cours"');
  });
});

describe('getIssue', () => {
  it('convertit la description ADF et expose les champs propres à Jira', async () => {
    const h = harness({
      'GET /rest/api/3/issue/PROJ-885': issueJson(),
      'GET /rest/api/3/issue/PROJ-885/comment': {
        comments: [
          { author: { displayName: 'Gabin' }, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Sur quel écran ?' }] }] }, created: '2026-09-16T10:00:00.000Z' },
        ],
      },
    });
    const issue = await h.tracker.getIssue(REF);
    expect(issue.title).toBe('La photo de profil revient à l’ancienne');
    expect(issue.body).toBe('Elle revient après enregistrement.');
    expect(issue.author).toBe('Testeuse');
    expect(issue.state).toBe('open');
    expect(issue.comments).toEqual([{ author: 'Gabin', body: 'Sur quel écran ?', createdAt: '2026-09-16T10:00:00.000Z' }]);
    expect(issue.tracker).toEqual({ key: 'PROJ-885', issueType: 'Bug', fixVersions: ['8.42.0'], status: 'À faire' });
  });

  it('considère fermé un ticket dont la catégorie de statut est « done »', async () => {
    const h = harness({
      'GET /rest/api/3/issue/PROJ-885': issueJson({ status: { name: 'Fermé', statusCategory: { key: 'done' } } }),
      'GET /rest/api/3/issue/PROJ-885/comment': { comments: [] },
    });
    expect((await h.tracker.getIssue(REF)).state).toBe('closed');
  });
});

describe('canTrigger', () => {
  it('accepte quand le ticket nous est assigné et nomme qui l’a assigné', async () => {
    const h = harness({
      'GET /rest/api/3/issue/PROJ-885': issueJson(),
      'GET /rest/api/3/issue/PROJ-885/changelog': {
        values: [
          { author: { displayName: 'Gabin', accountId: 'acc-gabin' }, items: [{ field: 'status' }] },
          { author: { displayName: 'Victor', accountId: 'acc-victor' }, items: [{ field: 'assignee' }] },
        ],
      },
    });
    expect(await h.tracker.canTrigger(REF)).toEqual({ ok: true, login: 'Victor' });
  });

  it('refuse un ticket qui ne nous est pas assigné', async () => {
    const h = harness({ 'GET /rest/api/3/issue/PROJ-885': issueJson({ assignee: { displayName: 'Bastien', accountId: 'acc-bastien' } }) });
    expect(await h.tracker.canTrigger(REF)).toEqual({ ok: false, login: 'Bastien' });
  });

  it('retombe sur le rapporteur quand le changelog est illisible', async () => {
    const h = harness({ 'GET /rest/api/3/issue/PROJ-885': issueJson() });
    expect(await h.tracker.canTrigger(REF)).toEqual({ ok: true, login: 'Testeuse' });
  });
});

describe('assignation', () => {
  it('reprendre la main assigne au compte dédié', async () => {
    const h = harness({ 'PUT /rest/api/3/issue/PROJ-885/assignee': undefined });
    await h.tracker.addTriggerLabel(REF);
    expect(h.calls[0]).toMatchObject({ method: 'PUT', path: '/rest/api/3/issue/PROJ-885/assignee', body: { accountId: ACCOUNT } });
  });

  it('rendre la main réassigne à celui qui avait confié le ticket', async () => {
    const h = harness({
      'GET /rest/api/3/issue/PROJ-885': issueJson(),
      'GET /rest/api/3/issue/PROJ-885/changelog': { values: [{ author: { displayName: 'Victor', accountId: 'acc-victor' }, items: [{ field: 'assignee' }] }] },
      'PUT /rest/api/3/issue/PROJ-885/assignee': undefined,
    });
    await h.tracker.removeTriggerLabel(REF);
    expect(h.calls.at(-1)).toMatchObject({ method: 'PUT', body: { accountId: 'acc-victor' } });
  });

  it('à défaut d’assigneur connu, rend au rapporteur plutôt que de laisser le ticket orphelin', async () => {
    const h = harness({ 'GET /rest/api/3/issue/PROJ-885': issueJson(), 'PUT /rest/api/3/issue/PROJ-885/assignee': undefined });
    await h.tracker.removeTriggerLabel(REF);
    expect(h.calls.at(-1)).toMatchObject({ body: { accountId: 'acc-testeuse' } });
  });
});

describe('setStatus', () => {
  it('enchaîne les transitions jusqu’au statut de travail', async () => {
    let current = 'À faire';
    const next: Record<string, { id: string; to: { name: string } }[]> = {
      'À faire': [{ id: '11', to: { name: 'En analyse' } }],
      'En analyse': [{ id: '21', to: { name: 'Prêt' } }],
      'Prêt': [{ id: '31', to: { name: 'En cours' } }],
      'En cours': [],
    };
    const h = harness({
      'GET /rest/api/3/issue/PROJ-885': () => issueJson({ status: { name: current, statusCategory: { key: 'new' } } }),
      'GET /rest/api/3/issue/PROJ-885/transitions': () => ({ transitions: next[current] ?? [] }),
      'POST /rest/api/3/issue/PROJ-885/transitions': (body: unknown) => {
        const id = (body as { transition: { id: string } }).transition.id;
        current = (next[current] ?? []).find((t) => t.id === id)!.to.name;
        return undefined;
      },
    });
    await h.tracker.setStatus(REF, 'in-progress');
    expect(current).toBe('En cours');
    expect(h.calls.filter((c) => c.method === 'POST').map((c) => (c.body as { transition: { id: string } }).transition.id)).toEqual(['11', '21', '31']);
  });

  it('« blocked » rend la main au lieu de faire reculer la colonne', async () => {
    const h = harness({ 'GET /rest/api/3/issue/PROJ-885': issueJson(), 'PUT /rest/api/3/issue/PROJ-885/assignee': undefined });
    await h.tracker.setStatus(REF, 'blocked');
    expect(h.calls.some((c) => c.path.endsWith('/transitions'))).toBe(false);
    expect(h.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/rest/api/3/issue/PROJ-885/assignee' });
  });

  it('null rend aussi la main : sinon un job annulé laisserait le ticket en cours et assigné au bot', async () => {
    const h = harness({ 'GET /rest/api/3/issue/PROJ-885': issueJson(), 'PUT /rest/api/3/issue/PROJ-885/assignee': undefined });
    await h.tracker.setStatus(REF, null);
    expect(h.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/rest/api/3/issue/PROJ-885/assignee', body: { accountId: 'acc-testeuse' } });
    expect(h.calls.some((c) => c.path.endsWith('/transitions'))).toBe(false);
  });
});

describe('comment', () => {
  it('poste un ADF lisible, pas un bloc de code', async () => {
    const h = harness({ 'POST /rest/api/3/issue/PROJ-885/comment': { id: '1' } });
    await h.tracker.comment(REF, 'Il me manque une info.\n\n- sur quel écran ?\n- avec quel compte ?');
    const body = h.calls[0].body as { body: { content: { type: string }[] } };
    expect(body.body.content.map((c) => c.type)).toEqual(['paragraph', 'bulletList']);
    expect(JSON.stringify(body)).not.toContain('codeBlock');
  });
});

describe('isStillActive', () => {
  it('actif tant que le ticket nous est assigné et n’est pas terminé', async () => {
    const h = harness({ 'GET /rest/api/3/issue/PROJ-885': issueJson() });
    expect(await h.tracker.isStillActive(REF)).toBe(true);
  });

  it('inactif dès qu’un humain le reprend', async () => {
    const h = harness({ 'GET /rest/api/3/issue/PROJ-885': issueJson({ assignee: { displayName: 'Victor', accountId: 'acc-victor' } }) });
    expect(await h.tracker.isStillActive(REF)).toBe(false);
  });
});

describe('configuration', () => {
  it('refuse explicitement un dépôt sans projet Jira configuré', async () => {
    const h = harness({});
    await expect(h.tracker.listCandidates(parseRepo('acme/inconnu'))).rejects.toThrow(/Aucun projet Jira configuré/);
  });
});
