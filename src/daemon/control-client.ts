import { createConnection } from 'node:net';
import type { ActionSource } from '../store/actions.js';
import type { CommandResult, ControlArgs, ControlCommand } from './control-types.js';

/** Une commande peut attendre la fin du tick en cours (poll GitHub, démarrages) avant d'être traitée. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** `ping` est traité sans passer par la porte : ne pas répondre vite, c'est ne pas répondre. */
const DEFAULT_PING_TIMEOUT_MS = 2_000;
/** Connexion établie puis coupée (arrêt du daemon en cours) : c'est encore une façon de ne pas répondre. */
const UNREACHABLE_CODES = new Set(['ECONNRESET', 'EPIPE']);

/**
 * Le daemon ne répond pas : socket absente, connexion refusée ou impossible, délai dépassé. Les autres
 * erreurs sont des pannes. `timedOut` : la commande est partie et le délai a expiré — elle a pu être
 * exécutée quand même, l'appelant ne doit pas annoncer qu'il ne s'est rien passé.
 */
export class DaemonUnreachableError extends Error {
  readonly timedOut: boolean;

  constructor(message: string, options?: ErrorOptions & { timedOut?: boolean }) {
    super(message, options);
    this.name = 'DaemonUnreachableError';
    this.timedOut = options?.timedOut ?? false;
  }
}

function isCommandResult(v: unknown): v is CommandResult<unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { ok?: unknown; error?: unknown };
  return (r.ok === true && 'result' in r) || (r.ok === false && typeof r.error === 'string');
}

export interface ControlClientOptions {
  /** Délai des commandes (défaut 30 s : une commande peut patienter derrière le tick en cours). */
  timeoutMs?: number;
  /** Délai de `ping`, donc de `isReachable()` (défaut 2 s). */
  pingTimeoutMs?: number;
}

/** Client de la socket de contrôle : une connexion par commande, une ligne envoyée, une ligne lue. */
export class ControlClient {
  private readonly timeoutMs: number;
  private readonly pingTimeoutMs: number;

  constructor(
    private readonly socketPath: string,
    opts: ControlClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pingTimeoutMs = opts.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  }

  /**
   * Rejette en `DaemonUnreachableError` si le daemon ne répond pas (socket absente, connexion refusée, délai
   * dépassé) et en `Error` si sa réponse est illisible. `stop` : la réponse arrive avant l'arrêt du daemon ;
   * on n'attend pas la fin de son process.
   */
  async send<T = unknown>(cmd: ControlCommand, args: ControlArgs = {}, source: ActionSource = 'cli'): Promise<CommandResult<T>> {
    const timeoutMs = cmd === 'ping' ? this.pingTimeoutMs : this.timeoutMs;
    const line = await this.exchange(`${JSON.stringify({ cmd, source, ...args })}\n`, timeoutMs);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`réponse illisible du daemon : ${line.slice(0, 200)}`);
    }
    if (!isCommandResult(parsed)) throw new Error(`réponse inattendue du daemon : ${line.slice(0, 200)}`);
    return parsed as CommandResult<T>;
  }

  /** `ping` réussi. Une panne autre que l'injoignabilité (réponse illisible...) remonte à l'appelant. */
  async isReachable(): Promise<boolean> {
    try {
      return (await this.send('ping')).ok;
    } catch (err) {
      if (err instanceof DaemonUnreachableError) return false;
      throw err;
    }
  }

  private exchange(payload: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      const chunks: Buffer[] = [];
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };
      const timer = setTimeout(
        () => settle(() => reject(new DaemonUnreachableError(`le daemon ne répond pas (${timeoutMs} ms)`, { timedOut: true }))),
        timeoutMs,
      );
      let connected = false;
      socket.on('connect', () => {
        connected = true;
        socket.write(payload);
      });
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        const all = Buffer.concat(chunks);
        const nl = all.indexOf(0x0a);
        if (nl !== -1) settle(() => resolve(all.subarray(0, nl).toString('utf8')));
      });
      socket.on('end', () => {
        const all = Buffer.concat(chunks).toString('utf8');
        settle(() => (all.length > 0 ? resolve(all) : reject(new DaemonUnreachableError('le daemon a fermé la connexion sans répondre'))));
      });
      socket.on('error', (err: NodeJS.ErrnoException) => {
        // Toute erreur d'avant la connexion dit la même chose : cette socket ne mène à aucun daemon —
        // absente (ENOENT), refusée (ECONNREFUSED), chemin trop long (EINVAL), droits (EACCES)… Les
        // recenser une à une laissait les autres devenir des pannes internes. Seul le code est repris :
        // le message de Node contient le chemin de la socket, qui n'a rien à faire dans une réponse HTTP.
        const unreachable = !connected || UNREACHABLE_CODES.has(err.code ?? '');
        settle(() => reject(unreachable ? new DaemonUnreachableError(`daemon injoignable (${err.code ?? 'erreur de connexion'})`, { cause: err }) : err));
      });
    });
  }
}
