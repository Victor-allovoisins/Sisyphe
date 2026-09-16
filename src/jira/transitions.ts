/**
 * Marche de transitions Jira. Un workflow n'autorise pas à sauter une étape : pour aller de « En analyse »
 * à « En développement », il faut passer par « A développer ». On calcule donc le prochain saut, on l'exécute,
 * et on recommence — la liste des transitions disponibles changeant à chaque étape.
 *
 * Deux règles reprises de la référence av-tools (`av-shared/reference/transition-pattern.md`) :
 * l'appariement se fait sur le statut d'arrivée (`to.name`), jamais sur le nom de la transition, et la
 * comparaison est insensible à la casse et aux accents — « Developpement fini » s'écrit sans accent dans Jira.
 */

export interface JiraTransition {
  id: string;
  to: { name: string };
}

/** Plafond de sauts : au-delà, le workflow ne ressemble pas à ce qu'on croit et insister ferait du dégât. */
export const MAX_HOPS = 5;

/** Casse et accents neutralisés : les libellés Jira sont saisis à la main et « développement » varie. */
export function normalizeStatus(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

export function sameStatus(a: string, b: string): boolean {
  return normalizeStatus(a) === normalizeStatus(b);
}

export type NextHop =
  | { kind: 'done' }
  | { kind: 'transition'; id: string; to: string }
  | { kind: 'impossible'; reason: string };

/**
 * Le prochain saut pour aller de `current` à `target`.
 *
 * Priorité au saut direct quand il existe : un workflow peut offrir un raccourci que `statusesInOrder`
 * n'exprime pas, et l'emprunter évite des transitions inutiles qui pollueraient l'historique du ticket.
 * Sinon on avance d'un cran vers la cible le long de `statusesInOrder`, dans le sens qui convient —
 * un retour en arrière (rendre la main sur un ticket bloqué) suit le même chemin à l'envers.
 */
export function nextHop(opts: {
  current: string;
  target: string;
  available: JiraTransition[];
  statusesInOrder: readonly string[];
}): NextHop {
  const { current, target, available, statusesInOrder } = opts;
  if (sameStatus(current, target)) return { kind: 'done' };

  const direct = available.find((t) => sameStatus(t.to.name, target));
  if (direct) return { kind: 'transition', id: direct.id, to: direct.to.name };

  const iCur = statusesInOrder.findIndex((s) => sameStatus(s, current));
  const iTgt = statusesInOrder.findIndex((s) => sameStatus(s, target));
  if (iCur < 0) return { kind: 'impossible', reason: `statut courant « ${current} » absent du workflow configuré` };
  if (iTgt < 0) return { kind: 'impossible', reason: `statut cible « ${target} » absent du workflow configuré` };

  const step = iTgt > iCur ? 1 : -1;
  const intermediate = statusesInOrder[iCur + step];
  const hop = available.find((t) => sameStatus(t.to.name, intermediate));
  if (!hop) {
    return {
      kind: 'impossible',
      reason: `aucune transition de « ${current} » vers « ${intermediate} » (étape attendue vers « ${target} »)`,
    };
  }
  return { kind: 'transition', id: hop.id, to: hop.to.name };
}

/**
 * Déroule la marche complète en s'appuyant sur deux effets fournis par l'appelant. Séparé de `nextHop`
 * pour que le calcul reste testable sans réseau, et de la classe cliente pour qu'il soit testable sans Jira.
 */
export async function walkTo(opts: {
  target: string;
  statusesInOrder: readonly string[];
  /** Statut courant, relu à chaque saut : une transition peut aboutir ailleurs que sur son `to` annoncé. */
  currentStatus: () => Promise<string>;
  availableTransitions: () => Promise<JiraTransition[]>;
  apply: (transitionId: string) => Promise<void>;
}): Promise<{ hops: string[] }> {
  const hops: string[] = [];
  for (let n = 0; n <= MAX_HOPS; n++) {
    const current = await opts.currentStatus();
    const next = nextHop({
      current,
      target: opts.target,
      available: await opts.availableTransitions(),
      statusesInOrder: opts.statusesInOrder,
    });
    if (next.kind === 'done') return { hops };
    if (next.kind === 'impossible') {
      throw new Error(`Transition vers « ${opts.target} » impossible : ${next.reason}`);
    }
    await opts.apply(next.id);
    hops.push(next.to);
  }
  throw new Error(`Transition vers « ${opts.target} » abandonnée après ${MAX_HOPS} sauts (${hops.join(' → ')})`);
}
