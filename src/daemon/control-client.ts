import { createConnection } from 'node:net';
import type { ActionSource } from '../store/actions.js';
import type { CommandResult, ControlArgs, ControlCommand } from './control-types.js';

const DEFAULT_TIMEOUT_MS = 5_000;
/** Socket absente, daemon arrêté, connexion coupée pendant l'arrêt : autant de façons de ne pas répondre. */
const UNREACHABLE_CODES = new Set(['ENOENT', 'ENOTSOCK', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE']);

/** Le daemon ne répond pas : socket absente, connexion refusée ou délai dépassé. Les autres erreurs sont des pannes. */
export class DaemonUnreachableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DaemonUnreachableError';
  }
}

function isCommandResult(v: unknown): v is CommandResult<unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as { ok?: unknown; error?: unknown };
  return r.ok === true || (r.ok === false && typeof r.error === 'string');
}

/** Client de la socket de contrôle : une connexion par commande, une ligne envoyée, une ligne lue. */
export class ControlClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly socketPath: string,
    opts: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** `stop` : la réponse arrive avant l'arrêt du daemon ; on n'attend pas la fin de son process. */
  async send<T = unknown>(cmd: ControlCommand, args: ControlArgs = {}, source: ActionSource = 'cli'): Promise<CommandResult<T>> {
    const line = await this.exchange(`${JSON.stringify({ cmd, source, ...args })}\n`);
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

  private exchange(payload: string): Promise<string> {
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
      const timer = setTimeout(() => settle(() => reject(new DaemonUnreachableError(`le daemon ne répond pas (${this.timeoutMs} ms)`))), this.timeoutMs);
      socket.on('connect', () => socket.write(payload));
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
        settle(() => reject(UNREACHABLE_CODES.has(err.code ?? '') ? new DaemonUnreachableError(`daemon injoignable (${err.code})`, { cause: err }) : err));
      });
    });
  }
}
