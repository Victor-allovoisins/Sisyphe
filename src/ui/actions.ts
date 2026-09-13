/**
 * Contrôleur des actions de l'interface : valide la demande, la route vers le daemon (socket de contrôle)
 * ou vers le gestionnaire de service, puis traduit le résultat en code HTTP. Aucun état global : tout
 * arrive par `RunActionDeps`, de sorte qu'un test s'exécute sans socket, sans launchd et sans attente réelle.
 */
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { DataPaths } from '../config/paths.js';
import { DaemonUnreachableError } from '../daemon/control-client.js';
import type { CommandResult, ControlArgs, ControlCommand, DaemonStatus } from '../daemon/control-types.js';
import { realExec, type Exec } from '../service/exec.js';
import { launchdErrLogPath } from '../service/launchd.js';
import { detachedLogPath } from '../service/none.js';
import { SYSTEMD_UNIT } from '../service/systemd.js';
import type { ServiceKind, ServiceStatus } from '../service/types.js';
import type { ActionName, ActionSource } from '../store/actions.js';
import { tail } from '../util/text.js';
import type { UiControl } from './data.js';

/** `start` rend la main dès que le service est lancé ; le daemon, lui, interroge GitHub avant de répondre. */
const START_TIMEOUT_MS = 30_000;
/** Chaque `ping` a déjà 2 s de délai à lui : cet intervalle ne sert qu'à ne pas marteler une socket absente. */
const START_POLL_MS = 250;
/** Fin du log du service montrée quand le démarrage n'aboutit pas. */
const LOG_TAIL_LINES = 20;
/** Le `ping` de l'overview est mémorisé : le snapshot SSE tombe toutes les 2 s et plusieurs clients l'écoutent. */
const PING_TTL_MS = 1_000;

/** Les actions offertes par l'interface : celles de la socket de contrôle, plus `start` (service seul). */
export const UI_ACTIONS = ['cancel', 'retry', 'enqueue', 'poll', 'pause', 'resume', 'stop', 'start'] as const satisfies readonly ActionName[];
export type UiActionName = (typeof UI_ACTIONS)[number];

/**
 * Sous-ensemble du `ControlClient` : un test passe un faux, jamais une vraie socket. Le résultat reste
 * `unknown` — l'interface le renvoie tel quel au navigateur, elle n'a pas à connaître la forme de chaque réponse.
 */
export interface ActionClient {
  send(cmd: ControlCommand, args?: ControlArgs, source?: ActionSource): Promise<CommandResult<unknown>>;
  isReachable(): Promise<boolean>;
}

/** Sous-ensemble du `ServiceManager` : démarrer, arrêter, et le `kind` pour retrouver le bon log. */
export interface ActionService {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Promise<ServiceStatus>;
}

export interface RunActionDeps {
  client: ActionClient;
  service: ActionService;
  paths: DataPaths;
  /** Lecture du journal systemd ; injecté en test pour ne pas lancer `journalctl`. */
  exec?: Exec;
  /** Attente entre deux `ping` après un démarrage ; injectée en test pour ne pas dormir réellement. */
  sleep?: (ms: number) => Promise<void>;
  /** Horloge de l'échéance de démarrage ; injectée avec `sleep` pour que le test contrôle le temps. */
  now?: () => number;
}

/** Réponse prête à sérialiser : le serveur n'a plus qu'à écrire le statut et le corps. */
export interface ActionResponse {
  status: number;
  body: { ok: true; result: unknown } | { error: string };
}

const jobIdBody = z.strictObject({ jobId: z.string().min(1) });
const emptyBody = z.strictObject({});

/**
 * Un schéma par action, strict : une clé inconnue est refusée plutôt qu'ignorée en silence, comme dans
 * le protocole de la socket (`ControlRequestSchema`).
 */
const BODY_SCHEMAS = {
  cancel: jobIdBody,
  retry: jobIdBody,
  enqueue: z.strictObject({ repo: z.string().min(1), issueNumber: z.number().int().positive() }),
  poll: emptyBody,
  pause: emptyBody,
  resume: emptyBody,
  stop: emptyBody,
  start: emptyBody,
} as const satisfies Record<UiActionName, z.ZodType>;

const ok = (result: unknown): ActionResponse => ({ status: 200, body: { ok: true, result } });
const fail = (status: number, error: string): ActionResponse => ({ status, body: { error } });

function issuesOf(error: z.ZodError): string {
  return error.issues.map((i) => (i.path.length ? `${i.path.join('.')} : ${i.message}` : i.message)).join(' ; ');
}

/**
 * Fin du log du service, pour dire pourquoi un démarrage n'a pas abouti : le fichier d'erreur de launchd,
 * le journal systemd de l'unité, ou la sortie du daemon détaché. Illisible ou absent : chaîne vide.
 */
export async function serviceLogTail(kind: ServiceKind, logsDir: string, exec: Exec): Promise<string> {
  if (kind === 'systemd') {
    const r = await exec('journalctl', ['--user', '-u', SYSTEMD_UNIT, '-n', String(LOG_TAIL_LINES)]).catch(() => null);
    return r === null || r.exitCode !== 0 ? '' : tail(r.stdout, LOG_TAIL_LINES).trim();
  }
  const path = kind === 'launchd' ? launchdErrLogPath(logsDir) : detachedLogPath(logsDir);
  const text = await readFile(path, 'utf8').catch(() => null);
  return text === null ? '' : tail(text, LOG_TAIL_LINES).trim();
}

/**
 * Démarre le service puis attend que la socket réponde. Le prologue du daemon interroge GitHub avant
 * d'ouvrir la socket : sans cette attente, l'interface annoncerait un échec sur un démarrage qui aboutit.
 */
async function startDaemon(deps: RunActionDeps): Promise<ActionResponse> {
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  const now = deps.now ?? (() => Date.now());
  await deps.service.start();
  const deadline = now() + START_TIMEOUT_MS;
  for (;;) {
    if (await deps.client.isReachable()) return ok(null);
    if (now() >= deadline) break;
    await sleep(START_POLL_MS);
  }
  const log = await startFailureLog(deps);
  const seconds = Math.round(START_TIMEOUT_MS / 1000);
  return fail(409, `Le daemon n'a pas répondu dans les ${seconds} s suivant le démarrage du service.${log ? `\n${log}` : ''}`);
}

/**
 * Le log accompagne l'échec, il ne le remplace jamais : un gestionnaire de service devenu muet ne doit pas
 * transformer « le daemon n'a pas démarré » en panne interne, c'est justement l'information attendue.
 */
async function startFailureLog(deps: RunActionDeps): Promise<string> {
  try {
    const { kind } = await deps.service.status();
    return await serviceLogTail(kind, deps.paths.logsDir, deps.exec ?? realExec);
  } catch {
    return '';
  }
}

/**
 * Exécute une action demandée par l'interface. `start` et `stop` passent par le gestionnaire de service
 * (sinon launchd ou systemd relanceraient aussitôt le daemon arrêté) ; tout le reste par la socket.
 */
export async function runAction(name: string, body: unknown, deps: RunActionDeps): Promise<ActionResponse> {
  const action = (UI_ACTIONS as readonly string[]).includes(name) ? (name as UiActionName) : null;
  if (action === null) return fail(400, `Action inconnue : ${name} (attendu ${UI_ACTIONS.join(', ')})`);
  const parsed = BODY_SCHEMAS[action].safeParse(body ?? {});
  if (!parsed.success) return fail(400, `Arguments invalides : ${issuesOf(parsed.error)}`);
  try {
    if (action === 'start') return await startDaemon(deps);
    if (action === 'stop') {
      await deps.service.stop();
      return ok(null);
    }
    const result = await deps.client.send(action, parsed.data, 'ui');
    // Refus métier du daemon (job terminal, repo hors config...) : c'est son message qui est relayé.
    return result.ok ? ok(result.result) : fail(409, result.error);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) return fail(502, err.message);
    // Jamais de stack sur le réseau, même en local.
    return fail(500, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Sonde `ping` mémorisée quelques instants : l'overview est recalculée à chaque tic du SSE et par chaque
 * requête, une connexion à la socket par appel serait du gaspillage. Un échec n'est pas mis en cache.
 */
export function createControlProbe(client: ActionClient, opts: { ttlMs?: number; now?: () => number } = {}): UiControl {
  const ttlMs = opts.ttlMs ?? PING_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  let cached: { at: number; status: Promise<DaemonStatus | null> } | null = null;
  return {
    ping() {
      const at = now();
      if (!cached || at - cached.at > ttlMs) cached = { at, status: probe(client) };
      const pending = cached;
      return pending.status.catch((err: unknown) => {
        if (cached === pending) cached = null;
        throw err;
      });
    },
  };
}

/** Daemon injoignable : `null`, pas une exception — c'est un état normal de l'interface. */
async function probe(client: ActionClient): Promise<DaemonStatus | null> {
  try {
    const r = await client.send('ping', {}, 'ui');
    // Forme du `ping` du daemon, comme le fait `ControlClient.send<T>` : socket locale en 0600, pas de tiers.
    return r.ok ? (r.result as DaemonStatus) : null;
  } catch (err) {
    if (err instanceof DaemonUnreachableError) return null;
    throw err;
  }
}
