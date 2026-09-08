import { createApp } from '../../app.js';
import { Daemon } from '../../daemon/daemon.js';

export async function startCommand(opts: { once?: boolean }): Promise<void> {
  const app = await createApp({ logToFile: !opts.once });
  const daemon = new Daemon(app.deps);
  if (opts.once) {
    await daemon.runOnce();
    return;
  }
  const stop = () => void daemon.stop().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await daemon.start();
}
