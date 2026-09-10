/**
 * Types partagés entre le `Daemon` et ses clients de contrôle (socket UNIX, UI) : ce module
 * ne dépend de rien d'exécutable pour que l'UI puisse l'importer sans tirer le daemon.
 */

export interface DaemonStatus {
  pid: number;
  /** En pause : aucun job `queued` ne démarre, tout le reste (poll, annulations, jobs en cours) continue. */
  paused: boolean;
  /** Jobs en cours d'exécution dans ce process. */
  running: number;
  /** Jobs `queued` en base. */
  queued: number;
  /** ISO 8601 : instant de construction du `Daemon` (le process n'en construit qu'un, juste avant `start()`). */
  startedAt: string;
}

/** Réponse d'une commande : refus métier ou panne, l'appelant ne fait pas la différence — il affiche `error`. */
export type CommandResult<T> = { ok: true; result: T } | { ok: false; error: string };

export interface EnqueueIssueInput {
  /** `owner/name`, doit figurer dans `machine.repos`. */
  repo: string;
  issueNumber: number;
}
