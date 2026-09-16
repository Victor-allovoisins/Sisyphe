import { describe, expect, it } from 'vitest';
import { WORKFLOW } from '../../test/fakes/jira-workflow.js';
import { MAX_HOPS, nextHop, sameStatus, walkTo, type JiraTransition } from './transitions.js';

const ORDER: string[] = [...WORKFLOW];
const t = (id: string, to: string): JiraTransition => ({ id, to: { name: to } });

describe('sameStatus', () => {
  it('ignore la casse et les accents : les libellés Jira sont saisis à la main', () => {
    // Les libellés sont saisis à la main dans Jira : « À faire » et « A faire » désignent le même statut.
    expect(sameStatus('A faire', 'À faire')).toBe(true);
    expect(sameStatus('EN COURS', 'en cours')).toBe(true);
    expect(sameStatus('En revue', 'Terminé')).toBe(false);
  });
});

describe('nextHop', () => {
  it('rien à faire quand on y est déjà', () => {
    expect(nextHop({ current: 'En analyse', target: 'En analyse', available: [], statusesInOrder: ORDER })).toEqual({ kind: 'done' });
  });

  it('emprunte le saut direct quand le workflow l’offre, sans passer par les intermédiaires', () => {
    const r = nextHop({
      current: 'À faire',
      target: 'En cours',
      available: [t('11', 'En analyse'), t('21', 'En cours')],
      statusesInOrder: ORDER,
    });
    expect(r).toEqual({ kind: 'transition', id: '21', to: 'En cours' });
  });

  it('avance d’un cran quand le saut direct n’existe pas', () => {
    const r = nextHop({
      current: 'En analyse',
      target: 'En cours',
      available: [t('31', 'Prêt'), t('32', 'À faire')],
      statusesInOrder: ORDER,
    });
    expect(r).toEqual({ kind: 'transition', id: '31', to: 'Prêt' });
  });

  it('recule d’un cran pour une cible en amont : rendre la main suit le chemin à l’envers', () => {
    const r = nextHop({
      current: 'En cours',
      target: 'En analyse',
      available: [t('41', 'Prêt'), t('42', 'En revue')],
      statusesInOrder: ORDER,
    });
    expect(r).toEqual({ kind: 'transition', id: '41', to: 'Prêt' });
  });

  it('impossible, avec la raison, quand l’étape attendue n’est pas offerte', () => {
    const r = nextHop({ current: 'En analyse', target: 'En revue', available: [t('51', 'Fermé')], statusesInOrder: ORDER });
    expect(r.kind).toBe('impossible');
    expect(r.kind === 'impossible' && r.reason).toContain('Prêt');
  });

  it('impossible quand le statut courant est hors du workflow configuré', () => {
    const r = nextHop({ current: 'En attente client', target: 'En analyse', available: [], statusesInOrder: ORDER });
    expect(r.kind).toBe('impossible');
    expect(r.kind === 'impossible' && r.reason).toContain('statut courant');
  });
});

describe('walkTo', () => {
  /** Jira miniature : un statut courant, et les transitions offertes depuis chaque statut. */
  function fakeJira(start: string, graph: Record<string, JiraTransition[]>) {
    let current = start;
    const applied: string[] = [];
    return {
      get current() {
        return current;
      },
      applied,
      opts: {
        statusesInOrder: ORDER,
        currentStatus: async () => current,
        availableTransitions: async () => graph[current] ?? [],
        apply: async (id: string) => {
          const hop = (graph[current] ?? []).find((x) => x.id === id);
          if (!hop) throw new Error(`transition ${id} indisponible depuis ${current}`);
          applied.push(id);
          current = hop.to.name;
        },
      },
    };
  }

  it('enchaîne les sauts jusqu’à la cible et les rapporte dans l’ordre', async () => {
    const j = fakeJira('À faire', {
      'À faire': [t('1', 'En analyse')],
      'En analyse': [t('2', 'Prêt')],
      'Prêt': [t('3', 'En cours')],
    });
    const r = await walkTo({ target: 'En cours', ...j.opts });
    expect(r.hops).toEqual(['En analyse', 'Prêt', 'En cours']);
    expect(j.current).toBe('En cours');
    expect(j.applied).toEqual(['1', '2', '3']);
  });

  it('ne touche à rien quand le ticket est déjà au bon statut', async () => {
    const j = fakeJira('En revue', { 'En revue': [t('9', 'Terminé')] });
    const r = await walkTo({ target: 'En revue', ...j.opts });
    expect(r.hops).toEqual([]);
    expect(j.applied).toEqual([]);
  });

  it('relit le statut après chaque saut : une transition qui aboutit ailleurs ne fait pas dérailler la marche', async () => {
    // La transition 1 annonce « En analyse » mais un post-fonction Jira pousse jusqu’à « A développer ».
    let current = 'À faire';
    const applied: string[] = [];
    const r = await walkTo({
      target: 'En cours',
      statusesInOrder: ORDER,
      currentStatus: async () => current,
      availableTransitions: async () =>
        current === 'À faire' ? [t('1', 'En analyse')] : current === 'Prêt' ? [t('3', 'En cours')] : [],
      apply: async (id) => {
        applied.push(id);
        current = id === '1' ? 'Prêt' : 'En cours';
      },
    });
    expect(applied).toEqual(['1', '3']);
    expect(r.hops).toEqual(['En analyse', 'En cours']);
    expect(current).toBe('En cours');
  });

  it('échoue en nommant la cible quand une étape manque', async () => {
    const j = fakeJira('En analyse', { 'En analyse': [t('7', 'Fermé')] });
    await expect(walkTo({ target: 'En revue', ...j.opts })).rejects.toThrow(/impossible.*Prêt/s);
  });

  it('abandonne au-delà du plafond de sauts plutôt que de boucler', async () => {
    // Chaque saut est offert, mais un post-fonction ramène toujours au départ : la cible n’arrive jamais.
    let current = 'À faire';
    const promise = walkTo({
      target: 'Terminé',
      statusesInOrder: ORDER,
      // Toujours l’étape attendue, donc jamais « impossible » : seul le plafond peut arrêter la marche.
      availableTransitions: async () => [t('x', ORDER[ORDER.indexOf(current) + 1] ?? 'En analyse')],
      currentStatus: async () => current,
      apply: async () => {
        current = 'À faire';
      },
    });
    await expect(promise).rejects.toThrow(new RegExp(`${MAX_HOPS} sauts`));
  });
});
