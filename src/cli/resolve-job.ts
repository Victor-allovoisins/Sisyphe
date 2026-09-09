import type { JobStore } from '../store/jobs.js';
import type { Job } from '../store/types.js';

/** Préfixe partagé par plusieurs jobs : une classe dédiée pour que l'UI réponde 409 sans lire le message. */
export class AmbiguousJobPrefixError extends Error {
  constructor(
    public readonly prefix: string,
    public readonly matches: Job[],
  ) {
    super(`${matches.length} jobs correspondent au préfixe ${prefix} : ${matches.map((j) => j.id).join(', ')}`);
    this.name = 'AmbiguousJobPrefixError';
  }
}

/**
 * Cherche un job par id complet ou par préfixe. Un id exact gagne toujours, même si un autre job plus
 * récent partage ce préfixe. Un préfixe qui correspond à plusieurs jobs lève `AmbiguousJobPrefixError`
 * plutôt que de choisir arbitrairement (par exemple le plus récent, silencieusement). Rien ne correspond : null.
 */
export function findJob(store: JobStore, idOrPrefix: string): Job | null {
  const exact = store.get(idOrPrefix);
  if (exact) return exact;
  const matches = store.listRecent(1000).filter((j) => j.id.startsWith(idOrPrefix));
  if (matches.length === 0) return null;
  if (matches.length > 1) throw new AmbiguousJobPrefixError(idOrPrefix, matches);
  return matches[0];
}

/** Comme `findJob`, mais un id inconnu est une erreur : le contrat attendu par les commandes CLI. */
export function resolveJob(store: JobStore, idOrPrefix: string): Job {
  const job = findJob(store, idOrPrefix);
  if (!job) throw new Error(`Job inconnu : ${idOrPrefix}`);
  return job;
}
