/**
 * Contrôleur des actions de l'interface : valide la demande, la route vers le daemon (socket de contrôle)
 * ou vers le gestionnaire de service, puis traduit le résultat en code HTTP. Aucun état global : tout
 * arrive par `RunActionDeps`, de sorte qu'un test s'exécute sans socket, sans launchd et sans attente réelle.
 */
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { diffMachineConfig, type MachineConfigField } from '../config/diff.js';
import { parseMachineConfigAsWritten, type MachineConfig } from '../config/machine.js';
import type { DataPaths } from '../config/paths.js';
import { validateMachineConfigInput, writeMachineConfig, type ConfigIssue } from '../config/write.js';
import { DaemonUnreachableError } from '../daemon/control-client.js';
import type { CommandResult, ControlArgs, ControlCommand, DaemonStatus, ReloadResult } from '../daemon/control-types.js';
import { expandHome } from '../config/paths.js';
import { searchAccounts } from '../jira/client.js';
import { realExec, type Exec } from '../service/exec.js';
import { launchdErrLogPath } from '../service/launchd.js';
import { detachedLogPath } from '../service/none.js';
import { SYSTEMD_UNIT } from '../service/systemd.js';
import type { ServiceKind, ServiceStatus } from '../service/types.js';
import type { ActionName, ActionSource } from '../store/actions.js';
import { JOB_STATES, isTerminal, type JobState } from '../store/types.js';
import type { PurgeResult } from '../util/cache.js';
import { tail } from '../util/text.js';
import type { UiControl } from './data.js';

/** `start` rend la main dès que le service est lancé ; le daemon, lui, interroge GitHub avant de répondre. */
const START_TIMEOUT_MS = 30_000;
/** `doStop()` ferme la socket avant sa grâce de 30 s : un daemon qui répond encore au-delà n'a pas pris l'ordre. */
const STOP_TIMEOUT_MS = 5_000;
/** Chaque `ping` a déjà 2 s de délai à lui : cet intervalle ne sert qu'à ne pas marteler une socket absente. */
const POLL_MS = 250;
/** Fin du log du service montrée quand le démarrage n'aboutit pas. */
const LOG_TAIL_LINES = 20;
/** Le `ping` de l'overview est mémorisé : le snapshot SSE tombe toutes les 2 s et plusieurs clients l'écoutent. */
const PING_TTL_MS = 1_000;
/**
 * Délai client dépassé : la commande est bien partie et rien ne l'annule côté daemon — elle peut très bien
 * s'exécuter ensuite et apparaître dans le journal. Ne jamais laisser croire qu'il ne s'est rien passé.
 */
const TIMEOUT_MESSAGE = "Le daemon n'a pas répondu à temps ; l'action a peut-être été appliquée, vérifier le journal.";

/**
 * Les actions offertes par l'interface : celles de la socket de contrôle, `start` (service seul), et deux
 * actions propres à la page — `settings` écrit `config.yml`, `purge-cache` vide le cache de build. Les noms
 * du journal (`ActionName`) sont ceux des commandes que le daemon reçoit : ces deux-là n'en sont pas, un
 * enregistrement se journalise en `reload` et une purge en `purge`, et seulement quand le daemon répond.
 */
export const UI_ACTIONS = [
  'cancel', 'retry', 'enqueue', 'poll', 'pause', 'resume', 'stop', 'start', 'settings', 'purge-cache', 'jira-accounts',
] as const satisfies readonly (ActionName | 'settings' | 'purge-cache' | 'jira-accounts')[];
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
  stop(source?: ActionSource): Promise<void>;
  status(): Promise<ServiceStatus>;
}

/** Sous-ensemble du `JobStore` : la purge du cache doit savoir si un job est en cours. */
export interface ActionJobs {
  countByState(): Record<JobState, number>;
}

/**
 * Ce que les actions doivent à la couche de données de la page. Le même exemplaire de `createSettingsData`
 * que les routes GET, sans quoi ce qu'une action rend faux resterait mémorisé 30 s de l'autre côté.
 */
export interface ActionSettings {
  /** Purge locale, daemon arrêté ; périme d'elle-même la mesure disque. */
  purgeCache(): Promise<PurgeResult>;
  invalidateDiagnostics(): void;
  invalidateDisk(): void;
}

/**
 * Résultat de l'action `settings`, rendu seulement après une écriture réussie. `reloaded` dit si le daemon a
 * relu le fichier. Sinon, `changed` nomme tout ce qui a changé, à chaud comme structurel, et qui prendra effet
 * au démarrage ; `reloadError` dit pourquoi un daemon joignable n'a pas rechargé.
 */
export type SettingsResult =
  | ({ reloaded: true } & ReloadResult)
  | { reloaded: false; changed: MachineConfigField[]; reloadError?: string };

export interface RunActionDeps {
  client: ActionClient;
  service: ActionService;
  paths: DataPaths;
  /**
   * Le `config.yml` relu puis réécrit par l'action `settings` : `machineConfigPath()` en production, jamais un
   * chemin sous `paths.root`. Le fichier est ancré sur la racine par défaut ; écrit ailleurs, le daemon ne le
   * lirait jamais, et l'écriture comme le rechargement se déclareraient pourtant en succès.
   */
  configPath: string;
  jobs: ActionJobs;
  settings: ActionSettings;
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
  /** `issues` : le détail par champ d'une configuration refusée, que la page affiche sous chaque champ. */
  body: { ok: true; result: unknown } | { error: string; issues?: ConfigIssue[] };
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
  // Entrée présente pour que la table reste exhaustive. La configuration complète est validée par
  // `validateMachineConfigInput`, qui rend le détail par champ que ce schéma ne saurait pas produire.
  settings: z.unknown(),
  'purge-cache': emptyBody,
  // Les identifiants viennent du formulaire et non du fichier : on doit pouvoir chercher un compte avant
  // d'avoir enregistré quoi que ce soit. `site` est borné aux hôtes Atlassian — sans quoi la page pourrait
  // faire poster le contenu du fichier de jeton, qui sert de mot de passe, vers un hôte quelconque.
  'jira-accounts': z.strictObject({
    site: z.string().regex(/^[a-z0-9-]+\.atlassian\.net$/, 'hôte attendu : xxx.atlassian.net'),
    email: z.string().email(),
    apiTokenPath: z.string().min(1),
    query: z.string().min(1).max(200),
  }),
} as const satisfies Record<UiActionName, z.ZodType>;

const ok = (result: unknown): ActionResponse => ({ status: 200, body: { ok: true, result } });
const fail = (status: number, error: string): ActionResponse => ({ status, body: { error } });

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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

/** Attend que la socket de contrôle atteigne l'état voulu ; faux si elle ne l'a pas atteint dans le budget. */
async function waitForSocket(deps: RunActionDeps, reachable: boolean, budgetMs: number): Promise<boolean> {
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + budgetMs;
  for (;;) {
    if ((await deps.client.isReachable()) === reachable) return true;
    if (now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

/**
 * Démarre le service puis attend que la socket réponde. Le prologue du daemon interroge GitHub avant
 * d'ouvrir la socket : sans cette attente, l'interface annoncerait un échec sur un démarrage qui aboutit.
 */
async function startDaemon(deps: RunActionDeps): Promise<ActionResponse> {
  try {
    await deps.service.start();
  } catch (err) {
    // Daemon déjà démarré, plateforme sans service, exécutable introuvable : le message dit lequel, et
    // aucun de ces cas n'est une panne de l'interface — c'est le résultat de l'action.
    return fail(409, messageOf(err));
  }
  if (await waitForSocket(deps, true, START_TIMEOUT_MS)) return ok(null);
  const log = await startFailureLog(deps);
  const seconds = Math.round(START_TIMEOUT_MS / 1000);
  return fail(409, `Le daemon n'a pas répondu dans les ${seconds} s suivant le démarrage du service.${log ? `\n${log}` : ''}`);
}

/**
 * Arrête le service puis vérifie que le daemon a bien lâché la socket : `launchctl kill` ne dit pas s'il a
 * abouti, et l'arrêt par la socket est acquitté avant d'être exécuté. Sans cette vérification, un daemon
 * coincé derrière sa porte de sérialisation rendrait une confirmation verte en continuant de tourner.
 */
async function stopDaemon(deps: RunActionDeps): Promise<ActionResponse> {
  await deps.service.stop('ui');
  if (await waitForSocket(deps, false, STOP_TIMEOUT_MS)) return ok(null);
  const seconds = Math.round(STOP_TIMEOUT_MS / 1000);
  return fail(409, `Le daemon répond toujours ${seconds} s après la demande d'arrêt ; voir \`sisyphe service status\`.`);
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

/** Délai dépassé sur le rechargement : le fichier est écrit, et le daemon l'a peut-être relu. */
const RELOAD_TIMEOUT_MESSAGE = "Le daemon n'a pas répondu à temps ; le rechargement a peut-être eu lieu, vérifier le journal.";

/**
 * Enregistre la configuration reçue, puis la fait relire au daemon s'il répond.
 *
 * `current` est la configuration telle qu'écrite (`~` non développé) : c'est elle que compare
 * `validateMachineConfigInput` pour refuser un `dataDir` modifié. Rien n'est écrit sans validation.
 *
 * Une fois le fichier écrit, la réponse est un 200 quoi qu'il advienne du rechargement : `config.yml` et son
 * `.bak` ont déjà tourné, et un code d'échec ferait croire que rien n'est enregistré.
 *
 * Journal : le `reload` est journalisé par le daemon (source `ui`) quand la socket répond ; daemon arrêté,
 * l'enregistrement n'est pas journalisé — l'interface n'écrit jamais la base.
 */
async function saveSettings(raw: unknown, deps: RunActionDeps): Promise<ActionResponse> {
  let current: MachineConfig;
  try {
    current = parseMachineConfigAsWritten(await readFile(deps.configPath, 'utf8'));
  } catch (err) {
    // Sans la configuration en place, `dataDir` n'est plus vérifiable : refuser plutôt qu'écrire à l'aveugle.
    return fail(409, `Configuration actuelle illisible (${deps.configPath}) : ${messageOf(err)}`);
  }
  const validated = await validateMachineConfigInput(raw, current);
  if (!validated.ok) return { status: 400, body: { error: 'Configuration refusée', issues: validated.issues } };
  try {
    await writeMachineConfig(deps.configPath, validated.config);
  } catch (err) {
    return fail(409, `Écriture de ${deps.configPath} impossible : ${messageOf(err)}`);
  }
  // Le diagnostic mémorisé portait sur l'ancienne configuration (dépôts, App GitHub).
  deps.settings.invalidateDiagnostics();
  const { hot, restart } = diffMachineConfig(current, validated.config);
  return ok(await reloadAfterSave(deps, [...hot, ...restart]));
}

interface JiraLookupInput {
  site: string;
  email: string;
  apiTokenPath: string;
  query: string;
}

/**
 * Cherche un compte Jira pour la page de réglages, afin que personne n'ait à saisir un `accountId` à la main.
 *
 * Le jeton est lu ici et ne repart jamais : la réponse ne porte que des comptes. Un chemin illisible ou un
 * refus de Jira deviennent un message, pas une exception — la page affiche la raison sous le champ.
 */
async function lookupJiraAccounts(input: JiraLookupInput): Promise<ActionResponse> {
  let apiToken: string;
  try {
    apiToken = (await readFile(expandHome(input.apiTokenPath), 'utf8')).trim();
  } catch (err) {
    return fail(400, `Jeton illisible (${input.apiTokenPath}) : ${messageOf(err)}`);
  }
  if (!apiToken) return fail(400, `Le fichier ${input.apiTokenPath} est vide.`);
  try {
    const accounts = await searchAccounts({ site: input.site, email: input.email, apiToken }, input.query);
    return ok({ accounts });
  } catch (err) {
    return fail(502, `Recherche Jira impossible : ${messageOf(err)}`);
  }
}

/** Demande au daemon de relire le fichier qui vient d'être écrit ; ne lève jamais, l'écriture ayant abouti. */
async function reloadAfterSave(deps: RunActionDeps, changed: MachineConfigField[]): Promise<SettingsResult> {
  try {
    const answer = await deps.client.send('reload', {}, 'ui');
    // Forme du `reload` du daemon, comme `probe` le fait pour `ping` : socket locale en 0600, pas de tiers.
    if (answer.ok) return { reloaded: true, ...(answer.result as ReloadResult) };
    // Le daemon n'a pas pu relire le fichier : il garde sa configuration, et son message dit pourquoi.
    return { reloaded: false, changed, reloadError: answer.error };
  } catch (err) {
    // Daemon arrêté : tout prendra effet au démarrage.
    if (err instanceof DaemonUnreachableError && !err.timedOut) return { reloaded: false, changed };
    const reloadError = err instanceof DaemonUnreachableError ? RELOAD_TIMEOUT_MESSAGE : messageOf(err);
    return { reloaded: false, changed, reloadError };
  }
}

/** Jobs non terminaux, `queued` compris : même définition que le compteur `active` de l'interface. */
function activeJobs(counts: Record<JobState, number>): number {
  return JOB_STATES.filter((s) => !isTerminal(s)).reduce((n, s) => n + counts[s], 0);
}

/**
 * Vide le cache de build.
 *
 * Daemon joignable : c'est lui qui purge, par sa commande `purge`. Il la sérialise avec le reste, la refuse
 * tant qu'un job tourne, empêche tout démarrage le temps de la suppression et la journalise. Un comptage fait
 * ici laisserait au daemon le loisir de lancer un job entre ce comptage et la fin du `rm`.
 *
 * Daemon injoignable : aucun job ne peut démarrer, la purge est locale. Elle reste refusée tant qu'un job
 * n'est pas terminal — la file repartirait au démarrage — et elle n'est pas journalisée : l'interface
 * n'écrit jamais la base.
 */
async function purgeBuildCache(deps: RunActionDeps): Promise<ActionResponse> {
  let answer: CommandResult<unknown>;
  try {
    answer = await deps.client.send('purge', {}, 'ui');
  } catch (err) {
    if (!(err instanceof DaemonUnreachableError)) throw err;
    if (!err.timedOut) return purgeLocally(deps);
    // Rien n'annule la commande : la purge a pu avoir lieu, la mesure disque n'est plus sûre. Le 502 le dit.
    deps.settings.invalidateDisk();
    throw err;
  }
  // Le daemon a répondu : quoi qu'il ait fait du cache, la mesure mémorisée est à refaire.
  deps.settings.invalidateDisk();
  return answer.ok ? ok(answer.result) : fail(409, answer.error);
}

async function purgeLocally(deps: RunActionDeps): Promise<ActionResponse> {
  const active = activeJobs(deps.jobs.countByState());
  if (active > 0) {
    return fail(
      409,
      `Purge refusée : ${active} job(s) non terminé(s) et daemon arrêté. Annuler les jobs en file, ou démarrer le daemon : la purge passera alors par lui.`,
    );
  }
  return ok(await deps.settings.purgeCache());
}

/**
 * Exécute une action demandée par l'interface. `start` et `stop` passent par le gestionnaire de service
 * (sinon launchd ou systemd relanceraient aussitôt le daemon arrêté), `settings` et `purge-cache` agissent
 * en local ; tout le reste passe par la socket.
 */
export async function runAction(name: string, body: unknown, deps: RunActionDeps): Promise<ActionResponse> {
  const action = (UI_ACTIONS as readonly string[]).includes(name) ? (name as UiActionName) : null;
  if (action === null) return fail(400, `Action inconnue : ${name} (attendu ${UI_ACTIONS.join(', ')})`);
  try {
    return await dispatch(action, body ?? {}, deps);
  } catch (err) {
    if (err instanceof DaemonUnreachableError) return fail(502, err.timedOut ? TIMEOUT_MESSAGE : err.message);
    // Jamais de stack sur le réseau, même en local.
    return fail(500, messageOf(err));
  }
}

async function dispatch(action: UiActionName, body: unknown, deps: RunActionDeps): Promise<ActionResponse> {
  // `settings` et `jira-accounts` d'abord, pour la même raison : leurs corps élargiraient le type du corps
  // validé de toutes les autres actions, qui doit rester assignable aux arguments du daemon.
  if (action === 'settings') return saveSettings(body, deps);
  if (action === 'jira-accounts') {
    const lookup = BODY_SCHEMAS['jira-accounts'].safeParse(body);
    if (!lookup.success) return fail(400, `Arguments invalides : ${issuesOf(lookup.error)}`);
    return lookupJiraAccounts(lookup.data);
  }
  const parsed = BODY_SCHEMAS[action].safeParse(body);
  if (!parsed.success) return fail(400, `Arguments invalides : ${issuesOf(parsed.error)}`);
  if (action === 'purge-cache') return purgeBuildCache(deps);
  if (action === 'start') return startDaemon(deps);
  if (action === 'stop') return stopDaemon(deps);
  const result = await deps.client.send(action, parsed.data, 'ui');
  // Refus métier du daemon (job terminal, repo hors config...) : c'est son message qui est relayé.
  return result.ok ? ok(result.result) : fail(409, result.error);
}

/**
 * Sonde `ping` mémorisée quelques instants : l'overview est recalculée à chaque tic du SSE et par chaque
 * requête, une connexion à la socket par appel serait du gaspillage. Un échec n'est pas mis en cache.
 */
export function createControlProbe(client: ActionClient, opts: { ttlMs?: number; now?: () => number } = {}): UiControl {
  const ttlMs = opts.ttlMs ?? PING_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  let cached: { at: number; status: DaemonStatus | null } | null = null;
  let inFlight: Promise<DaemonStatus | null> | null = null;
  return {
    async ping() {
      // Une sonde à la fois : un `ping` sans réponse dure jusqu'à 2 s, plus que le TTL, et chaque tic du
      // SSE en ouvrirait une de plus. Les appelants simultanés partagent celle qui est déjà en vol.
      if (inFlight) return inFlight;
      if (cached && now() - cached.at <= ttlMs) return cached.status;
      inFlight = probe(client);
      try {
        const status = await inFlight;
        // Horodaté à la fin, pas au début : sinon une sonde plus lente que le TTL naîtrait déjà périmée.
        cached = { at: now(), status };
        return status;
      } finally {
        // Un échec n'est pas mémorisé : la sonde suivante réessaie.
        inFlight = null;
      }
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
