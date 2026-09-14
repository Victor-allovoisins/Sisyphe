/**
 * Données de la page de réglages : la configuration telle qu'écrite, le diagnostic, l'occupation disque
 * et la purge du cache de build. Les routes HTTP qui servent tout cela vivent ailleurs ; ce module ne
 * connaît ni requête ni réponse, et n'a d'autre état que ses deux mémorisations.
 */
import { lstat, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Check } from '../cli/checks.js';
import { MachineConfigError, parseMachineConfigAsWritten, type MachineConfig } from '../config/machine.js';
import { dataPaths, type DataPaths } from '../config/paths.js';
import {
  HOT_RELOAD_FIELDS,
  RESTART_REQUIRED_FIELDS,
  type HotReloadField,
  type RestartRequiredField,
} from '../daemon/control-types.js';
import { realExec, type Exec } from '../service/exec.js';

/** Diagnostic et occupation disque sont coûteux et jamais urgents : deux appels rapprochés partagent le même calcul. */
const MEMO_TTL_MS = 30_000;
/** Dossiers parcourus de front. Le parcours n'ouvre aucun descripteur : la borne sert à ne pas faire exploser la file. */
const WALK_DIR_CONCURRENCY = 16;
/** Premier numéro de version trouvé dans la sortie : `git version 2.39.5 (Apple Git-154)` → `2.39.5`. */
const SEMVER_RE = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/;

export interface SettingsView {
  /**
   * La configuration **telle qu'écrite sur disque**, défauts du schéma compris, jamais développée :
   * `~/.sisyphe` reste `~/.sisyphe`. La page la repostera telle quelle, et une forme développée
   * effacerait tout raccourci `~` du fichier dès le premier enregistrement.
   */
  config: MachineConfig;
  /** Le dossier de données réellement utilisé, développé : affiché en lecture seule, jamais reposté. */
  dataDir: string;
  hotReloadable: HotReloadField[];
  restartRequired: RestartRequiredField[];
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckView {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** `null` : outil absent, en échec, ou sortie sans numéro de version — jamais une exception. */
export interface VersionsView {
  sisyphe: string | null;
  node: string | null;
  claude: string | null;
  git: string | null;
  gitleaks: string | null;
}

export interface PathsView {
  config: string;
  data: string;
  socket: string;
  logs: string;
}

export interface Diagnostics {
  checks: CheckView[];
  versions: VersionsView;
  paths: PathsView;
}

export interface DiskEntry {
  name: string;
  path: string;
  bytes: number;
}

export interface DiskUsage {
  entries: DiskEntry[];
  totalBytes: number;
}

export interface PurgeResult {
  freedBytes: number;
}

export interface SettingsDataDeps {
  paths: DataPaths;
  /** Chemin du `config.yml`, affiché dans les chemins et relu à chaque appel : il change hors du process. */
  configPath: string;
  /**
   * Construit la liste des contrôles, sans en exécuter aucun : c'est `buildChecks` de `cli/commands/doctor.ts`,
   * injecté plutôt qu'importé. Ses checks lisent la vraie config, lancent des sous-process et appellent
   * GitHub : le câblage appartient à l'appelant, et un test ne peut pas le déclencher par mégarde.
   */
  buildChecks: () => Check[];
  exec?: Exec;
  /** Horloge en millisecondes, pour les deux mémorisations. */
  now?: () => number;
}

export interface SettingsData {
  settingsView(): Promise<SettingsView>;
  diagnostics(): Promise<Diagnostics>;
  diskUsage(): Promise<DiskUsage>;
  purgeCache(): Promise<PurgeResult>;
}

/** Indexé par `VersionsView` : une version ajoutée à la vue sans outil pour la produire ne compile pas. */
const VERSION_TOOLS: Record<keyof VersionsView, { bin: string; args: string[] }> = {
  sisyphe: { bin: 'sisyphe', args: ['--version'] },
  node: { bin: 'node', args: ['--version'] },
  claude: { bin: 'claude', args: ['--version'] },
  git: { bin: 'git', args: ['--version'] },
  gitleaks: { bin: 'gitleaks', args: ['--version'] },
};

/** Les cinq dossiers dont la page montre la taille, dans l'ordre d'affichage. */
const DISK_TARGETS: { name: string; dir: (p: DataPaths) => string }[] = [
  { name: 'cache', dir: (p) => p.cacheDir },
  { name: 'mirrors', dir: (p) => p.mirrorsDir },
  { name: 'work', dir: (p) => p.workDir },
  { name: 'logs', dir: (p) => p.logsDir },
  { name: 'jobs', dir: (p) => p.jobsDir },
];

/**
 * La configuration telle qu'écrite, plus ce que la page doit afficher autour.
 *
 * Le fichier est relu et validé par le schéma sans passer par `loadMachineConfig`, qui développe `~/…` :
 * la page reposte ce qu'elle a reçu, donc tout développement ici serait gravé dans le fichier au premier
 * enregistrement. D'où aussi la signature : un `MachineConfig` déjà analysé ne conviendrait pas, ses
 * chemins ayant traversé `expandHome`. `paths` ne sert qu'à `dataDir`, la forme développée, en lecture seule.
 *
 * Aucun secret n'en sort : le schéma ne porte que le *chemin* de la clé privée, dont le contenu n'est
 * jamais lu, et la clé API relève de l'environnement du service, pas du fichier.
 */
export async function settingsView(configPath: string, paths: DataPaths): Promise<SettingsView> {
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MachineConfigError('missing', `Config machine absente : ${configPath}. Lancer \`sisyphe setup\`.`);
    }
    throw err;
  }
  return {
    config: parseMachineConfigAsWritten(text),
    dataDir: paths.root,
    hotReloadable: [...HOT_RELOAD_FIELDS],
    restartRequired: [...RESTART_REQUIRED_FIELDS],
  };
}

/**
 * Exécute des contrôles de `doctor` et rend le résultat en données plutôt qu'en lignes à émoji.
 *
 * Même sémantique que `runChecks` (`cli/checks.ts`), qui reste la forme terminal : succès, succès dégradé
 * `{ warn }`, échec d'un check `warn: true` (⚠️), échec ordinaire (❌). La liste des contrôles, elle, n'est
 * pas dupliquée — c'est `buildChecks` qui la produit, ici comme dans `doctor`. Séquentiel comme `runChecks` :
 * certains contrôles appellent GitHub, rien ne gagne à les lancer tous de front.
 */
export async function checkResults(checks: Check[]): Promise<CheckView[]> {
  const results: CheckView[] = [];
  for (const c of checks) {
    try {
      const result = await c.run();
      if (typeof result === 'string') results.push({ name: c.name, status: 'ok', detail: result });
      else results.push({ name: c.name, status: 'warn', detail: result.message });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ name: c.name, status: c.warn ? 'warn' : 'fail', detail });
    }
  }
  return results;
}

/** Version d'un outil, ou `null` : un outil absent ou une sortie inattendue n'est pas une panne du diagnostic. */
async function toolVersion(exec: Exec, bin: string, args: string[]): Promise<string | null> {
  const r = await exec(bin, args).catch(() => null);
  if (!r || r.exitCode !== 0) return null;
  return SEMVER_RE.exec(r.stdout)?.[0] ?? null;
}

/** Les cinq versions, interrogées de front : aucune ne dépend d'une autre, et l'ensemble est mémorisé. */
async function versions(exec: Exec): Promise<VersionsView> {
  const of = (key: keyof VersionsView) => toolVersion(exec, VERSION_TOOLS[key].bin, VERSION_TOOLS[key].args);
  const [sisyphe, node, claude, git, gitleaks] = await Promise.all([
    of('sisyphe'), of('node'), of('claude'), of('git'), of('gitleaks'),
  ]);
  return { sisyphe, node, claude, git, gitleaks };
}

/**
 * Octets d'une arborescence, liens symboliques non suivis et comptés pour zéro : le cache de build en est
 * plein, et un lien sortant ferait parcourir tout le disque — ou boucler. Somme des tailles apparentes
 * (`size`), pas des blocs occupés. Un dossier illisible ou disparu en cours de route vaut 0 : cette mesure
 * est une information d'appoint, elle ne doit jamais faire tomber la page.
 */
async function treeBytes(root: string): Promise<number> {
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

/** Taille des cinq dossiers de données et leur total. Un dossier absent vaut 0 octet, jamais une exception. */
export async function diskUsage(paths: DataPaths): Promise<DiskUsage> {
  const entries = await Promise.all(
    DISK_TARGETS.map(async ({ name, dir }) => {
      const path = dir(paths);
      return { name, path, bytes: await treeBytes(path) };
    }),
  );
  return { entries, totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0) };
}

/**
 * Vide le contenu de `cache/` sans supprimer le dossier, et rend la place libérée, mesurée avant.
 *
 * Le garde-fou n'est pas décoratif : cette fonction supprime récursivement, et `DataPaths` est un objet
 * ordinaire qu'un appelant peut avoir fabriqué à la main. Le chemin purgé doit être exactement celui que
 * `dataPaths` dérive de la racine reçue — un `cacheDir` bricolé (la racine elle-même, le home, un `..`)
 * est refusé avant toute suppression. Le dossier lui-même survit : c'est `ensureDataDirs` qui le crée,
 * et le daemon peut tourner pendant ce temps.
 */
export async function purgeCache(paths: DataPaths): Promise<PurgeResult> {
  const expected = dataPaths(paths.root).cacheDir;
  if (paths.cacheDir !== expected) {
    throw new Error(`purge refusée : ${paths.cacheDir} n'est pas le dossier cache de ${paths.root} (${expected})`);
  }
  const names = await readdir(paths.cacheDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  // Cache absent : rien à libérer, et rien à créer non plus.
  if (names === null) return { freedBytes: 0 };
  const freedBytes = await treeBytes(paths.cacheDir);
  await Promise.all(names.map((name) => rm(join(paths.cacheDir, name), { recursive: true, force: true })));
  return { freedBytes };
}

/** Lecture mémorisée ; `reset` la périme avant l'heure, pour ce qui sait l'avoir rendue fausse. */
interface Memo<T> {
  (): Promise<T>;
  reset(): void;
}

/**
 * Mémorise le résultat 30 s. C'est la promesse qui est gardée, pas seulement sa valeur : deux appels
 * concurrents partagent le même calcul au lieu d'en lancer deux. Un échec n'est pas mis en cache — le
 * suivant réessaie, sinon une panne passagère resterait affichée une demi-minute.
 */
function memoize<T>(fn: () => Promise<T>, now: () => number): Memo<T> {
  let cached: { at: number; value: Promise<T> } | null = null;
  const get = async (): Promise<T> => {
    const at = now();
    if (!cached || at - cached.at > MEMO_TTL_MS) cached = { at, value: fn() };
    const pending = cached;
    try {
      return await pending.value;
    } catch (err) {
      if (cached === pending) cached = null;
      throw err;
    }
  };
  return Object.assign(get, { reset: () => { cached = null; } });
}

/**
 * Les quatre lectures de la page de réglages, câblées sur une installation. Seuls le diagnostic et
 * l'occupation disque sont mémorisés : la configuration est relue à chaque fois, parce que la page vient
 * peut-être de l'écrire, et la purge est une écriture — la mémoriser en rendrait la seconde gratuite et fausse.
 */
export function createSettingsData(deps: SettingsDataDeps): SettingsData {
  const { paths, configPath } = deps;
  const exec = deps.exec ?? realExec;
  const now = deps.now ?? (() => Date.now());

  const diagnostics = memoize(async (): Promise<Diagnostics> => {
    const checks = deps.buildChecks();
    return {
      checks: await checkResults(checks),
      versions: await versions(exec),
      paths: { config: configPath, data: paths.root, socket: paths.controlSocketPath, logs: paths.logsDir },
    };
  }, now);

  const disk = memoize(() => diskUsage(paths), now);

  return {
    settingsView: () => settingsView(configPath, paths),
    diagnostics,
    diskUsage: disk,
    purgeCache: async () => {
      const result = await purgeCache(paths);
      // La mesure d'avant la purge est fausse dès le premier fichier supprimé : sans cela, la page
      // annoncerait la place libérée tout en affichant pendant une demi-minute le cache toujours plein.
      disk.reset();
      return result;
    },
  };
}
