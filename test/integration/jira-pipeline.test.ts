import { describe, expect, it } from 'vitest';
import { JIRA_STATUSES_DEFAULT } from '../../src/config/machine.js';
import { JiraIssueTracker } from '../../src/jira/client.js';
import { runJob } from '../../src/jobs/pipeline.js';
import { remoteBranchSha, remoteCommitMessage } from '../helpers/git-fixture.js';
import { REPO, makeHarness, readyVerdict, repoRef, report, writeFeature } from '../helpers/harness.js';

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
const ISSUE_7 = { repo: repoRef, number: 7 };
/** La colonne de travail, celle que `inProgressStatus` désigne — le filet ne bouge un ticket que depuis elle. */
const TRAVAIL = 'En développement';
/**
 * Le statut d'attente du projet, comme BACK le tient : **hors de `ORDER`**, et il doit le rester. C'est ce
 * qui en fait un statut de côté — il n'est sur aucun chemin d'avancement, et rien d'autre que la transition
 * latérale offerte plus bas n'y mène. L'y ajouter ferait aboutir les tests par la marche de proche en
 * proche, donc pour une tout autre raison que celle qu'ils prétendent prouver.
 */
const ATTENTE = "En attente d'informations";

/** Ce que la phase `jira` rend quand elle a fait son travail : elle a transitionné et rédigé son texte. */
const jiraOk = { status: 'En relecture', comment: '🪨 PR prête : https://example.test/pr/1', note: '' };
/** Ce qu'elle rend quand elle n'a rien pu faire : c'est le cas que le filet doit rattraper. */
const jiraMuet = { status: '', comment: '', note: 'coincé' };

/** Jira factice : un statut, un assigné, et un graphe de transitions qui suit le workflow réel. */
function fakeJira(start = 'Nouveau') {
  const state = { status: start, assignee: ACCOUNT as string | null, comments: [] as string[] };
  const transitionsFrom = (s: string) => {
    // Depuis le statut d'attente, une seule issue : revenir dans la colonne de travail. Un statut de côté
    // n'ouvre sur aucune étape du chemin d'avancement — sans quoi il serait sur le chemin.
    if (s === ATTENTE) return [{ id: 'retour-attente', to: { name: TRAVAIL } }];
    const i = ORDER.indexOf(s);
    const out: { id: string; to: { name: string } }[] = [];
    if (i > 0) out.push({ id: `back-${i}`, to: { name: ORDER[i - 1] } });
    if (i >= 0 && i < ORDER.length - 1) out.push({ id: `fwd-${i}`, to: { name: ORDER[i + 1] } });
    // La transition latérale : offerte depuis la colonne de travail seulement, et vers un statut que
    // `ORDER` ignore. C'est le saut direct de `walkTo` qui l'emprunte, jamais la marche.
    if (s === TRAVAIL) out.push({ id: 'vers-attente', to: { name: ATTENTE } });
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

/**
 * `blockedStatus` n'est posé que sur la config machine : c'est elle, et non le client câblé, que `closeTicket`
 * lit pour décider — et `transitionTo` prend son statut cible en argument, sans jamais consulter le projet.
 */
async function harnessOn(
  jiraTracker: JiraIssueTracker,
  steps: Parameters<typeof makeHarness>[0]['steps'],
  extraBranches?: string[],
  blockedStatus?: string,
) {
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
        inProgressStatus: TRAVAIL, doneStatus: 'En relecture',
        ...(blockedStatus ? { blockedStatus } : {}),
      }],
    },
  };
  return h;
}

describe('pipeline sur Jira', () => {
  it('fait avancer le ticket jusqu’à « En relecture » et ouvre la PR sur la release', async () => {
    const j = fakeJira();
    const h = await harnessOn(j.tracker, [
      { output: readyVerdict },
      { output: report('Créé'), sideEffect: writeFeature('hello\n') },
      // La phase `jira` : c'est elle, désormais, qui pose le ticket en relecture. Le pas passe par le vrai
      // tracker plutôt que d'écrire `j.state.status`, pour que la marche de proche en proche reste jouée —
      // c'est elle que ce test prouve, et une écriture directe la contournerait.
      { output: jiraOk, sideEffect: async () => { await j.tracker.setStatus(ISSUE_7, 'done'); } },
    ], ['release/8.42.0']);
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());

    expect(done.state).toBe('done');
    // La marche a bien traversé les colonnes intermédiaires, sans en sauter.
    expect(j.state.status).toBe('En relecture');
    expect(j.state.assignee).toBe(ACCOUNT);
    expect(h.source.pulls[0].base).toBe('release/8.42.0');
    // Le câblage `deliver({ ticket })` du pipeline : sans lui, `ticket` resterait `null` en silence même
    // avec un vrai JiraIssueTracker, et l'app GitHub for Jira ne retrouverait jamais le ticket.
    expect(h.source.pulls[0].title).toContain('IOS-7');
    expect(h.source.pulls[0].body).toContain('Ticket: [IOS-7](https://allovoisins.atlassian.net/browse/IOS-7)');
    expect(h.source.pulls[0].body).not.toContain('Closes #');
    // Le commit poussé est l'autre moitié du repérage par l'app GitHub for Jira ; sans la clé dedans,
    // ni `Closes` (qui fermerait une issue GitHub sans rapport sous suivi Jira).
    const sha = await remoteBranchSha(h.remotePath, done.branch!);
    const commit = await remoteCommitMessage(h.remotePath, sha!);
    expect(commit).toContain('IOS-7');
    expect(commit).not.toContain('Closes');
  });

  it('rend la main, sans quitter la colonne de travail, quand le triage bloque', async () => {
    const j = fakeJira();
    const blocked = { ...readyVerdict, verdict: 'needs_clarification', note: 'Il manque un écran.', questions: ['Quel écran ?'] };
    // La phase `jira` ne dit rien : c'est le filet qui rend la main et qui poste le message scripté. Et le
    // projet n'a pas de statut d'attente configuré — le cas de tous ceux qui existent aujourd'hui : le
    // ticket est donc rendu là où il est, comportement d'avant `blockedStatus`.
    const h = await harnessOn(j.tracker, [{ output: blocked }, { output: jiraMuet }]);
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
      // En production la phase `jira` ne tourne pas ici : son signal est déjà abattu, le runner refuse. Le
      // runner scripté, lui, ignore le signal ; ce pas tient donc la place du rapport vide que `runJiraPhase`
      // rend dans ce cas, et c'est bien le filet qui doit rendre le ticket.
      { output: jiraMuet },
    ]);
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const left = await runJob(job.id, h.deps, controller.signal);

    expect(left.state).toBe('cancelled');
    // Sans remise de la main, le ticket resterait « En développement » et assigné au bot : hors des statuts
    // candidats, donc jamais repris, et assigné à un compte qui ne le traitera plus.
    expect(j.state.assignee).toBe('acc-victor');
  });

  it('ouvre une phase jira à la fin du job', async () => {
    const j = fakeJira();
    const h = await harnessOn(j.tracker, [
      { output: readyVerdict },
      { output: report('Créé'), sideEffect: writeFeature('hello\n') },
      { output: jiraOk, sideEffect: async () => { j.state.status = 'En relecture'; } },
    ], ['release/8.42.0']);
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    await runJob(job.id, h.deps, signal());

    expect(h.deps.phases.listForJob(job.id).map((p) => p.name)).toContain('jira');
    expect(j.state.status).toBe('En relecture');
  });

  it('rend le ticket lui-même quand la phase jira ne l’a pas fait', async () => {
    const j = fakeJira();
    const blocked = { ...readyVerdict, verdict: 'needs_clarification', note: 'Il manque un écran.', questions: ['Quel écran ?'] };
    const h = await harnessOn(j.tracker, [{ output: blocked }, { output: jiraMuet }]);
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    await runJob(job.id, h.deps, signal());

    // Invariant 1 : un job non livré ne laisse jamais le ticket assigné au compte dédié.
    expect(j.state.assignee).toBe('acc-victor');
    // Invariant 2 : un job terminé laisse toujours une trace.
    expect(j.state.comments.join('\n')).toContain('🪨');
  });

  it('porte la question du triage jusqu’au ticket, via le brouillon donné à la phase jira', async () => {
    const j = fakeJira();
    const blocked = { ...readyVerdict, verdict: 'needs_clarification', note: 'Il manque un écran.', questions: ['Quel écran ?'] };
    // Un agent qui reprend le brouillon reçu, comme le skill le lui demande. `output` et la closure partagent
    // le même objet : c'est le seul moyen, avec un runner scripté, de faire dépendre la sortie de l'entrée.
    const repris = { status: '', comment: '', note: '' };
    const h = await harnessOn(j.tracker, [
      { output: blocked },
      { output: repris, sideEffect: async (opts) => { repris.comment = `🪨 Reformulé par l’agent.\n\n${opts.prompt}`; } },
    ]);
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    await runJob(job.id, h.deps, signal());

    // Le commentaire posté est celui de l'agent — et il ne mange plus la question du triage. Son jumeau
    // GitHub (`test/integration/pipeline.test.ts`) attend la même question sur l'issue.
    expect(j.state.comments).toHaveLength(1);
    expect(j.state.comments.join('\n')).toContain('Quel écran ?');
  });

  it('pose lui-même le statut de relecture quand la phase jira ne l’a pas fait', async () => {
    const j = fakeJira();
    const h = await harnessOn(j.tracker, [
      { output: readyVerdict },
      { output: report('Créé'), sideEffect: writeFeature('hello\n') },
      { output: jiraMuet },
    ], ['release/8.42.0']);
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());

    expect(done.state).toBe('done');
    // Personne d'autre ne transitionne : sans ce rattrapage le ticket reste « En développement » jusqu'au
    // prochain démarrage du daemon.
    expect(j.state.status).toBe('En relecture');
    // Voulu : un travail soumis à relecture n'est pas un travail abandonné, le ticket reste au compte dédié.
    expect(j.state.assignee).toBe(ACCOUNT);
  });

  it('ne fait pas reculer un ticket déjà avancé au-delà du statut de relecture', async () => {
    const j = fakeJira();
    const h = await harnessOn(j.tracker, [
      { output: readyVerdict },
      { output: report('Créé'), sideEffect: writeFeature('hello\n') },
      // La phase jira ne dit rien, mais le ticket a déjà avancé au-delà de `doneStatus` — mesuré : un ticket
      // sur « Developpement fini », toujours assigné au compte dédié, l'état normal après une livraison.
      { output: jiraMuet, sideEffect: async () => { j.state.status = 'Developpement fini'; } },
    ], ['release/8.42.0']);
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());

    expect(done.state).toBe('done');
    // Le ticket ne recule pas vers « En relecture » : il reste où il était.
    expect(j.state.status).toBe('Developpement fini');
    expect(j.state.assignee).toBe(ACCOUNT);
  });

  /**
   * Un ticket bloqué quitte la colonne de travail quand le projet donne un statut où l'attendre. Sinon il
   * reste où il est — sans assigné sur « En développement », c'est-à-dire du travail en cours sur lequel
   * personne n'est : la panne que ce statut de côté vient couvrir.
   */
  describe('le statut d’attente du projet', () => {
    const blocked = { ...readyVerdict, verdict: 'needs_clarification', note: 'Il manque un écran.', questions: ['Quel écran ?'] };

    it('y pose le ticket bloqué, puis le rend, quand la phase jira ne l’a pas fait', async () => {
      const j = fakeJira();
      const h = await harnessOn(j.tracker, [{ output: blocked }, { output: jiraMuet }], undefined, ATTENTE);
      const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
      const done = await runJob(job.id, h.deps, signal());

      expect(done.state).toBe('blocked');
      // Le saut direct de `walkTo` : « En attente d'informations » n'est dans aucun `statusesInOrder`, seule
      // la transition latérale offerte depuis la colonne de travail y mène.
      expect(j.state.status).toBe(ATTENTE);
      // Déplacé *et* rendu : le déplacement ne remplace pas le rendu, il le complète.
      expect(j.state.assignee).toBe('acc-victor');
      expect(j.state.comments.join('\n')).toContain('🪨');
    });

    it('ne ramène pas en arrière un ticket qu’un humain a déjà déplacé', async () => {
      const j = fakeJira();
      // Quelqu'un a repris le ticket pendant le job et l'a renvoyé en analyse : le filet n'a rien à y faire.
      const h = await harnessOn(
        j.tracker,
        [{ output: blocked }, { output: jiraMuet, sideEffect: async () => { j.state.status = 'En analyse'; } }],
        undefined,
        ATTENTE,
      );
      const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
      await runJob(job.id, h.deps, signal());

      expect(j.state.status).toBe('En analyse');
      expect(j.state.assignee).toBe('acc-victor');
    });

    it('ne reçoit pas les jobs en échec : un secret détecté n’attend aucune information', async () => {
      const j = fakeJira();
      const h = await harnessOn(j.tracker, [
        { output: readyVerdict },
        { output: report('v1'), sideEffect: writeFeature('hello\n') },
        { output: jiraMuet },
      ], undefined, ATTENTE);
      h.deps.scan = async () => [{ file: 'src/feature.txt', ruleId: 'aws-access-token', line: 5 }];
      const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
      const done = await runJob(job.id, h.deps, signal());

      expect(done.state).toBe('failed');
      // Un refus, pas une attente : le ticket est rendu là où il est, comme avant.
      expect(j.state.status).toBe(TRAVAIL);
      expect(j.state.assignee).toBe('acc-victor');
    });
  });

  /**
   * Les trois façons dont le filet sautait quand il était du code en ligne, conditionné au rapport de
   * l'agent et hors de tout `finally`. Chacune a été mesurée sur le ticket : statut « En développement »,
   * assigné au compte dédié — hors des statuts candidats, donc repris par personne et vu par personne.
   */
  describe('le filet ne dépend ni de ce que l’agent déclare ni de sa bonne fin', () => {
    const blocked = { ...readyVerdict, verdict: 'needs_clarification', note: 'Il manque un écran.', questions: ['Quel écran ?'] };

    it('rend le ticket alors que la phase jira affirme l’avoir déjà rendu', async () => {
      const j = fakeJira();
      // `handedBack` n'existe plus au schéma ; le champ reste ici pour dire ce que le test rejoue : un agent
      // qui se croit quitte de son `assign --back`, mode d'échec attendu d'une consigne que le SKILL lui donne.
      const menteur = { status: '', comment: '🪨 Le ticket vous est rendu.', handedBack: true, note: '' };
      const h = await harnessOn(j.tracker, [{ output: blocked }, { output: menteur }]);
      const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
      await runJob(job.id, h.deps, signal());

      expect(j.state.assignee).toBe('acc-victor');
    });

    it('rend le ticket quand canTrigger tombe : une erreur ne vaut pas « pas à nous »', async () => {
      const j = fakeJira();
      const h = await harnessOn(j.tracker, [{ output: blocked }, { output: jiraMuet }]);
      // Deux GET, juste après un tour d'agent qui peut durer des minutes : c'est la panne la plus probable.
      j.tracker.canTrigger = async () => {
        throw new Error('Jira GET /rest/api/3/issue/IOS-7 → 503');
      };
      const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
      await runJob(job.id, h.deps, signal());

      expect(j.state.assignee).toBe('acc-victor');
    });

    it('rend le ticket et commente même si la phase jira ne démarre pas', async () => {
      const j = fakeJira();
      const h = await harnessOn(j.tracker, [{ output: blocked }]);
      // Un `throw` entre la sortie du pipeline et le filet : ici l'ouverture de la phase sur une base verrouillée.
      const start = h.deps.phases.start.bind(h.deps.phases);
      h.deps.phases.start = (input) => {
        if (input.name === 'jira') throw new Error('database is locked');
        return start(input);
      };
      const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
      await runJob(job.id, h.deps, signal());

      expect(j.state.assignee).toBe('acc-victor');
      // L'invariant 2 tombait avec le premier : sans commentaire, rien ne dit non plus pourquoi le job s'arrête.
      expect(j.state.comments).toHaveLength(1);
      expect(j.state.comments.join('\n')).toContain('🪨');
    });
  });

  it('poste le texte rédigé par la phase jira, et lui seul', async () => {
    const j = fakeJira();
    const h = await harnessOn(j.tracker, [
      { output: readyVerdict },
      { output: report('Créé'), sideEffect: writeFeature('hello\n') },
      { output: jiraOk },
    ], ['release/8.42.0']);
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    await runJob(job.id, h.deps, signal());

    // Un seul commentaire, et c'est celui de l'agent : le message scripté ne doit pas s'y ajouter.
    expect(j.state.comments).toHaveLength(1);
    expect(j.state.comments[0]).toContain('https://example.test/pr/1');
  });
});
