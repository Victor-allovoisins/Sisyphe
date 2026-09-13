import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { MachineConfigError } from '../../config/machine.js';
import { ensureDataDirs, machineConfigPath } from '../../config/paths.js';
import { ControlClient } from '../../daemon/control-client.js';
import { ActionStore } from '../../store/actions.js';
import { SCHEMA_VERSION, openDatabase, openDatabaseReadOnly } from '../../store/db.js';
import { JobStore } from '../../store/jobs.js';
import { PhaseStore } from '../../store/phases.js';
import { createControlProbe, runAction } from '../../ui/actions.js';
import { createUiData } from '../../ui/data.js';
import { PAGE_HTML } from '../../ui/page.js';
import { DEFAULT_UI_PORT, startUiServer, type UiServer } from '../../ui/server.js';
import { loadServiceTarget, type ServiceTarget } from './service.js';

export function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_UI_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Port invalide : ${raw} (attendu 1 à 65535)`);
  return port;
}

/** Config, chemins et gestionnaire de service, avec la consigne d'installation quand la config manque : l'UI est souvent le premier contact. */
async function loadUiTarget(): Promise<ServiceTarget> {
  try {
    return await loadServiceTarget();
  } catch (err) {
    if (err instanceof MachineConfigError && err.kind === 'missing') {
      throw new Error(`Config machine absente : ${machineConfigPath()}. Lancer install.sh ou \`sisyphe setup\`.`);
    }
    throw err;
  }
}

function schemaVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

/**
 * Base prête à être lue par l'UI : absente ou en retard sur le schéma, elle est ouverte une fois en
 * écriture (création et migrations) puis refermée. L'UI n'exige donc plus qu'un `sisyphe start` soit
 * passé avant elle ; la connexion rendue reste strictement en lecture seule.
 */
export function openUiDatabase(dbPath: string): DatabaseSync {
  if (!existsSync(dbPath) || schemaVersion(dbPath) < SCHEMA_VERSION) openDatabase(dbPath).close();
  return openDatabaseReadOnly(dbPath);
}

export interface RunningUi {
  server: UiServer;
  /** Ferme le serveur puis la connexion SQLite, même si la fermeture du serveur échoue. */
  close(): Promise<void>;
}

export interface UiOptions {
  port?: string;
  /** `--read-only` : l'interface observe sans agir, aucun POST n'est accepté. */
  readOnly?: boolean;
}

/** Monte l'UI (config, base, gestionnaire de service, serveur) sans bloquer : `uiCommand` attend le signal. */
export async function startUi(opts: UiOptions): Promise<RunningUi> {
  // Tout ce qui peut échouer passe avant l'ouverture de la base : une erreur ne doit pas laisser
  // une connexion SQLite ouverte derrière elle.
  const { machine, paths, manager } = await loadUiTarget();
  const port = parsePort(opts.port);
  const readOnly = opts.readOnly === true;
  await ensureDataDirs(paths);
  const db = openUiDatabase(paths.dbPath);
  // Le journal des actions est seulement lu ici : la connexion reste en lecture seule, c'est le daemon qui l'écrit.
  const client = new ControlClient(paths.controlSocketPath);
  const data = createUiData({
    store: new JobStore(db),
    phases: new PhaseStore(db),
    paths,
    machine,
    service: manager,
    actions: new ActionStore(db),
    control: createControlProbe(client),
    readOnly,
  });
  let server: UiServer;
  try {
    server = await startUiServer({
      data,
      page: PAGE_HTML,
      port,
      // `start` et `stop` passent par le gestionnaire de service : arrêter le daemon par la seule socket
      // le ferait relancer aussitôt par launchd ou systemd.
      actions: readOnly ? undefined : (name, body) => runAction(name, body, { client, service: manager, paths }),
    });
  } catch (err) {
    // Port occupé, par exemple : la connexion SQLite ne doit pas rester ouverte derrière l'erreur.
    db.close();
    throw err;
  }
  return {
    server,
    close: () =>
      server.close().finally(() => {
        db.close();
      }),
  };
}

/** Ligne d'accueil : « lecture seule » n'apparaît qu'avec l'option, sinon l'interface agit. */
export function startupMessage(host: string, port: number, readOnly: boolean): string {
  return `Sisyphe UI${readOnly ? ' (lecture seule)' : ''} : http://${host}:${port}`;
}

/** Interface web locale : pas de `createApp` — ni client GitHub ni agent, donc aucune clé requise. */
export async function uiCommand(opts: UiOptions): Promise<void> {
  const ui = await startUi(opts);
  console.log(startupMessage(ui.server.host, ui.server.port, opts.readOnly === true));
  console.log('Ctrl+C pour arrêter.');
  await new Promise<void>((resolve) => {
    // `finally` et non `then` : même si la fermeture échoue, Ctrl+C rend la main.
    const stop = () => {
      void ui.close().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
