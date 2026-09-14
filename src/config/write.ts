import { randomUUID } from 'node:crypto';
import { access, chmod, constants, copyFile, rename, rm, stat } from 'node:fs/promises';
import { stringify } from 'yaml';
import { write0600 } from '../service/files.js';
import { MachineConfigSchema, type MachineConfig } from './machine.js';
import { expandHome } from './paths.js';

/** Un champ refusé : `path` en notation pointée (`github.appId`, `repos.1`), `message` tel que zod l'a produit. */
export interface ConfigIssue {
  path: string;
  message: string;
}

export type ValidateMachineConfigResult = { ok: true; config: MachineConfig } | { ok: false; issues: ConfigIssue[] };

/**
 * Valide une configuration reçue de la page de réglages, avant toute écriture.
 *
 * Trois couches, dans cet ordre : `MachineConfigSchema`, puis deux règles que le schéma ne peut pas porter —
 * `dataDir` immuable (le modifier déplacerait la base que l'interface est en train de lire) et clé privée
 * lisible. Les règles locales ne sont jouées que sur une entrée déjà valide au schéma : sinon elles
 * porteraient sur des champs dont on ne sait pas encore s'ils sont des chaînes. Les deux sont jouées
 * ensemble, pour que la page affiche les deux erreurs d'un coup plutôt qu'une par aller-retour.
 *
 * Asynchrone à cause du seul `access` de la clé privée.
 *
 * La configuration renvoyée n'a **pas** traversé `expandHome`, contrairement à celle de `parseMachineConfig` :
 * elle porte les chemins exactement comme la page les a soumis, et c'est elle qu'attend `writeMachineConfig`.
 */
export async function validateMachineConfigInput(raw: unknown, current: MachineConfig): Promise<ValidateMachineConfigResult> {
  // `raw` tel quel, sans `?? {}` : un corps nul est un corps invalide, et « objet attendu » sur la racine est
  // plus parlant pour la page qu'une liste de champs manquants.
  const result = MachineConfigSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, issues: result.error.issues.map((i) => ({ path: i.path.join('.') || '(racine)', message: i.message })) };
  }
  const config = result.data;
  const issues: ConfigIssue[] = [];
  // Comparaison sur les formes développées : `current` vient de `parseMachineConfig`, donc déjà développée,
  // alors que la page renvoie ce que le fichier contient. `~/.sisyphe` n'est pas une modification de
  // `/Users/x/.sisyphe`, et ne doit pas être refusé comme telle.
  if (expandHome(config.dataDir) !== expandHome(current.dataDir)) {
    issues.push({ path: 'dataDir', message: "non modifiable depuis l'interface, utiliser `sisyphe setup`" });
  }
  // Seul le chemin circule : le contenu de la clé n'est ni lu, ni affiché, ni transmis. `access` seul ne
  // suffit pas — il réussit sur un dossier, que le client GitHub ne saurait pourtant pas lire.
  const keyPath = expandHome(config.github.privateKeyPath);
  let readableFile = false;
  try {
    await access(keyPath, constants.R_OK);
    readableFile = (await stat(keyPath)).isFile();
  } catch {
    readableFile = false;
  }
  if (!readableFile) {
    issues.push({ path: 'github.privateKeyPath', message: `fichier introuvable ou illisible : ${config.github.privateKeyPath}` });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, config };
}

/** Copie la version en place en `<path>.bak`, en 0600. Sans objet à la première écriture : il n'y a rien à sauvegarder. */
async function backupExisting(path: string): Promise<void> {
  const backup = `${path}.bak`;
  try {
    await copyFile(path, backup);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  // `copyFile` reprend le mode de la source, qui peut avoir été relâché à la main : on le referme.
  await chmod(backup, 0o600);
}

/**
 * Écrit la configuration machine sans jamais laisser le fichier à moitié remplacé : écriture dans un
 * temporaire du même dossier — donc du même système de fichiers, seule condition pour que `rename` soit
 * atomique — copie de la version en place en `<path>.bak`, puis `rename`. Le tout en 0600.
 *
 * La sauvegarde vient après le temporaire et juste avant le `rename` : plus tôt, une écriture qui échoue
 * ferait quand même tourner l'historique — `.bak` prendrait la valeur du `config.yml` resté en place, et
 * l'unique version précédente serait perdue pour rien.
 *
 * `config` est écrit tel quel, sans expansion de `~` : c'est celui que renvoie `validateMachineConfigInput`,
 * dont les chemins n'ont pas traversé `expandHome`. Passer ici le résultat d'un `parseMachineConfig` graverait
 * des chemins absolus à la place des `~/…` saisis, à la première sauvegarde et pour toujours. Le type
 * `MachineConfig` ne sait pas distinguer les deux : c'est à l'appelant de fournir les valeurs à écrire.
 */
export async function writeMachineConfig(path: string, config: MachineConfig): Promise<void> {
  // Suffixe aléatoire en plus du pid : deux enregistrements simultanés viennent du même processus, l'interface.
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    await write0600(tmp, stringify(config));
    await backupExisting(path);
    await rename(tmp, path);
  } catch (err) {
    // Rien ne doit rester derrière un échec : le dossier de données est aussi celui que l'interface affiche.
    // L'erreur d'origine prime — un ménage qui échoue à son tour désignerait la mauvaise cause à l'opérateur.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}
