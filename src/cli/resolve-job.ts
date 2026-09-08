import type { JobStore } from '../store/jobs.js';
import type { Job } from '../store/types.js';

/**
 * Résout un id de job complet ou un préfixe. Un id exact gagne toujours, même si un autre job plus
 * récent partage ce préfixe. Un préfixe qui correspond à plusieurs jobs est une erreur explicite
 * plutôt qu'un choix arbitraire (par exemple le plus récent, silencieusement).
 */
export function resolveJob(store: JobStore, idOrPrefix: string): Job {
  const exact = store.get(idOrPrefix);
  if (exact) return exact;
  const matches = store.listRecent(1000).filter((j) => j.id.startsWith(idOrPrefix));
  if (matches.length === 0) throw new Error(`Job inconnu : ${idOrPrefix}`);
  if (matches.length > 1) {
    throw new Error(`${matches.length} jobs correspondent au préfixe ${idOrPrefix} : ${matches.map((j) => j.id).join(', ')}`);
  }
  return matches[0];
}
