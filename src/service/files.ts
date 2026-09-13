import { chmod, writeFile } from 'node:fs/promises';

/**
 * Écrit un fichier de service en 0600. Le `mode` de `writeFile` n'est appliqué qu'à la création : sans le
 * chmod explicite, un fichier déjà présent (relance de setup) garderait ses permissions d'origine.
 */
export async function write0600(path: string, content: string): Promise<void> {
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600);
}
