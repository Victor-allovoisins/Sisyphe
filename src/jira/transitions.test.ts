import { describe, expect, it } from 'vitest';
import { JIRA_STATUSES_DEFAULT } from '../config/machine.js';
import { MAX_HOPS, nextHop, sameStatus, walkTo, type JiraTransition } from './transitions.js';

const ORDER: string[] = [...JIRA_STATUSES_DEFAULT];
const t = (id: string, to: string): JiraTransition => ({ id, to: { name: to } });

describe('sameStatus', () => {
  it('ignore la casse et les accents : « Developpement fini » s’écrit sans accent dans Jira', () => {
    expect(sameStatus('Developpement fini', 'Développement fini')).toBe(true);
    expect(sameStatus('EN DÉVELOPPEMENT', 'en developpement')).toBe(true);
    expect(sameStatus('En relecture', 'Developpement fini')).toBe(false);
  });
});

describe('nextHop', () => {
  it('rien à faire quand on y est déjà', () => {
    expect(nextHop({ current: 'En analyse', target: 'En analyse', available: [], statusesInOrder: ORDER })).toEqual({ kind: 'done' });
  });

  it('emprunte le saut direct quand le workflow l’offre, sans passer par les intermédiaires', () => {
    const r = nextHop({
      current: 'Nouveau',
      target: 'En développement',
      available: [t('11', 'En analyse'), t('21', 'En développement')],
      statusesInOrder: ORDER,
    });
    expect(r).toEqual({ kind: 'transition', id: '21', to: 'En développement' });
  });

  it('avance d’un cran quand le saut direct n’existe pas', () => {
    const r = nextHop({
      current: 'En analyse',
      target: 'En développement',
      available: [t('31', 'A développer'), t('32', 'Nouveau')],
      statusesInOrder: ORDER,
    });
    expect(r).toEqual({ kind: 'transition', id: '31', to: 'A développer' });
  });

  it('recule d’un cran pour une cible en amont : rendre la main suit le chemin à l’envers', () => {
    const r = nextHop({
      current: 'En développement',
      target: 'En analyse',
      available: [t('41', 'A développer'), t('42', 'En relecture')],
      statusesInOrder: ORDER,
    });
    expect(r).toEqual({ kind: 'transition', id: '41', to: 'A développer' });
  });

  it('impossible, avec la raison, quand l’étape attendue n’est pas offerte', () => {
    const r = nextHop({ current: 'En analyse', target: 'En relecture', available: [t('51', 'Fermé')], statusesInOrder: ORDER });
    expect(r.kind).toBe('impossible');
    expect(r.kind === 'impossible' && r.reason).toContain('A développer');
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
    const j = fakeJira('Nouveau', {
      Nouveau: [t('1', 'En analyse')],
      'En analyse': [t('2', 'A développer')],
      'A développer': [t('3', 'En développement')],
    });
    const r = await walkTo({ target: 'En développement', ...j.opts });
    expect(r.hops).toEqual(['En analyse', 'A développer', 'En développement']);
    expect(j.current).toBe('En développement');
    expect(j.applied).toEqual(['1', '2', '3']);
  });

  it('ne touche à rien quand le ticket est déjà au bon statut', async () => {
    const j = fakeJira('En relecture', { 'En relecture': [t('9', 'Developpement fini')] });
    const r = await walkTo({ target: 'En relecture', ...j.opts });
    expect(r.hops).toEqual([]);
    expect(j.applied).toEqual([]);
  });

  it('relit le statut après chaque saut : une transition qui aboutit ailleurs ne fait pas dérailler la marche', async () => {
    // La transition 1 annonce « En analyse » mais un post-fonction Jira pousse jusqu’à « A développer ».
    let current = 'Nouveau';
    const applied: string[] = [];
    const r = await walkTo({
      target: 'En développement',
      statusesInOrder: ORDER,
      currentStatus: async () => current,
      availableTransitions: async () =>
        current === 'Nouveau' ? [t('1', 'En analyse')] : current === 'A développer' ? [t('3', 'En développement')] : [],
      apply: async (id) => {
        applied.push(id);
        current = id === '1' ? 'A développer' : 'En développement';
      },
    });
    expect(applied).toEqual(['1', '3']);
    expect(r.hops).toEqual(['En analyse', 'En développement']);
    expect(current).toBe('En développement');
  });

  it('échoue en nommant la cible quand une étape manque', async () => {
    const j = fakeJira('En analyse', { 'En analyse': [t('7', 'Fermé')] });
    await expect(walkTo({ target: 'En relecture', ...j.opts })).rejects.toThrow(/En relecture.*impossible|impossible.*A développer/s);
  });

  it('abandonne au-delà du plafond de sauts plutôt que de boucler', async () => {
    // Chaque saut est offert, mais un post-fonction ramène toujours au départ : la cible n’arrive jamais.
    let current = 'Nouveau';
    const promise = walkTo({
      target: 'Developpement fini',
      statusesInOrder: ORDER,
      // Toujours l’étape attendue, donc jamais « impossible » : seul le plafond peut arrêter la marche.
      availableTransitions: async () => [t('x', ORDER[ORDER.indexOf(current) + 1] ?? 'En analyse')],
      currentStatus: async () => current,
      apply: async () => {
        current = 'Nouveau';
      },
    });
    await expect(promise).rejects.toThrow(new RegExp(`${MAX_HOPS} sauts`));
  });
});
