import { spawn } from 'node:child_process';

/** Empêche la veille macOS tant que le processus courant vit. No-op ailleurs. Renvoie la fonction d'arrêt. */
export function startCaffeinate(): () => void {
  if (process.platform !== 'darwin') return () => undefined;
  const child = spawn('caffeinate', ['-dims', '-w', String(process.pid)], { stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
  return () => {
    if (!child.killed) child.kill();
  };
}
