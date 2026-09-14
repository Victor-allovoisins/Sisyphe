/**
 * Verdict de démarrage. Le refus budgétaire porte le plafond qui l'a produit : l'appelant n'a pas à le
 * redériver, et le commentaire de pause ne peut pas être émis sans plafond.
 */
export type StartCheck = { ok: true } | { ok: false; reason: 'concurrency' } | { ok: false; reason: 'budget'; capUsd: number };

export function canStartJob(i: { activeCount: number; maxConcurrent: number; spentTodayUsd: number; dailyBudgetUsd: number | undefined }): StartCheck {
  // `dailyBudgetUsd` absent : aucun plafond. Le coût reste calculé et affiché, mais ne bloque jamais rien.
  const cap = i.dailyBudgetUsd;
  if (cap !== undefined && i.spentTodayUsd >= cap) return { ok: false, reason: 'budget', capUsd: cap };
  if (i.activeCount >= i.maxConcurrent) return { ok: false, reason: 'concurrency' };
  return { ok: true };
}

/** Minuit local du jour courant, en ISO, pour le calcul du budget quotidien. */
export function startOfLocalDay(now: Date = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
