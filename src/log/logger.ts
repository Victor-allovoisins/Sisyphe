import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

export type { Logger };

/** Sortie standard toujours ; fichier `daemon-YYYY-MM-DD.log` en plus si logsDir est fourni. */
export function createLogger(opts: { logsDir?: string; level?: string } = {}): Logger {
  const streams: pino.StreamEntry[] = [{ stream: process.stdout }];
  if (opts.logsDir) {
    mkdirSync(opts.logsDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    streams.push({ stream: pino.destination({ dest: join(opts.logsDir, `daemon-${day}.log`), sync: false }) });
  }
  return pino({ level: opts.level ?? process.env.SISYPHE_LOG_LEVEL ?? 'info' }, pino.multistream(streams));
}
