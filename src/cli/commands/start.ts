import { createApp } from '../../app.js';
import { Daemon } from '../../daemon/daemon.js';
import { acquireLock } from '../../daemon/lock.js';

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

  const release = await acquireLock(app.paths);
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
}
