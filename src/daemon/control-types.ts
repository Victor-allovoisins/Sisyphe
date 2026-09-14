/**
 * Types et schéma du protocole partagés entre le `Daemon`, la socket de contrôle et ses clients (CLI, UI) :
 * ce module ne tire pas le daemon pour que l'UI puisse l'importer sans lui.
 */
import { z } from 'zod';
import { ACTION_SOURCES } from '../store/actions.js';

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

/** Ce qu'un `reload` a fait de la configuration relue : ce qui est déjà en vigueur, et ce qui attend un redémarrage. */
export interface ReloadResult {
  /** Champs rechargeables à chaud dont la valeur a changé et qui sont désormais appliqués. */
  applied: string[];
  /** Champs structurels dont la valeur a changé : le daemon tourne toujours avec l'ancienne. */
  needsRestart: string[];
}

/** Réponse d'une commande : refus métier ou panne, l'appelant ne fait pas la différence — il affiche `error`. */
export type CommandResult<T> = { ok: true; result: T } | { ok: false; error: string };

export interface EnqueueIssueInput {
  /** `owner/name`, doit figurer dans `machine.repos`. */
  repo: string;
  issueNumber: number;
}

/** Arguments d'une commande côté client ; le schéma ci-dessous dit lesquels chaque commande exige. */
export interface ControlArgs {
  jobId?: string;
  repo?: string;
  issueNumber?: number;
}

const source = z.enum(ACTION_SOURCES).default('cli');
const jobId = z.string().min(1);

/**
 * Une requête = une ligne JSON. `source` dit qui commande (journal des actions) ; absent, c'est la CLI.
 * Objets stricts : une clé inconnue est refusée plutôt qu'ignorée en silence.
 */
export const ControlRequestSchema = z.discriminatedUnion('cmd', [
  z.strictObject({ cmd: z.literal('ping'), source }),
  z.strictObject({ cmd: z.literal('poll'), source }),
  z.strictObject({ cmd: z.literal('pause'), source }),
  z.strictObject({ cmd: z.literal('resume'), source }),
  z.strictObject({ cmd: z.literal('stop'), source }),
  z.strictObject({ cmd: z.literal('reload'), source }),
  z.strictObject({ cmd: z.literal('cancel'), jobId, source }),
  z.strictObject({ cmd: z.literal('retry'), jobId, source }),
  z.strictObject({ cmd: z.literal('enqueue'), repo: z.string().min(1), issueNumber: z.number().int().positive(), source }),
]);
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

/** Dérivé du schéma : c'est lui qui fait foi. */
export type ControlCommand = ControlRequest['cmd'];

/**
 * La liste d'exécution (message « commande inconnue »). `satisfies` refuse une entrée absente du schéma ;
 * `ControlCommandsInSync` refuse une commande du schéma absente d'ici : les deux ne peuvent pas diverger.
 */
export const CONTROL_COMMANDS = [
  'ping', 'poll', 'pause', 'resume', 'stop', 'reload', 'cancel', 'retry', 'enqueue',
] as const satisfies readonly ControlCommand[];

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type ControlCommandsInSync = Assert<Same<(typeof CONTROL_COMMANDS)[number], ControlCommand>>;
