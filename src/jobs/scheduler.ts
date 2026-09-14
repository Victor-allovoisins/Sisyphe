export type StartBlockReason = 'concurrency' | 'budget';

export function canStartJob(i: { activeCount: number; maxConcurrent: number; spentTodayUsd: number; dailyBudgetUsd: number | undefined }):
  | { ok: true }
  | { ok: false; reason: StartBlockReason } {
  // `dailyBudgetUsd` absent : aucun plafond. Le coût reste calculé et affiché, mais ne bloque jamais rien.
  if (i.dailyBudgetUsd !== undefined && i.spentTodayUsd >= i.dailyBudgetUsd) return { ok: false, reason: 'budget' };
  if (i.activeCount >= i.maxConcurrent) return { ok: false, reason: 'concurrency' };
  return { ok: true };
}

/** Minuit local du jour courant, en ISO, pour le calcul du budget quotidien. */
export function startOfLocalDay(now: Date = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
