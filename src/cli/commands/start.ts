import { createApp } from '../../app.js';
import { Daemon } from '../../daemon/daemon.js';
import { acquireLock } from '../../daemon/lock.js';
import { LAUNCHD_LABEL } from '../launchd.js';

export async function startCommand(opts: { once?: boolean }): Promise<void> {
  const app = await createApp({ logToFile: !opts.once });
  const log = app.deps.log;

  // Un crash non rattrapé ne doit pas disparaître silencieusement (stdout perdu sous launchd) :
  // on le journalise en fatal via le logger de l'app avant de sortir.
  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason }, 'unhandledRejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaughtException');
    process.exit(1);
  });

  let release: () => Promise<void>;
  try {
    release = await acquireLock(app.paths);
  } catch (err) {
    // Le cas le plus probable : l'agent launchd tourne déjà en tâche de fond (KeepAlive) et on vient de
    // relancer `sisyphe start` à la main par-dessus — indiquer comment l'arrêter plutôt que de laisser
    // le message brut du verrou.
    if (err instanceof Error && err.message.includes('tourne déjà')) {
      throw new Error(`${err.message} Arrêter l'agent launchd d'abord : launchctl bootout gui/$UID/${LAUNCHD_LABEL}.`);
    }
    throw err;
  }
  try {
    const daemon = new Daemon(app.deps);
    if (opts.once) {
      await daemon.runOnce();
      return;
    }
    const stop = () => void daemon.stop().then(() => process.exit(0));
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    await daemon.start();
  } finally {
    await release();
  }
  // Arrêt demandé par la socket de contrôle : start() s'est résolu, on sort comme après SIGTERM, verrou relâché.
  process.exit(0);
}
