import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ControlClient } from '../../daemon/control-client.js';
import type { CommandResult } from '../../daemon/control-types.js';
import type { IssueRef } from '../../github/source.js';
import { openDatabase } from '../../store/db.js';
import { JobStore } from '../../store/jobs.js';
import type { Job } from '../../store/types.js';
import { cancelJob } from './cancel.js';

let root: string;
let path: string;
let server: Server | null = null;
let job: Job;
let logs: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sisyphe-cancel-'));
  path = join(root, 'control.sock');
  job = new JobStore(openDatabase(':memory:')).create({ repo: 'acme/demo', issueNumber: 7, issueTitle: 'Hello' });
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  const s = server;
  server = null;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

/** Faux daemon : répond `answer` à toute requête et enregistre chacune. */
async function fakeDaemon(answer: CommandResult<unknown>): Promise<{ requests: Array<Record<string, unknown>> }> {
  const requests: Array<Record<string, unknown>> = [];
  server = createServer((socket) => {
    socket.once('data', (c: Buffer) => {
      requests.push(JSON.parse(c.toString('utf8').split('\n')[0]) as Record<string, unknown>);
      socket.end(`${JSON.stringify(answer)}\n`);
    });
  });
  const s = server;
  await new Promise<void>((resolve) => s.listen(path, resolve));
  return { requests };
}

function fakeSource() {
  const removed: IssueRef[] = [];
  return {
    removed,
    async removeTriggerLabel(ref: IssueRef) {
      removed.push(ref);
    },
  };
}

describe('cancelJob', () => {
  it('daemon joignable : envoie cancel (source cli) directement, sans ping préalable ni retrait de label', async () => {
    const { requests } = await fakeDaemon({ ok: true, result: { ...job, state: 'cancelled' } });
    const source = fakeSource();

    await cancelJob(job, { client: new ControlClient(path), source });

    expect(requests).toEqual([{ cmd: 'cancel', source: 'cli', jobId: job.id }]);
    expect(source.removed).toEqual([]);
    expect(logs).toEqual([`Job ${job.id} annulé.`]);
  });

  it('daemon joignable mais refus : lève l’erreur du daemon (la CLI sort en 1)', async () => {
    await fakeDaemon({ ok: false, error: 'job déjà terminé (done)' });
    const source = fakeSource();

    await expect(cancelJob(job, { client: new ControlClient(path), source })).rejects.toThrow('job déjà terminé (done)');
    expect(source.removed).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('réponse illisible du daemon : l’erreur remonte, pas de repli sur le label', async () => {
    // Lit la requête avant de répondre : une socket dont l'entrée n'est jamais consommée ne se ferme pas, et close() attendrait.
    server = createServer((socket) => socket.once('data', () => socket.end('???\n')));
    const s = server;
    await new Promise<void>((resolve) => s.listen(path, resolve));
    const source = fakeSource();

    await expect(cancelJob(job, { client: new ControlClient(path), source })).rejects.toThrow(/réponse illisible/);
    expect(source.removed).toEqual([]);
  });

  it('daemon injoignable : retire le label et prévient que l’annulation viendra plus tard', async () => {
    const source = fakeSource();

    await cancelJob(job, { client: new ControlClient(path), source }); // aucune socket à ce chemin

    expect(source.removed).toMatchObject([{ repo: { full: 'acme/demo' }, number: 7 }]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('Label retiré sur acme/demo#7');
  });
});
