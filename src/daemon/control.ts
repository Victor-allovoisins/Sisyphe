import { chmod, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import type { Logger } from 'pino';
import type { ActionInput, ActionStore } from '../store/actions.js';
import { CONTROL_COMMANDS, ControlRequestSchema, type CommandResult, type ControlRequest } from './control-types.js';
import type { Daemon } from './daemon.js';

/** Une requête tient en une ligne courte ; au-delà, c'est un client défaillant ou hostile. */
const MAX_REQUEST_BYTES = 64 * 1024;
const IDLE_TIMEOUT_MS = 5_000;

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

class RequestTooLongError extends Error {}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Socket UNIX de contrôle : une connexion = une requête (une ligne JSON) = une réponse (une ligne JSON),
 * puis le serveur ferme. Un fichier de socket déjà présent est périmé (le verrou `daemon.lock` garantit
 * qu'aucun autre daemon ne tourne) et remplacé. Le fichier passe en 0600 : seul le compte local commande.
 */
export async function startControlServer(opts: ControlServerOptions): Promise<ControlServer> {
  const log = opts.log.child({ component: 'control' });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    // Sans écouteur, une erreur de socket (client parti, écriture après destroy) ferait tomber le process.
    socket.on('error', (err) => log.debug({ err }, 'connexion de contrôle en erreur'));
    void serve(socket, opts, log);
  });

  await rm(opts.path, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.path, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(opts.path, 0o600);
  server.on('error', (err) => log.error({ err }, 'socket de contrôle en erreur'));
  log.info({ path: opts.path }, 'socket de contrôle ouverte');

  let closed: Promise<void> | null = null;
  return {
    close: () =>
      (closed ??= (async () => {
        for (const s of sockets) s.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
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
    // Hors du gestionnaire : la réponse est partie, le daemon peut fermer cette socket avec les autres.
    setImmediate(() => void opts.daemon.stop());
  }
}

/** Accumule jusqu'au premier `\n` (exclu). Une connexion à moitié fermée sans `\n` livre ce qu'elle a envoyé. */
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
        void daemon.requestTick();
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
