import { loadMachineConfig } from '../../config/machine.js';
import { dataPaths, machineConfigPath } from '../../config/paths.js';
import { openDatabaseReadOnly } from '../../store/db.js';
import { JobStore } from '../../store/jobs.js';
import { PhaseStore } from '../../store/phases.js';
import { createUiData } from '../../ui/data.js';
import { PAGE_HTML } from '../../ui/page.js';
import { DEFAULT_UI_PORT, startUiServer } from '../../ui/server.js';

export function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_UI_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Port invalide : ${raw} (attendu 1 à 65535)`);
  return port;
}

/**
 * Interface web locale, strictement en lecture : base ouverte en `readOnly`, aucun répertoire créé
 * (surtout pas `ensureDataDirs`), pas de `createApp` — ni client GitHub ni agent, donc aucune clé requise.
 */
export async function uiCommand(opts: { port?: string }): Promise<void> {
  const machine = await loadMachineConfig(machineConfigPath());
  const paths = dataPaths(machine.dataDir);
  const port = parsePort(opts.port);
  const db = openDatabaseReadOnly(paths.dbPath);
  const data = createUiData({ store: new JobStore(db), phases: new PhaseStore(db), paths, machine });
  let server: Awaited<ReturnType<typeof startUiServer>>;
  try {
    server = await startUiServer({ data, page: PAGE_HTML, port });
  } catch (err) {
    // Port occupé, par exemple : la connexion SQLite ne doit pas rester ouverte derrière l'erreur.
    db.close();
    throw err;
  }
  console.log(`Sisyphe UI (lecture seule) : http://${server.host}:${server.port}`);
  console.log('Ctrl+C pour arrêter.');
  await new Promise<void>((resolve) => {
    // `finally` et non `then` : même si la fermeture échoue, Ctrl+C rend la main.
    const stop = () => {
      void server.close().finally(() => {
        db.close();
        resolve();
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
