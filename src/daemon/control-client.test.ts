import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ControlClient, DaemonUnreachableError } from './control-client.js';

let root: string;
let path: string;
const servers: Server[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sisyphe-ctl-'));
  path = join(root, 'control.sock');
});

afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

/** Faux daemon : `onLine` reçoit chaque requête (une ligne) et écrit ce qu'il veut sur la socket. */
async function fakeServer(onLine: (socket: Socket, line: string) => void): Promise<{ requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((socket) => {
    socket.setTimeout(2_000, () => socket.destroy());
    let buf = '';
    socket.on('data', (c: Buffer) => {
      buf += c.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      requests.push(line);
      onLine(socket, line);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { requests };
}

describe('ControlClient', () => {
  it('socket absente → DaemonUnreachableError ; isReachable() renvoie false', async () => {
    const client = new ControlClient(path);
    await expect(client.send('ping')).rejects.toBeInstanceOf(DaemonUnreachableError);
    expect(await client.isReachable()).toBe(false);
  });

  it('erreur de connexion inconnue (chemin trop long → EINVAL) → injoignable, sans divulguer le chemin', async () => {
    // Ni ENOENT ni ECONNREFUSED : avec une liste blanche de codes, ce cas devenait une panne interne (500)
    // dont le message contenait le chemin de la socket.
    const tooLong = join(root, 'x'.repeat(200), 'control.sock');
    const err = await new ControlClient(tooLong).send('poll').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonUnreachableError);
    expect((err as Error).message).not.toContain(root);
    expect((err as DaemonUnreachableError).timedOut).toBe(false);
    expect(await new ControlClient(tooLong).isReachable()).toBe(false);
  });

  it('délai dépassé : timedOut, pour que l’appelant sache que la commande a pu être exécutée', async () => {
    await fakeServer(() => undefined);
    const err = await new ControlClient(path, { timeoutMs: 50 }).send('poll').catch((e: unknown) => e);
    expect((err as DaemonUnreachableError).timedOut).toBe(true);
    // Socket absente : rien n'est parti, ce n'est pas un délai dépassé.
    const absent = await new ControlClient(join(root, 'absente.sock')).send('poll').catch((e: unknown) => e);
    expect((absent as DaemonUnreachableError).timedOut).toBe(false);
  });

  it('serveur muet → DaemonUnreachableError après le délai injecté : celui des commandes, ou celui de ping', async () => {
    await fakeServer(() => undefined);
    const client = new ControlClient(path, { timeoutMs: 100, pingTimeoutMs: 150 });
    await expect(client.send('cancel', { jobId: 'j1' })).rejects.toThrow(/ne répond pas \(100 ms\)/);
    await expect(client.send('ping')).rejects.toThrow(/ne répond pas \(150 ms\)/);
    expect(await client.isReachable()).toBe(false);
  });

  it('serveur qui ferme sans répondre → DaemonUnreachableError', async () => {
    await fakeServer((socket) => socket.end());
    await expect(new ControlClient(path).send('ping')).rejects.toBeInstanceOf(DaemonUnreachableError);
  });

  it('réponse non JSON ou de forme inattendue → Error ordinaire, que isReachable() propage', async () => {
    let answer = 'n’importe quoi\n';
    await fakeServer((socket) => socket.end(answer));
    const client = new ControlClient(path);
    const err = await client.send('ping').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DaemonUnreachableError);
    await expect(client.isReachable()).rejects.toThrow(/réponse illisible/);

    answer = '{"ok":false}\n';
    await expect(client.send('ping')).rejects.toThrow(/réponse inattendue/);
    answer = '{"ok":true}\n'; // succès sans `result` : pas une réponse du protocole
    await expect(client.send('ping')).rejects.toThrow(/réponse inattendue/);
  });

  it('envoie une ligne { cmd, source, ...args } (source cli par défaut) et rend la réponse telle quelle', async () => {
    const { requests } = await fakeServer((socket, line) => {
      const req = JSON.parse(line) as { cmd: string };
      socket.end(req.cmd === 'ping' ? '{"ok":true,"result":{"pid":42}}\n' : '{"ok":false,"error":"job inconnu : j1"}\n');
    });
    const client = new ControlClient(path);

    expect(await client.send('ping')).toEqual({ ok: true, result: { pid: 42 } });
    expect(await client.send('cancel', { jobId: 'j1' }, 'ui')).toEqual({ ok: false, error: 'job inconnu : j1' });
    expect(await client.isReachable()).toBe(true);
    expect(requests.map((r) => JSON.parse(r) as unknown)).toEqual([
      { cmd: 'ping', source: 'cli' },
      { cmd: 'cancel', source: 'ui', jobId: 'j1' },
      { cmd: 'ping', source: 'cli' },
    ]);
  });
});
