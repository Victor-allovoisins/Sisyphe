import { unlinkSync } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DataPaths } from '../config/paths.js';

/** Vivant si le process répond, y compris s'il appartient à un autre utilisateur (EPERM = existe mais inaccessible). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `open(..., 'wx')` : atomique, échoue en EEXIST si le fichier est déjà là. Renvoie false dans ce seul cas ; toute autre erreur (permissions...) remonte telle quelle. */
async function tryCreate(lockPath: string): Promise<boolean> {
  try {
    const handle = await open(lockPath, 'wx');
    try {
      await handle.writeFile(String(process.pid));
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
}

function readPid(raw: string): number | null {
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Verrou mono-instance : un seul daemon Sisyphe à la fois sur cette machine (même racine de données).
 * Renvoie la fonction qui relâche le verrou.
 */
export async function acquireLock(paths: DataPaths): Promise<() => Promise<void>> {
  const lockPath = join(paths.root, 'daemon.lock');
  if (!(await tryCreate(lockPath))) {
    const raw = await readFile(lockPath, 'utf8').catch(() => '');
    const pid = readPid(raw);
    if (pid !== null && isAlive(pid)) {
      throw new Error(`Un daemon Sisyphe tourne déjà (pid ${pid}).`);
    }
    // Verrou périmé (process mort, fichier vide ou corrompu) : suppression puis une seule nouvelle tentative
    // atomique (pas de writeFile qui écraserait sans revérifier — évite de courir après un concurrent qui
    // aurait recréé le fichier entre la lecture du pid ci-dessus et maintenant).
    await rm(lockPath, { force: true });
    if (!(await tryCreate(lockPath))) {
      // Un autre process a gagné la course entre le rm et ce second open : on relit son pid et on abandonne.
      const raceRaw = await readFile(lockPath, 'utf8').catch(() => '');
      const racePid = readPid(raceRaw);
      throw new Error(`Un daemon Sisyphe tourne déjà (pid ${racePid ?? '?'}).`);
    }
  }
  // Filet de sécurité : `process.exit()` (SIGTERM/SIGINT, ou nos handlers fatals dans start.ts) court-circuite
  // souvent le `finally { await release() }` de l'appelant avant que l'unlink async n'ait eu le temps d'aboutir.
  // `exit` tourne de façon synchrone au moment de la sortie : cet unlinkSync-là atteint toujours le disque.
  const unlinkOnExit = () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // Déjà supprimé (release() normal a gagné la course), ou jamais créé : rien à faire.
    }
  };
  process.once('exit', unlinkOnExit);
  return async () => {
    process.removeListener('exit', unlinkOnExit);
    await rm(lockPath, { force: true });
  };
}
