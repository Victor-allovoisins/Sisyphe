/**
 * Types et schéma du protocole partagés entre le `Daemon`, la socket de contrôle et ses clients (CLI, UI) :
 * ce module ne tire pas le daemon pour que l'UI puisse l'importer sans lui.
 */
import { z } from 'zod';
import type { MachineConfig } from '../config/machine.js';
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
  /**
   * Champs structurels qui diffèrent de ceux que ce daemon exécute, accumulés depuis son démarrage et
   * remis à zéro par lui seul. `reload` ne dit que ce qu'il a vu passer ; cette liste-ci reste vraie entre
   * deux rechargements, pour que la page rappelle qu'un redémarrage est dû même après un bandeau fermé.
   */
  pendingRestart: RestartRequiredField[];
}

/**
 * Champs relus à chaque décision, donc applicables sans redémarrage. La page de réglages sert cette liste
 * telle quelle : les noms sont un contrat, pas un détail d'implémentation.
 */
export const HOT_RELOAD_FIELDS = ['dailyBudgetUsd', 'maxConcurrentJobs', 'pollIntervalSeconds'] as const;
export type HotReloadField = (typeof HOT_RELOAD_FIELDS)[number];

/**
 * Champs figés au démarrage dans le client GitHub, le runner d'agent et les chemins de données : les
 * changer exige un redémarrage. Notation pointée pour les sous-champs de `github`.
 */
export const RESTART_REQUIRED_FIELDS = [
  'github.appId', 'github.installationId', 'github.privateKeyPath',
  'repos', 'triggerLabel', 'sandbox', 'agentBackend', 'agentModels', 'dataDir',
] as const;
export type RestartRequiredField = (typeof RESTART_REQUIRED_FIELDS)[number];

/** Ce qu'un `reload` a fait de la configuration relue : ce qui est déjà en vigueur, et ce qui attend un redémarrage. */
export interface ReloadResult {
  /** Champs rechargeables à chaud dont la valeur a changé et qui sont désormais appliqués. */
  applied: HotReloadField[];
  /** Champs structurels dont la valeur a changé : le daemon tourne toujours avec l'ancienne. */
  needsRestart: RestartRequiredField[];
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
  z.strictObject({ cmd: z.literal('purge'), source }),
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
  'ping', 'poll', 'pause', 'resume', 'stop', 'reload', 'purge', 'cancel', 'retry', 'enqueue',
] as const satisfies readonly ControlCommand[];

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
export type ControlCommandsInSync = Assert<Same<(typeof CONTROL_COMMANDS)[number], ControlCommand>>;

/** Racine d'un nom pointé : `github.appId` → `github`. */
type RootOf<F extends string> = F extends `${infer Head}.${string}` ? Head : F;
/** Queue d'un nom pointé sous une racine donnée : `github.appId` sous `github` → `appId`. */
type SuffixOf<F extends string, Root extends string> = F extends `${Root}.${infer Tail}` ? Tail : never;

/**
 * Même idiome que `ControlCommandsInSync`, appliqué à la taxonomie : tout champ de `MachineConfigSchema`
 * est classé à chaud ou structurel. Un champ ajouté au schéma sans être rangé dans l'une des deux listes
 * ne compile plus — au lieu d'être ignoré en silence par `reload`, ce qui ne se verrait qu'à l'usage.
 */
export type MachineFieldsClassified = Assert<Same<keyof MachineConfig, HotReloadField | RootOf<RestartRequiredField>>>;
/** Et de même pour les sous-champs de `github`, que la notation pointée énumère un par un. */
export type GithubFieldsClassified = Assert<Same<keyof MachineConfig['github'], SuffixOf<RestartRequiredField, 'github'>>>;
