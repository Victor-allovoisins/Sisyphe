/**
 * Mesure et purge du cache de build. Hors de `ui/` : la page de réglages et le daemon s'en servent tous
 * deux, et le daemon n'importe rien de l'interface.
 */
import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dataPaths, type DataPaths } from '../config/paths.js';

/** Dossiers parcourus de front. Le parcours n'ouvre aucun descripteur : la borne sert à ne pas faire exploser la file. */
const WALK_DIR_CONCURRENCY = 16;

export interface PurgeResult {
  freedBytes: number;
}

/**
 * Octets d'une arborescence, liens symboliques non suivis et comptés pour zéro — **racine comprise** : un
 * `cache -> /Volumes/Ext` ferait sinon mesurer tout un disque. Somme des tailles apparentes (`size`), pas
 * des blocs occupés. Racine absente, lien ou simple fichier : 0 ; un dossier illisible ou disparu en cours de
 * route vaut 0 lui aussi. Cette mesure est une information d'appoint, elle ne lève jamais.
 */
export async function treeBytes(root: string): Promise<number> {
  const top = await lstat(root).catch(() => null);
  if (!top || top.isSymbolicLink() || !top.isDirectory()) return 0;
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const batch = stack.splice(0, WALK_DIR_CONCURRENCY);
    for (const r of await Promise.all(batch.map(dirBytes))) {
      total += r.bytes;
      stack.push(...r.dirs);
    }
  }
  return total;
}

async function dirBytes(dir: string): Promise<{ bytes: number; dirs: string[] }> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) dirs.push(path);
    else if (e.isFile()) files.push(path);
  }
  // `lstat` et non `stat` : le dirent dit déjà que c'est un fichier, et un lien apparu entre-temps ne
  // doit pas être suivi pour autant.
  const sizes = await Promise.all(files.map((f) => lstat(f).then((s) => s.size, () => 0)));
  return { bytes: sizes.reduce((a, b) => a + b, 0), dirs };
}

/**
 * Vide le contenu de `cache/` sans supprimer le dossier, et rend la place libérée, mesurée avant.
 *
 * Deux garde-fous, parce que cette fonction supprime récursivement :
 * - le chemin purgé doit être exactement celui que `dataPaths` dérive de la racine reçue — `DataPaths` est un
 *   objet ordinaire, et un `cacheDir` bricolé (la racine elle-même, le home, un `..`) est refusé ;
 * - `cache/` doit être un vrai dossier. La comparaison de chaînes ne voit pas un lien symbolique, que `readdir`
 *   suivrait et dont `rm` viderait la cible : un `cache -> /Volumes/Ext` effacerait un disque entier.
 *
 * Le dossier lui-même survit : c'est `ensureDataDirs` qui le crée, et le daemon peut tourner pendant ce temps.
 */
export async function purgeCache(paths: DataPaths): Promise<PurgeResult> {
  const expected = dataPaths(paths.root).cacheDir;
  if (paths.cacheDir !== expected) {
    throw new Error(`purge refusée : ${paths.cacheDir} n'est pas le dossier cache de ${paths.root} (${expected})`);
  }
  let top;
  try {
    top = await lstat(paths.cacheDir);
  } catch (err) {
    // Cache absent : rien à libérer, et rien à créer non plus.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { freedBytes: 0 };
    throw err;
  }
  if (top.isSymbolicLink()) throw new Error('le cache de build est un lien symbolique : purge refusée');
  if (!top.isDirectory()) throw new Error("le cache de build n'est pas un dossier : purge refusée");
  const names = await readdir(paths.cacheDir);
  const freedBytes = await treeBytes(paths.cacheDir);
  // `rm` ne suit pas un lien rencontré dans l'arborescence : il supprime le lien, jamais sa cible.
  await Promise.all(names.map((name) => rm(join(paths.cacheDir, name), { recursive: true, force: true })));
  return { freedBytes };
}
