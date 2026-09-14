/**
 * Données de la page de réglages : la configuration telle qu'écrite, le diagnostic, l'occupation disque
 * et la purge du cache de build. Les routes HTTP qui servent tout cela vivent ailleurs ; ce module ne
 * connaît ni requête ni réponse, et n'a d'autre état que ses deux mémorisations.
 */
import { readFile } from 'node:fs/promises';
import { checkResults, type Check, type CheckView } from '../cli/checks.js';
import { MachineConfigError, parseMachineConfigAsWritten, type MachineConfig } from '../config/machine.js';
import type { DataPaths } from '../config/paths.js';
import {
  HOT_RELOAD_FIELDS,
  RESTART_REQUIRED_FIELDS,
  type HotReloadField,
  type RestartRequiredField,
} from '../daemon/control-types.js';
import { realExec, type Exec } from '../service/exec.js';
import { purgeCache, treeBytes, type PurgeResult } from '../util/cache.js';

/** Diagnostic et occupation disque sont coûteux et jamais urgents : deux appels rapprochés partagent le même calcul. */
const MEMO_TTL_MS = 30_000;
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
  /** `fresh` : ignore l'âge du résultat mémorisé (bouton Relancer), mais rejoint un calcul déjà en cours. */
  diagnostics(opts?: { fresh?: boolean }): Promise<Diagnostics>;
  diskUsage(): Promise<DiskUsage>;
  /** Purge locale, quand le daemon est arrêté ; périme d'elle-même la mesure disque. */
  purgeCache(): Promise<PurgeResult>;
  /** Après un enregistrement : le prochain diagnostic porte sur la configuration écrite. */
  invalidateDiagnostics(): void;
  /** Après une purge faite par le daemon : la mesure disque mémorisée ne vaut plus rien. */
  invalidateDisk(): void;
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

/** Taille des cinq dossiers de données et leur total. Un dossier absent ou un lien symbolique vaut 0 octet, jamais une exception. */
export async function diskUsage(paths: DataPaths): Promise<DiskUsage> {
  const entries = await Promise.all(
    DISK_TARGETS.map(async ({ name, dir }) => {
      const path = dir(paths);
      return { name, path, bytes: await treeBytes(path) };
    }),
  );
  return { entries, totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0) };
}

/** Lecture mémorisée ; `reset` la périme avant l'heure, pour ce qui sait l'avoir rendue fausse. */
interface Memo<T> {
  (opts?: { fresh?: boolean }): Promise<T>;
  reset(): void;
}

interface MemoEntry<T> {
  at: number;
  value: Promise<T>;
  settled: boolean;
}

/**
 * Mémorise le résultat 30 s. C'est la promesse qui est gardée, pas seulement sa valeur : deux appels
 * concurrents partagent le même calcul au lieu d'en lancer deux. Un échec n'est pas mis en cache — le
 * suivant réessaie, sinon une panne passagère resterait affichée une demi-minute.
 *
 * `fresh` passe outre l'âge d'un résultat déjà obtenu, jamais un calcul en cours : dix clics sur « Relancer »
 * rejoignent le même diagnostic au lieu de lancer dix salves d'appels GitHub en parallèle.
 */
function memoize<T>(fn: () => Promise<T>, now: () => number): Memo<T> {
  let cached: MemoEntry<T> | null = null;
  const get = async (opts: { fresh?: boolean } = {}): Promise<T> => {
    const at = now();
    let entry = cached;
    if (!entry || at - entry.at > MEMO_TTL_MS || (opts.fresh === true && entry.settled)) {
      const started: MemoEntry<T> = { at, value: fn(), settled: false };
      const settle = () => {
        started.settled = true;
      };
      started.value.then(settle, settle);
      entry = started;
      cached = started;
    }
    const pending = entry;
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
 * Les lectures de la page de réglages, câblées sur une installation. Seuls le diagnostic et l'occupation
 * disque sont mémorisés : la configuration est relue à chaque fois, parce que la page vient peut-être de
 * l'écrire, et la purge est une écriture — la mémoriser en rendrait la seconde gratuite et fausse.
 *
 * Un seul exemplaire par interface, partagé par les routes GET et les actions : un enregistrement ou une
 * purge doit périmer les mémorisations que la page relit, pas celles d'un exemplaire voisin.
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
    diagnostics: (opts) => diagnostics(opts),
    diskUsage: () => disk(),
    purgeCache: async () => {
      try {
        return await purgeCache(paths);
      } finally {
        // La mesure d'avant est fausse dès le premier fichier supprimé, que la purge aille au bout ou non.
        disk.reset();
      }
    },
    invalidateDiagnostics: () => diagnostics.reset(),
    invalidateDisk: () => disk.reset(),
  };
}
