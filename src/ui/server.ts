import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { AmbiguousJobPrefixError } from '../cli/resolve-job.js';
import type { JobState } from '../store/types.js';
import type { ActionResponse } from './actions.js';
import { UiInputError, type UiData } from './data.js';
import type { Diagnostics, DiskUsage, SettingsView } from './settings.js';

/**
 * Page unique embarquée : tout est inline, aucune ressource externe, aucun `eval`. `frame-ancestors 'none'`
 * interdit l'encadrement : sans lui, un site tiers afficherait cette page dans une iframe invisible et ferait
 * cliquer la victime sur Pause ou Poll — des actions sans confirmation, dont les requêtes partiraient de la
 * page elle-même et passeraient donc toutes les gardes anti-CSRF. `form-action 'self'` est explicite : cette
 * directive ne retombe pas sur `default-src`, sans elle un formulaire injecté posterait vers l'extérieur.
 */
const CSP = "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'";
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};
const JSON_TYPE = 'application/json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';
/** Au-delà, le client SSE ne lit plus (onglet gelé, machine en veille) : on ferme plutôt que de gonfler la mémoire. */
const MAX_SSE_BUFFER_BYTES = 1_048_576;
/** Une interface locale et rien d'autre : pas d'option `--host`, pas d'écoute sur 0.0.0.0. */
export const UI_HOST = '127.0.0.1';
export const DEFAULT_UI_PORT = 7777;
const SSE_INTERVAL_MS = 2000;
/** Seule famille de routes qui accepte POST. */
const ACTION_PREFIX = '/api/actions/';
/** Les corps d'action sont minuscules (`{ repo, issueNumber }`) : au-delà, c'est qu'on n'en veut pas. */
const MAX_ACTION_BODY_BYTES = 16 * 1024;

/** Exécute une action déjà authentifiée par les gardes anti-CSRF et rend le couple statut · corps. */
export type ActionRunner = (name: string, body: unknown) => Promise<ActionResponse>;

/**
 * Lectures de la page de réglages, servies telles quelles. Le même exemplaire de `createSettingsData` doit
 * servir la purge du cache : c'est elle qui périme la mesure disque mémorisée.
 */
export interface UiSettings {
  settingsView(): Promise<SettingsView>;
  /** `fresh` : bouton « Relancer », qui passe outre la mémorisation sans doubler un calcul en cours. */
  diagnostics(opts?: { fresh?: boolean }): Promise<Diagnostics>;
  diskUsage(): Promise<DiskUsage>;
}

export interface UiServerOptions {
  data: UiData;
  settings: UiSettings;
  page: string;
  port?: number;
  intervalMs?: number;
  log?: Logger;
  /** Contrôleur des actions ; absent (`--read-only`), tout POST est refusé en 403. */
  actions?: ActionRunner;
}

export interface UiServer {
  port: number;
  host: string;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>) =>
  send(res, status, JSON_TYPE, JSON.stringify(value), extra);

/**
 * Défense contre le DNS rebinding : un site distant peut faire résoudre son domaine vers 127.0.0.1 et
 * lire cette interface depuis le navigateur de la victime. La socket n'écoute qu'en local, mais
 * l'en-tête Host trahit ce détour — seuls les noms locaux, avec le port réellement ouvert, sont servis.
 */
function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

/**
 * Un formulaire HTML d'un site tiers ne peut poser ni `Content-Type: application/json` ni un en-tête
 * inventé sans un pré-vol CORS que cette interface n'accorde jamais : exiger les deux suffit à écarter
 * le CSRF. `Origin`, quand le navigateur l'envoie, doit en plus désigner cette interface elle-même.
 */
function isAllowedOrigin(origin: string, port: number): boolean {
  // L'origine est `http://` suivi d'une autorité : la liste autorisée est exactement celle de `Host`.
  return origin.startsWith('http://') && isAllowedHost(origin.slice('http://'.length), port);
}

/**
 * Corps d'une requête, plafonné. Au-delà du plafond, le flux est vidé sans être gardé plutôt que coupé :
 * couper la socket priverait le client de la réponse 413 qu'il est en train d'attendre.
 */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Un paramètre absent et un paramètre vide (`?state=`) veulent dire la même chose : pas de filtre. */
function strParam(value: string | null): string | undefined {
  return value === null || value.trim() === '' ? undefined : value;
}

/** Un entier positif ou rien : une limite illisible est refusée par la couche de données. */
function intParam(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

export async function startUiServer(o: UiServerOptions): Promise<UiServer> {
  const { data, page, log } = o;
  const intervalMs = o.intervalMs ?? SSE_INTERVAL_MS;
  const clients = new Set<ServerResponse>();

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    // Seul POST arrive ici en dehors de GET, et seulement sur la route des actions (garde de méthode ci-dessous).
    if (req.method === 'POST') return postAction(req, res, url.pathname.slice(ACTION_PREFIX.length));
    if (url.pathname === '/') return send(res, 200, HTML_TYPE, page);
    if (url.pathname === '/api/overview') return sendJson(res, 200, await data.overview());
    if (url.pathname === '/api/jobs') {
      const jobs = data.listJobs({
        state: strParam(url.searchParams.get('state')) as JobState | undefined,
        repo: strParam(url.searchParams.get('repo')),
        limit: intParam(url.searchParams.get('limit')),
      });
      return sendJson(res, 200, { jobs });
    }
    if (url.pathname.startsWith('/api/jobs/')) {
      let id: string;
      try {
        id = decodeURIComponent(url.pathname.slice('/api/jobs/'.length));
      } catch {
        return sendJson(res, 400, { error: 'Identifiant de job mal encodé' });
      }
      // `/api/jobs/` sans id : un préfixe vide correspond à tous les jobs, donc à un 409 absurde.
      if (id === '') return sendJson(res, 404, { error: 'Job inconnu : (identifiant vide)' });
      const detail = await data.jobDetail(id);
      if (!detail) return sendJson(res, 404, { error: `Job inconnu : ${id}` });
      return sendJson(res, 200, detail);
    }
    if (url.pathname === '/api/report') return sendJson(res, 200, data.report(strParam(url.searchParams.get('since'))));
    // `readOnly` suit le branchement du contrôleur, seule source de vérité du mode côté serveur.
    if (url.pathname === '/api/settings') return sendJson(res, 200, { ...(await o.settings.settingsView()), readOnly: !o.actions });
    // Diagnostic et disque sont calculés à la demande et mémorisés 30 s par la couche de données.
    if (url.pathname === '/api/diagnostics') {
      return sendJson(res, 200, await o.settings.diagnostics({ fresh: url.searchParams.get('fresh') === '1' }));
    }
    if (url.pathname === '/api/disk') return sendJson(res, 200, await o.settings.diskUsage());
    if (url.pathname === '/api/events') return openStream(req, res);
    // Le navigateur demande toujours /favicon.ico : un 204 vaut mieux qu'un 404 JSON dans la console.
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
      return;
    }
    return sendJson(res, 404, { error: `Route inconnue : ${url.pathname}` });
  }

  /**
   * `POST /api/actions/<nom>` : les gardes anti-CSRF d'abord (l'interface n'a ni session ni jeton, c'est
   * l'impossibilité pour un site tiers de forger ces en-têtes qui protège), puis le corps, puis l'action.
   */
  async function postAction(req: IncomingMessage, res: ServerResponse, rawName: string): Promise<void> {
    if (!o.actions) return sendJson(res, 403, { error: 'Interface en lecture seule : aucune action acceptée' });
    const type = req.headers['content-type'] ?? '';
    if (!type.toLowerCase().startsWith('application/json')) return sendJson(res, 403, { error: 'Content-Type application/json requis' });
    if (req.headers['x-sisyphe-action'] !== '1') return sendJson(res, 403, { error: 'En-tête X-Sisyphe-Action: 1 requis' });
    const origin = req.headers.origin;
    if (origin !== undefined && !isAllowedOrigin(origin, boundPort)) return sendJson(res, 403, { error: `Origine non autorisée : ${origin}` });

    const raw = await readBody(req, MAX_ACTION_BODY_BYTES);
    if (raw === null) return sendJson(res, 413, { error: `Corps trop volumineux (maximum ${MAX_ACTION_BODY_BYTES} octets)` });
    let body: unknown;
    try {
      // Corps vide : les actions sans argument (`poll`, `pause`...) n'ont rien à envoyer.
      body = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: 'Corps JSON invalide' });
    }
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return sendJson(res, 400, { error: "Nom d'action mal encodé" });
    }
    const { status, body: payload } = await o.actions(name, body);
    return sendJson(res, status, payload);
  }

  function openStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const drop = () => clients.delete(res);
    req.on('close', drop);
    res.on('close', drop);
    // Une socket en erreur émet `error` avant `close` : sans ce relais, un flux mort resterait dans la liste.
    res.on('error', drop);
    void pushSnapshot([res]);
  }

  async function pushSnapshot(targets: Iterable<ServerResponse>): Promise<void> {
    const list = [...targets];
    if (list.length === 0) return;
    let payload: string;
    try {
      payload = JSON.stringify(await data.overview());
    } catch (err) {
      // Une base momentanément illisible ne doit pas tuer le flux : le prochain tic réessaiera.
      log?.warn({ err }, 'snapshot UI indisponible');
      return;
    }
    const frame = `event: snapshot\ndata: ${payload}\n\n`;
    for (const res of list) {
      if (res.writableEnded) continue;
      if (res.writableLength > MAX_SSE_BUFFER_BYTES) {
        // Client qui n'absorbe plus : on le ferme, son EventSource se reconnectera de lui-même.
        clients.delete(res);
        res.end();
        continue;
      }
      res.write(frame);
    }
  }

  let boundPort = o.port ?? DEFAULT_UI_PORT;

  const server: Server = createServer((req, res) => {
    const target = req.url ?? '/';
    // Une cible qui n'est pas un chemin absolu (forme absolute-URI, `//host` traité comme une autorité) :
    // rien de connu ne l'émet, et `new URL` en tirerait une origine différente.
    if (!target.startsWith('/') || target.startsWith('//')) return sendJson(res, 404, { error: 'Route inconnue' });
    if (!isAllowedHost(req.headers.host, boundPort)) return sendJson(res, 403, { error: 'Hôte non autorisé' });
    const url = new URL(target, `http://${UI_HOST}`);
    if (req.method === 'HEAD' && url.pathname === '/') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': HTML_TYPE, 'Content-Length': Buffer.byteLength(page) });
      res.end();
      return;
    }
    const isAction = url.pathname.startsWith(ACTION_PREFIX);
    if (req.method !== 'GET' && !(req.method === 'POST' && isAction)) {
      return sendJson(res, 405, { error: `Méthode non autorisée : ${req.method}` }, { Allow: isAction ? 'GET, POST' : 'GET' });
    }
    route(req, res, url).catch((err: unknown) => {
      if (res.headersSent) return res.end();
      if (err instanceof UiInputError) return sendJson(res, 400, { error: err.message });
      if (err instanceof AmbiguousJobPrefixError) return sendJson(res, 409, { error: err.message });
      // Jamais de stack sur le réseau, même en local : le message seul suffit à diagnostiquer.
      log?.error({ err }, 'erreur UI');
      return sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      const port = o.port ?? DEFAULT_UI_PORT;
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`Le port ${port} est déjà utilisé : arrêter l'autre \`sisyphe ui\` ou choisir un autre port avec --port.`)
          : err,
      );
    };
    server.once('error', onError);
    server.listen(o.port ?? DEFAULT_UI_PORT, UI_HOST, () => {
      server.removeListener('error', onError);
      server.on('error', (err) => log?.error({ err }, 'erreur du serveur UI'));
      resolve();
    });
  });

  const timer = setInterval(() => void pushSnapshot(clients), intervalMs);
  timer.unref();

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (o.port ?? DEFAULT_UI_PORT);
  // Le port réel n'est connu qu'après `listen` (port 0 en test) : la vérification de Host en a besoin.
  boundPort = port;

  let closed = false;
  return {
    port,
    host: UI_HOST,
    // Idempotent : SIGINT puis SIGTERM, ou un `close()` déjà fait en test, ne doivent pas lever.
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const res of clients) res.end();
      clients.clear();
      const stopped = new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      // Les connexions gardées en vie par le client (keep-alive) empêcheraient `close()` d'aboutir.
      server.closeIdleConnections();
      // Filet : un EventSource qui se reconnecte (`retry: 2000`) peut se glisser juste avant l'arrêt et
      // laisser une socket active — sans ce coup de grâce différé, Ctrl+C ne rendrait jamais la main.
      const lastResort = setTimeout(() => server.closeAllConnections(), 500);
      lastResort.unref();
      await stopped;
      clearTimeout(lastResort);
    },
  };
}
