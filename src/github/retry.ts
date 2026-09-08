export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** false : n'attend/rejoue que sur rate limit (pas sur 5xx/erreur réseau) — pour les POST non idempotents. Défaut true. */
  retryOnError?: boolean;
}

type HttpLikeError = { status?: number; response?: { headers?: Record<string, string | undefined> } };

/** Erreur réseau (pas de status) ou 5xx. */
export function isRetryable(err: unknown): boolean {
  const status = (err as HttpLikeError).status;
  if (status === undefined) return true;
  return status >= 500;
}

/**
 * Durée d'attente imposée par un rate limit GitHub, ou null si l'erreur n'en est pas un.
 * `retry-after` s'applique sur 403 (rate limit secondaire, sans en-têtes x-ratelimit-*) comme sur 429.
 */
export function rateLimitWaitMs(err: unknown, nowMs: number): number | null {
  const e = err as HttpLikeError;
  if (e.status !== 403 && e.status !== 429) return null;
  const headers = e.response?.headers ?? {};
  if (headers['x-ratelimit-remaining'] === '0' && headers['x-ratelimit-reset']) {
    return Math.max(0, Number(headers['x-ratelimit-reset']) * 1000 - nowMs);
  }
  if (headers['retry-after']) return Number(headers['retry-after']) * 1000;
  if (e.status === 429) return 60_000;
  return null;
}

export async function withRetry<T>(fn: () => Promise<T>, o: RetryOptions = {}): Promise<T> {
  const attempts = o.attempts ?? 3;
  const base = o.baseDelayMs ?? 1000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const retryOnError = o.retryOnError ?? true;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const wait = rateLimitWaitMs(err, now());
      // Hors rate limit, un appel non idempotent (retryOnError: false) ne doit jamais être rejoué.
      if (wait === null && (!retryOnError || !isRetryable(err))) throw err;
      // Dernière tentative : on lève tout de suite, on ne dort plus pour rien.
      if (i === attempts) throw err;
      await sleep(wait !== null ? Math.min(wait + 1000, 3_600_000) : base * 2 ** (i - 1));
    }
  }
  throw lastErr;
}
