import { mkdirSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

export type { Logger };

/**
 * Sortie standard toujours ; fichier `daemon-YYYY-MM-DD.log` en plus si logsDir est fourni.
 * Le nom est figé à la date de démarrage : pas de rotation en cours de vie du process.
 * Ne lève jamais : si le fichier ne peut pas être ouvert, seul stdout est utilisé.
 */
export function createLogger(opts: { logsDir?: string; level?: string } = {}): Logger {
  const streams: pino.StreamEntry[] = [{ stream: process.stdout }];
  let openError: unknown = null;
  if (opts.logsDir) {
    mkdirSync(opts.logsDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    // `sync: true` fait ouvrir le fichier dans le constructeur : EISDIR/EACCES lèvent ici, avant que
    // le listener 'error' ne soit posé. On dégrade en stdout seul plutôt que de faire échouer le démarrage.
    try {
      const dest = pino.destination({ dest: join(opts.logsDir, `daemon-${day}.log`), sync: true });
      dest.on('error', () => undefined);
      streams.push({ stream: dest });
    } catch (err) {
      openError = err;
    }
  }
  const log = pino({ level: opts.level ?? process.env.SISYPHE_LOG_LEVEL ?? 'info' }, pino.multistream(streams));
  if (openError) log.warn({ err: openError, logsDir: opts.logsDir }, 'fichier de log inaccessible, sortie standard uniquement');
  return log;
}

/** Supprime dans `dir` les fichiers plus vieux que `days` jours. Ignore les sous-dossiers, isole chaque entrée en erreur, et ne rejette pas si `dir` n'existe pas. */
export async function purgeOldFiles(dir: string, days: number): Promise<void> {
  const cutoff = Date.now() - days * 86_400_000;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const name of names) {
    try {
      const p = join(dir, name);
      const s = await stat(p);
      if (s.isFile() && s.mtimeMs < cutoff) await rm(p, { force: true });
    } catch {
      // Une entrée en erreur (stat, permission, suppression concurrente) n'arrête pas la purge des autres.
    }
  }
}
