import { chmod, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import type { Logger } from 'pino';
import type { ActionInput, ActionStore } from '../store/actions.js';
import { CONTROL_COMMANDS, ControlRequestSchema, type CommandResult, type ControlRequest } from './control-types.js';
import type { Daemon } from './daemon.js';

/** Une requête tient en une ligne courte ; au-delà, c'est un client défaillant ou hostile. */
const MAX_REQUEST_BYTES = 64 * 1024;
const IDLE_TIMEOUT_MS = 5_000;
/** `stop` : temps laissé au client pour lire sa réponse et fermer avant que l'arrêt ne détruise les connexions. */
const STOP_CLOSE_CAP_MS = 1_000;

/** Ce que le serveur demande au daemon : le sous-ensemble public utilisé par les commandes. */
export type ControlTarget = Pick<Daemon, 'status' | 'requestTick' | 'pause' | 'resume' | 'cancelJob' | 'retryJob' | 'enqueueIssue' | 'stop'>;

export interface ControlServerOptions {
  path: string;
  daemon: ControlTarget;
  /** Journal de `poll` et `stop`, les deux commandes que le daemon ne journalise pas lui-même. */
  actions: ActionStore;
  log: Logger;
  /** Une connexion qui n'envoie rien pendant ce délai est fermée. */
  idleTimeoutMs?: number;
}

export interface ControlServer {
  /** Ferme le serveur, détruit les connexions ouvertes et supprime le fichier de socket. Idempotent. */
  close(): Promise<void>;
}

/**
 * `sun_path` (adresse d'une socket UNIX) fait 104 octets NUL compris sur macOS/BSD, 108 sur Linux : le
 * chemin utilisable s'arrête donc à 103 octets. On s'aligne sur la limite la plus basse, la même partout.
 */
export const MAX_SOCKET_PATH_BYTES = 103;

/** Chemin de socket trop long : le daemon ne peut pas ouvrir sa socket de contrôle, et rien ne la joindra. */
export class SocketPathTooLongError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocketPathTooLongError';
  }
}

/**
 * Refuse un chemin de socket que le système ne saura pas ouvrir (EINVAL au listen comme au connect).
 * Sans ce garde, le daemon échoue à chaque démarrage et le service le relance toutes les 30 s sans fin.
 */
export function assertSocketPathLength(path: string): void {
  const bytes = Buffer.byteLength(path, 'utf8');
  if (bytes <= MAX_SOCKET_PATH_BYTES) return;
  throw new SocketPathTooLongError(
    `Chemin de la socket de contrôle trop long : ${bytes} octets pour ${MAX_SOCKET_PATH_BYTES} au maximum (${path}). ` +
      'Raccourcir la racine des données : SISYPHE_HOME, ou `dataDir` dans config.yml.',
  );
}

class RequestTooLongError extends Error {}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Socket UNIX de contrôle : une connexion = une requête (une ligne JSON) = une réponse (une ligne JSON),
 * puis le serveur ferme. Un fichier de socket déjà présent est périmé (le verrou `daemon.lock` garantit
 * qu'aucun autre daemon ne tourne) et remplacé. Le fichier passe en 0600 : seul le compte local commande.
 */
export async function startControlServer(opts: ControlServerOptions): Promise<ControlServer> {
  assertSocketPathLength(opts.path);
  const log = opts.log.child({ component: 'control' });
  const sockets = new Set<Socket>();
  // allowHalfOpen : un client qui ferme son côté émission sitôt sa ligne envoyée (`nc -N`, scripts) doit
  // quand même recevoir la réponse d'une commande qui a attendu la porte du daemon ; sans lui, Node
  // fermerait notre côté dès le `end` du client.
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // Sans écouteur, une erreur de socket (client parti, écriture après destroy) ferait tomber le process.
    socket.on('error', (err) => log.debug({ err }, 'connexion de contrôle en erreur'));
    serve(socket, opts, log).catch((err) => log.error({ err }, 'connexion de contrôle : traitement en erreur'));
  });

  await rm(opts.path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    await chmod(opts.path, 0o600);
  } catch (err) {
    // Ne jamais laisser une socket ouverte (et un fichier) derrière un démarrage qui échoue.
    await closeServer(server);
    await rm(opts.path, { force: true });
    throw err;
  }
  server.on('error', (err) => log.error({ err }, 'socket de contrôle en erreur'));
  log.info({ path: opts.path }, 'socket de contrôle ouverte');

  let closed: Promise<void> | null = null;
  return {
    close: () =>
      (closed ??= (async () => {
        for (const s of sockets) s.destroy();
        await closeServer(server);
        // Node supprime le fichier en fermant ; filet de sécurité pour ne jamais laisser une socket périmée.
        await rm(opts.path, { force: true });
        log.info('socket de contrôle fermée');
      })()),
  };
}

async function serve(socket: Socket, opts: ControlServerOptions, log: Logger): Promise<void> {
  // Le délai ne vise que l'attente de la requête : une commande qui patiente derrière la porte du daemon
  // (tick lent, appel GitHub) peut légitimement dépasser 5 s, sa connexion doit rester ouverte.
  socket.setTimeout(opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS, () => socket.destroy());
  let line: string;
  try {
    line = await readLine(socket);
  } catch (err) {
    if (err instanceof RequestTooLongError) reply(socket, { ok: false, error: 'requête trop longue' });
    else socket.destroy();
    return;
  }
  socket.setTimeout(0);
  const req = parse(line);
  if (!req.ok) {
    reply(socket, req);
    return;
  }
  // Jamais le corps en info : il peut porter des chaînes choisies par l'utilisateur.
  log.debug({ cmd: req.result.cmd, source: req.result.source }, 'commande reçue');
  reply(socket, await execute(req.result, opts, log));
  if (req.result.cmd === 'stop') {
    // L'arrêt détruit les connexions ouvertes : on laisse d'abord le client lire sa réponse et fermer (borné).
    await closedOrCap(socket, STOP_CLOSE_CAP_MS);
    opts.daemon.stop().catch((err) => log.error({ err }, 'arrêt demandé par la socket : stop() en erreur'));
  }
}

/** Résolue à la fermeture de la connexion, ou au bout de `ms` si le client la garde ouverte. */
function closedOrCap(socket: Socket, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (socket.closed) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Accumule jusqu'au premier `\n` (exclu). Le client peut fermer son côté émission après sa ligne
 * (`allowHalfOpen` garde le nôtre ouvert pour la réponse) ; sans `\n`, ce qu'il a envoyé fait la requête.
 */
function readLine(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const settle = (fn: () => void) => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onClose);
      fn();
    };
    const onData = (chunk: Buffer) => {
      const nl = chunk.indexOf(0x0a);
      const head = nl === -1 ? chunk : chunk.subarray(0, nl);
      size += head.length;
      if (size > MAX_REQUEST_BYTES) {
        settle(() => reject(new RequestTooLongError()));
        return;
      }
      chunks.push(head);
      if (nl !== -1) settle(() => resolve(Buffer.concat(chunks).toString('utf8')));
    };
    const onEnd = () => settle(() => resolve(Buffer.concat(chunks).toString('utf8')));
    const onClose = () => settle(() => reject(new Error('connexion fermée avant la fin de la requête')));
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onClose);
  });
}

function parse(line: string): CommandResult<ControlRequest> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { ok: false, error: 'requête non JSON' };
  }
  const cmd = typeof raw === 'object' && raw !== null ? (raw as { cmd?: unknown }).cmd : undefined;
  if (typeof cmd !== 'string' || !(CONTROL_COMMANDS as readonly string[]).includes(cmd)) {
    return { ok: false, error: `commande inconnue : ${typeof cmd === 'string' ? cmd : JSON.stringify(cmd)}` };
  }
  const parsed = ControlRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join('.')} : ${i.message}` : i.message)).join(' ; ');
    return { ok: false, error: `requête invalide : ${details}` };
  }
  return { ok: true, result: parsed.data };
}

/** Toute exception devient un refus : le client n'a jamais à distinguer un refus métier d'une panne. */
async function execute(req: ControlRequest, opts: ControlServerOptions, log: Logger): Promise<CommandResult<unknown>> {
  const { daemon } = opts;
  try {
    switch (req.cmd) {
      case 'ping':
        return { ok: true, result: daemon.status() };
      case 'pause':
        return { ok: true, result: daemon.pause(req.source) };
      case 'resume':
        return { ok: true, result: daemon.resume(req.source) };
      case 'cancel':
        return await daemon.cancelJob(req.jobId, req.source);
      case 'retry':
        return await daemon.retryJob(req.jobId, req.source);
      case 'enqueue':
        return await daemon.enqueueIssue({ repo: req.repo, issueNumber: req.issueNumber }, req.source);
      case 'poll':
        // Le tick est programmé (il s'enchaîne après ce qui occupe la porte) ; on ne l'attend pas.
        daemon.requestTick().catch((err) => log.error({ err }, 'poll : tick en erreur'));
        journal(opts, log, { action: 'poll', source: req.source, outcome: 'ok' });
        return { ok: true, result: null };
      case 'stop':
        journal(opts, log, { action: 'stop', source: req.source, outcome: 'ok' });
        return { ok: true, result: null };
    }
  } catch (err) {
    log.error({ err, cmd: req.cmd }, 'commande de contrôle en erreur');
    return { ok: false, error: messageOf(err) };
  }
}

/** Comme `Daemon.journal` : un échec d'écriture est loggé, jamais transformé en refus. */
function journal(opts: ControlServerOptions, log: Logger, input: ActionInput): void {
  try {
    opts.actions.record(input);
  } catch (err) {
    log.error({ err }, 'journal des actions : écriture impossible');
  }
}

function reply(socket: Socket, res: CommandResult<unknown>): void {
  if (socket.destroyed || !socket.writable) return;
  socket.end(`${JSON.stringify(res)}\n`);
}
