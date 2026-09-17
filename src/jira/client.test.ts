import { describe, expect, it } from 'vitest';
import { JIRA_STATUSES_DEFAULT } from '../config/machine.js';
import { parseRepo, type IssueRef } from '../github/source.js';
import { JiraIssueTracker, jqlQuote, numberFromKey, searchAccounts, type JiraProject } from './client.js';

const REPO = parseRepo('ILokYou/ILokYou-iOS');
const REF: IssueRef = { repo: REPO, number: 885 };
const ACCOUNT = 'acc-sisyphe-ios';

const PROJECT: JiraProject = {
  key: 'IOS',
  accountId: ACCOUNT,
  repo: 'ILokYou/ILokYou-iOS',
  candidateStatuses: ['Nouveau', 'En analyse'],
  statusesInOrder: [...JIRA_STATUSES_DEFAULT],
  inProgressStatus: 'En développement',
  doneStatus: 'En relecture',
};

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
    site: 'allovoisins.atlassian.net',
    email: 'bot@example.test',
    apiToken: 'jeton',
    projects: [PROJECT],
    fetchImpl,
    retry: { attempts: 1, sleep: async () => {} },
  });
  return { tracker, calls };
}

const issueJson = (over: Record<string, unknown> = {}) => ({
  key: 'IOS-885',
  fields: {
    summary: 'La photo de profil revient à l’ancienne',
    description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Elle revient après enregistrement.' }] }] },
    status: { name: 'Nouveau', statusCategory: { key: 'new' } },
    reporter: { displayName: 'Testeuse', accountId: 'acc-testeuse' },
    assignee: { displayName: 'Sisyphe iOS', accountId: ACCOUNT },
    labels: ['recette'],
    issuetype: { name: 'Bug PROD' },
    fixVersions: [{ name: '8.42.0' }],
    ...over,
  },
});

describe('helpers', () => {
  it('numberFromKey extrait le numéro et refuse ce qui n’en est pas', () => {
    expect(numberFromKey('IOS-885')).toBe(885);
    expect(numberFromKey('WEBFRONT-12')).toBe(12);
    expect(numberFromKey('sans-numero-')).toBeNull();
  });

  it('jqlQuote échappe les guillemets, pour qu’un statut ne puisse pas casser la requête', () => {
    expect(jqlQuote('En développement')).toBe('"En développement"');
    expect(jqlQuote('a"b')).toBe('"a\\"b"');
  });
});

describe('searchAccounts', () => {
  /** Jira miniature : deux endpoints, chacun avec sa propre réponse. */
  function accountFetch(bySearch: unknown, byPicker: unknown) {
    const paths: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      const u = new URL(String(url));
      paths.push(u.pathname);
      const body = u.pathname.endsWith('/user/search') ? bySearch : byPicker;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { paths, cfg: { site: 'acme.atlassian.net', email: 'a@b.test', apiToken: 'jeton', fetchImpl } };
  }

  it('se contente de user/search quand il répond', async () => {
    const h = accountFetch([{ accountId: 'acc-1', displayName: 'Robot', emailAddress: 'r@x.test' }], { users: [] });
    const found = await searchAccounts(h.cfg, 'robot');
    expect(found).toEqual([{ accountId: 'acc-1', displayName: 'Robot', emailAddress: 'r@x.test' }]);
    expect(h.paths).toEqual(['/rest/api/3/user/search']);
  });

  it('bascule sur le sélecteur quand la recherche ne rend rien : une adresse masquée n’y est pas appariée', async () => {
    const h = accountFetch([], { users: [{ accountId: 'acc-2', displayName: 'Agent IA' }] });
    const found = await searchAccounts(h.cfg, 'ia+jira@x.test');
    expect(found).toEqual([{ accountId: 'acc-2', displayName: 'Agent IA', emailAddress: undefined }]);
    expect(h.paths).toEqual(['/rest/api/3/user/search', '/rest/api/3/user/picker']);
  });

  it('rend une liste vide quand les deux échouent, sans lever', async () => {
    const h = accountFetch([], { users: [] });
    expect(await searchAccounts(h.cfg, 'inconnu')).toEqual([]);
  });
});

describe('listCandidates', () => {
  it('interroge le projet, le compte dédié et les statuts candidats', async () => {
    const h = harness({ 'POST /rest/api/3/search/jql': { issues: [{ key: 'IOS-885' }, { key: 'IOS-12' }] } });
    const refs = await h.tracker.listCandidates(REPO);
    expect(refs).toEqual([{ repo: REPO, number: 885 }, { repo: REPO, number: 12 }]);
    const jql = (h.calls[0].body as { jql: string }).jql;
    expect(jql).toContain('project = "IOS"');
    expect(jql).toContain(`assignee = "${ACCOUNT}"`);
    expect(jql).toContain('status IN ("Nouveau", "En analyse")');
  });

  it('n’envoie pas nextPageToken au premier appel : Jira le refuserait', async () => {
    let n = 0;
    const h = harness({
      'POST /rest/api/3/search/jql': () => (n++ === 0 ? { issues: [{ key: 'IOS-1' }], nextPageToken: 'tok' } : { issues: [{ key: 'IOS-2' }] }),
    });
    const refs = await h.tracker.listCandidates(REPO);
    expect(refs.map((r) => r.number)).toEqual([1, 2]);
    expect(h.calls[0].body).not.toHaveProperty('nextPageToken');
    expect((h.calls[1].body as { nextPageToken: string }).nextPageToken).toBe('tok');
  });

  it('ignore une clé illisible plutôt que de faire échouer tout le cycle', async () => {
    const h = harness({ 'POST /rest/api/3/search/jql': { issues: [{ key: 'IOS-7' }, { key: 'bizarre' }] } });
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
    const h = harness({ 'POST /rest/api/3/search/jql': { issues: [{ key: 'IOS-3' }] } });
    await h.tracker.listWithStatus(REPO, 'in-progress');
    expect((h.calls[0].body as { jql: string }).jql).toContain('status = "En développement"');
  });
});

describe('getIssue', () => {
  it('convertit la description ADF et expose les champs propres à Jira', async () => {
    const h = harness({
      'GET /rest/api/3/issue/IOS-885': issueJson(),
      'GET /rest/api/3/issue/IOS-885/comment': {
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
    expect(issue.tracker).toEqual({ key: 'IOS-885', issueType: 'Bug PROD', fixVersions: ['8.42.0'], status: 'Nouveau' });
  });

  it('considère fermé un ticket dont la catégorie de statut est « done »', async () => {
    const h = harness({
      'GET /rest/api/3/issue/IOS-885': issueJson({ status: { name: 'Fermé', statusCategory: { key: 'done' } } }),
      'GET /rest/api/3/issue/IOS-885/comment': { comments: [] },
    });
    expect((await h.tracker.getIssue(REF)).state).toBe('closed');
  });
});

describe('canTrigger', () => {
  it('accepte quand le ticket nous est assigné et nomme qui l’a assigné', async () => {
    const h = harness({
      'GET /rest/api/3/issue/IOS-885': issueJson(),
      'GET /rest/api/3/issue/IOS-885/changelog': {
        values: [
          { author: { displayName: 'Gabin', accountId: 'acc-gabin' }, items: [{ field: 'status' }] },
          { author: { displayName: 'Victor', accountId: 'acc-victor' }, items: [{ field: 'assignee' }] },
        ],
      },
    });
    expect(await h.tracker.canTrigger(REF)).toEqual({ ok: true, login: 'Victor' });
  });

  it('refuse un ticket qui ne nous est pas assigné', async () => {
    const h = harness({ 'GET /rest/api/3/issue/IOS-885': issueJson({ assignee: { displayName: 'Bastien', accountId: 'acc-bastien' } }) });
    expect(await h.tracker.canTrigger(REF)).toEqual({ ok: false, login: 'Bastien' });
  });

  it('retombe sur le rapporteur quand le changelog est illisible', async () => {
    const h = harness({ 'GET /rest/api/3/issue/IOS-885': issueJson() });
    expect(await h.tracker.canTrigger(REF)).toEqual({ ok: true, login: 'Testeuse' });
  });
});

describe('assignation', () => {
  it('reprendre la main assigne au compte dédié', async () => {
    const h = harness({ 'PUT /rest/api/3/issue/IOS-885/assignee': undefined });
    await h.tracker.addTriggerLabel(REF);
    expect(h.calls[0]).toMatchObject({ method: 'PUT', path: '/rest/api/3/issue/IOS-885/assignee', body: { accountId: ACCOUNT } });
  });

  it('rendre la main réassigne à celui qui avait confié le ticket', async () => {
    const h = harness({
      'GET /rest/api/3/issue/IOS-885': issueJson(),
      'GET /rest/api/3/issue/IOS-885/changelog': { values: [{ author: { displayName: 'Victor', accountId: 'acc-victor' }, items: [{ field: 'assignee' }] }] },
      'PUT /rest/api/3/issue/IOS-885/assignee': undefined,
    });
    await h.tracker.removeTriggerLabel(REF);
    expect(h.calls.at(-1)).toMatchObject({ method: 'PUT', body: { accountId: 'acc-victor' } });
  });

  it('à défaut d’assigneur connu, rend au rapporteur plutôt que de laisser le ticket orphelin', async () => {
    const h = harness({ 'GET /rest/api/3/issue/IOS-885': issueJson(), 'PUT /rest/api/3/issue/IOS-885/assignee': undefined });
    await h.tracker.removeTriggerLabel(REF);
    expect(h.calls.at(-1)).toMatchObject({ body: { accountId: 'acc-testeuse' } });
  });
});

describe('setStatus', () => {
  it('enchaîne les transitions jusqu’au statut de travail', async () => {
    let current = 'Nouveau';
    const next: Record<string, { id: string; to: { name: string } }[]> = {
      Nouveau: [{ id: '11', to: { name: 'En analyse' } }],
      'En analyse': [{ id: '21', to: { name: 'A développer' } }],
      'A développer': [{ id: '31', to: { name: 'En développement' } }],
      'En développement': [],
    };
    const h = harness({
      'GET /rest/api/3/issue/IOS-885': () => issueJson({ status: { name: current, statusCategory: { key: 'new' } } }),
      'GET /rest/api/3/issue/IOS-885/transitions': () => ({ transitions: next[current] ?? [] }),
      'POST /rest/api/3/issue/IOS-885/transitions': (body: unknown) => {
        const id = (body as { transition: { id: string } }).transition.id;
        current = (next[current] ?? []).find((t) => t.id === id)!.to.name;
        return undefined;
      },
    });
    await h.tracker.setStatus(REF, 'in-progress');
    expect(current).toBe('En développement');
    expect(h.calls.filter((c) => c.method === 'POST').map((c) => (c.body as { transition: { id: string } }).transition.id)).toEqual(['11', '21', '31']);
  });

  it('« blocked » rend la main au lieu de faire reculer la colonne', async () => {
    const h = harness({ 'GET /rest/api/3/issue/IOS-885': issueJson(), 'PUT /rest/api/3/issue/IOS-885/assignee': undefined });
    await h.tracker.setStatus(REF, 'blocked');
    expect(h.calls.some((c) => c.path.endsWith('/transitions'))).toBe(false);
    expect(h.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/rest/api/3/issue/IOS-885/assignee' });
  });

  it('null rend aussi la main : sinon un job annulé laisserait le ticket en cours et assigné au bot', async () => {
    const h = harness({ 'GET /rest/api/3/issue/IOS-885': issueJson(), 'PUT /rest/api/3/issue/IOS-885/assignee': undefined });
    await h.tracker.setStatus(REF, null);
    expect(h.calls.at(-1)).toMatchObject({ method: 'PUT', path: '/rest/api/3/issue/IOS-885/assignee', body: { accountId: 'acc-testeuse' } });
    expect(h.calls.some((c) => c.path.endsWith('/transitions'))).toBe(false);
  });
});

describe('comment', () => {
  it('poste un ADF lisible, pas un bloc de code', async () => {
    const h = harness({ 'POST /rest/api/3/issue/IOS-885/comment': { id: '1' } });
    await h.tracker.comment(REF, 'Il me manque une info.\n\n- sur quel écran ?\n- avec quel compte ?');
    const body = h.calls[0].body as { body: { content: { type: string }[] } };
    expect(body.body.content.map((c) => c.type)).toEqual(['paragraph', 'bulletList']);
    expect(JSON.stringify(body)).not.toContain('codeBlock');
  });
});

describe('isStillActive', () => {
  it('actif tant que le ticket nous est assigné et n’est pas terminé', async () => {
    const h = harness({ 'GET /rest/api/3/issue/IOS-885': issueJson() });
    expect(await h.tracker.isStillActive(REF)).toBe(true);
  });

  it('inactif dès qu’un humain le reprend', async () => {
    const h = harness({ 'GET /rest/api/3/issue/IOS-885': issueJson({ assignee: { displayName: 'Victor', accountId: 'acc-victor' } }) });
    expect(await h.tracker.isStillActive(REF)).toBe(false);
  });
});

describe('refFromKey', () => {
  it('résout une clé vers le dépôt du projet qui la sert', () => {
    const tracker = new JiraIssueTracker({
      site: 'allovoisins.atlassian.net',
      email: 'bot@example.test',
      apiToken: 'jeton',
      projects: [PROJECT],
    });
    expect(tracker.refFromKey('IOS-885')).toEqual({ repo: REPO, number: 885 });
    expect(() => tracker.refFromKey('BACK-1')).toThrow(/BACK/);
    expect(() => tracker.refFromKey('IOS')).toThrow(/IOS/);
  });
});

describe('listTransitions', () => {
  it('rend les transitions telles que l’API les donne, sans les transformer', async () => {
    const transitions = [
      { id: '21', to: { name: 'A développer' } },
      { id: '31', to: { name: 'En développement' } },
    ];
    const h = harness({ 'GET /rest/api/3/issue/IOS-885/transitions': { transitions } });
    expect(await h.tracker.listTransitions(REF)).toEqual(transitions);
  });
});

describe('get', () => {
  it('ne laisse passer qu’un chemin de lecture de l’API Jira', async () => {
    const h = harness({ 'GET /rest/api/3/issue/IOS-885/changelog': { values: [] } });
    await h.tracker.get('/rest/api/3/issue/IOS-885/changelog');
    expect(h.calls).toEqual([{ method: 'GET', path: '/rest/api/3/issue/IOS-885/changelog', body: undefined }]);

    // Les quatre derniers ne sortent de l'API qu'une fois l'URL normalisée — ce que fait `fetch`, et que la
    // chaîne brute ne montre pas : `/rest/api/.%2e/.%2e/wiki/rest/api/content` atterrit sur `/wiki/…`,
    // c'est-à-dire Confluence, avec le jeton du compte dédié.
    const bads = [
      'https://evil.example/x',
      '/rest/api/3/../../admin',
      'rest/api/3/issue',
      '/plugins/servlet/x',
      '/rest/api/.%2e/.%2e/wiki/rest/api/content',
      '/rest/api/%2e%2e/%2e%2e/wiki',
      '/rest/api/%2e./%2e./wiki',
      '/rest/api/%2E%2E/%2E%2E/wiki',
      // `%2f`/`%5c` ne se décodent pas en séparateur ici — `pathname` les garde tels quels, donc ces chemins
      // restent sous `/rest/api/` et passeraient les deux contrôles ci-dessus. On ne sait pas si le routeur
      // d'Atlassian les décode avant de router ; le garde les refuse donc lui-même, sans compter dessus.
      '/rest/api/3/..%2f..%2fwiki/rest/api/content',
      '/rest/api/3/..%2F..%2Fwiki/rest/api/content',
      '/rest/api/3/issue%5c..%5cadmin',
    ];
    for (const bad of bads) {
      await expect(h.tracker.get(bad)).rejects.toThrow(/chemin/i);
    }
    // Ce que le titre promet et que les `rejects` seuls ne montraient pas : aucun de ces chemins n'est parti.
    expect(h.calls).toHaveLength(1);
  });

  it('transmet le chemin normalisé, pas la chaîne reçue', async () => {
    const h = harness({ 'GET /rest/api/3/issue/IOS-885/changelog': { values: [] } });
    await h.tracker.get('/rest/api/3/./issue/IOS-885/changelog?maxResults=1');
    expect(h.calls).toEqual([{ method: 'GET', path: '/rest/api/3/issue/IOS-885/changelog?maxResults=1', body: undefined }]);
  });

  it('laisse passer un `..` dans la chaîne de requête : seul le chemin est jugé', async () => {
    const h = harness({ 'GET /rest/api/3/issue/IOS-885/changelog': { values: [] } });
    // Un JQL légitime peut porter `..` (une plage de dates, par exemple) : le refus de `%2f`/`%5c` ne doit
    // juger que `pathname`, jamais `search`.
    await h.tracker.get('/rest/api/3/issue/IOS-885/changelog?jql=note ~ "a..b"');
    expect(h.calls).toEqual([{ method: 'GET', path: '/rest/api/3/issue/IOS-885/changelog?jql=note%20~%20%22a..b%22', body: undefined }]);
  });
});

describe('configuration', () => {
  it('refuse explicitement un dépôt sans projet Jira configuré', async () => {
    const h = harness({});
    await expect(h.tracker.listCandidates(parseRepo('ILokYou/inconnu'))).rejects.toThrow(/Aucun projet Jira configuré/);
  });
});
