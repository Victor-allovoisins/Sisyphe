import { unlinkSync } from 'node:fs';
import { open, readFile, rm, writeFile } from 'node:fs/promises';
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

/**
 * Verrou mono-instance : un seul daemon Sisyphe à la fois sur cette machine (même racine de données).
 * `open(..., 'wx')` échoue en EEXIST si le fichier est déjà là — c'est le seul cas qui nous intéresse ;
 * toute autre erreur (permissions...) remonte telle quelle. Renvoie la fonction qui relâche le verrou.
 */
export async function acquireLock(paths: DataPaths): Promise<() => Promise<void>> {
  const lockPath = join(paths.root, 'daemon.lock');
  try {
    const handle = await open(lockPath, 'wx');
    try {
      await handle.writeFile(String(process.pid));
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const raw = await readFile(lockPath, 'utf8').catch(() => '');
    const pid = Number(raw.trim());
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      throw new Error(`Un daemon Sisyphe tourne déjà (pid ${pid}).`);
    }
    // Verrou périmé (process mort, fichier vide ou corrompu) : on le reprend pour cette instance.
    await writeFile(lockPath, String(process.pid));
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
