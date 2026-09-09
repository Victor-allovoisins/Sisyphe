import { request as httpRequest } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { parseMachineConfig } from '../config/machine.js';
import { dataPaths } from '../config/paths.js';
import { openDatabase } from '../store/db.js';
import { JobStore } from '../store/jobs.js';
import { PhaseStore } from '../store/phases.js';
import { emptyFlags, type JobState } from '../store/types.js';
import { createUiData } from './data.js';
import { startUiServer, type UiServer } from './server.js';

const PAGE = '<!doctype html><title>Sisyphe test</title>';

let nextIssueNumber = 1;

function insertJob(db: DatabaseSync, id: string, state: JobState, repo = 'acme/demo'): void {
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO jobs (id, repo, issue_number, issue_title, state, flags_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, repo, nextIssueNumber++, 'Un titre', state, JSON.stringify(emptyFlags()), ts, ts);
}

const servers: UiServer[] = [];

/** Les corps JSON de l'API sont indexés librement dans les assertions : un seul cast permissif, ici. */
type JsonBody = Record<string, any>;

async function getJson(url: string): Promise<{ res: Response; body: JsonBody }> {
  const res = await fetch(url);
  return { res, body: (await res.json()) as JsonBody };
}

/** `fetch` impose l'en-tête Host ; ces tests-là ont justement besoin de le choisir. */
function rawRequest(port: number, path: string, opts: { method?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers ?? { host: `127.0.0.1:${port}` } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function startTestServer(port = 0): Promise<{ server: UiServer; db: DatabaseSync; base: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sisyphe-srv-'));
  const paths = dataPaths(root);
  const db = openDatabase(':memory:');
  const machine = parseMachineConfig(
    `github:\n  appId: 1\n  installationId: 1\n  privateKeyPath: /dev/null\nrepos:\n  - acme/demo\ndataDir: ${root}\n`,
  );
  const data = createUiData({
    store: new JobStore(db),
    phases: new PhaseStore(db),
    paths,
    machine,
    launchd: async () => ({ loaded: true, lastExitCode: 0, detail: 'state = running' }),
  });
  const server = await startUiServer({ data, page: PAGE, port, intervalMs: 50 });
  servers.push(server);
  return { server, db, base: `http://127.0.0.1:${server.port}` };
}

afterEach(async () => {
  while (servers.length) await servers.pop()?.close();
});

describe('startUiServer', () => {
  it('sert la page avec les en-têtes de sécurité', async () => {
    const { base } = await startTestServer();

    const res = await fetch(`${base}/`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe(PAGE);
  });

  it("n'écoute que sur l'interface locale", async () => {
    const { server } = await startTestServer();

    expect(server.host).toBe('127.0.0.1');
  });

  it('/api/overview renvoie le tableau de bord en JSON', async () => {
    const { base, db } = await startTestServer();
    insertJob(db, 'ov1', 'implementing');

    const { res, body } = await getJson(`${base}/api/overview`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(body.daemon).toEqual({ running: false, pid: null });
    expect(body.counts.active).toBe(1);
    expect(body.active[0].id).toBe('ov1');
  });

  it('/api/jobs filtre par état et refuse un état inconnu', async () => {
    const { base, db } = await startTestServer();
    insertJob(db, 'j1', 'done');
    insertJob(db, 'j2', 'failed');

    const done = await getJson(`${base}/api/jobs?state=done`);
    expect(done.body.jobs.map((j: { id: string }) => j.id)).toEqual(['j1']);

    const bad = await getJson(`${base}/api/jobs?state=nawak`);
    expect(bad.res.status).toBe(400);
    expect(bad.body.error).toContain('nawak');

    // Un filtre vide vaut « pas de filtre », comme un paramètre absent.
    const empty = await getJson(`${base}/api/jobs?state=&repo=`);
    expect(empty.res.status).toBe(200);
    expect(empty.body.jobs).toHaveLength(2);
  });

  it('/api/jobs/:id : 200 sur un préfixe, 404 sur un id inconnu, 409 sur un préfixe ambigu', async () => {
    const { base, db } = await startTestServer();
    insertJob(db, 'aaa111', 'done');
    insertJob(db, 'aaa222', 'done');
    insertJob(db, 'bbb333', 'done');

    const ok = await getJson(`${base}/api/jobs/bbb`);
    expect(ok.res.status).toBe(200);
    expect(ok.body.job.id).toBe('bbb333');

    const missing = await getJson(`${base}/api/jobs/zzz`);
    expect(missing.res.status).toBe(404);
    expect(missing.body.error).toContain('zzz');

    const ambiguous = await getJson(`${base}/api/jobs/aaa`);
    expect(ambiguous.res.status).toBe(409);
    expect(ambiguous.body.error).toContain('aaa111');
  });

  it('/api/report accepte une période valide et refuse le reste', async () => {
    const { base } = await startTestServer();

    const ok = await getJson(`${base}/api/report?since=7d`);
    expect(ok.res.status).toBe(200);
    expect(Array.isArray(ok.body.perDay)).toBe(true);

    const bad = await fetch(`${base}/api/report?since=demain`);
    expect(bad.status).toBe(400);
  });

  it('/api/events pousse un premier snapshot en moins d’une seconde', async () => {
    const { base } = await startTestServer();
    const controller = new AbortController();

    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const readSnapshot = async () => {
      let buffer = '';
      while (!buffer.includes('event: snapshot')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('flux SSE fermé sans snapshot');
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      return buffer;
    };
    const first = await Promise.race([
      readSnapshot(),
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('pas de snapshot en 1 s')), 1000)),
    ]);

    expect(first).toContain('retry: 2000');
    expect(first).toContain('event: snapshot');
    expect(first).toContain('"daemon"');
    controller.abort();
  });

  it('close() ferme les connexions SSE ouvertes', async () => {
    const { server, base } = await startTestServer();
    const res = await fetch(`${base}/api/events`);
    const reader = res.body!.getReader();
    await reader.read();

    await server.close();

    // Le flux se termine côté serveur : les lectures suivantes vident ce qui restait puis rendent
    // `done`, elles ne pendent pas indéfiniment.
    const drain = async (): Promise<boolean> => {
      while (!(await reader.read()).done) {
        /* frames déjà en vol côté client */
      }
      return true;
    };
    const done = await Promise.race([
      drain(),
      new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error('flux SSE toujours ouvert')), 2000)),
    ]);
    expect(done).toBe(true);
  });

  it('route inconnue → 404 JSON, méthode non GET → 405', async () => {
    const { base } = await startTestServer();

    const missing = await fetch(`${base}/nawak`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toBe('application/json; charset=utf-8');

    const post = await fetch(`${base}/api/overview`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
  });

  it('refuse un en-tête Host étranger (DNS rebinding) et accepte les noms locaux', async () => {
    const { server } = await startTestServer();

    const foreign = await rawRequest(server.port, '/', { headers: { host: 'sisyphe.attaquant.example' } });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body).error).toBe('Hôte non autorisé');

    expect((await rawRequest(server.port, '/', { headers: { host: `127.0.0.1:${server.port}` } })).status).toBe(200);
    expect((await rawRequest(server.port, '/', { headers: { host: `localhost:${server.port}` } })).status).toBe(200);
    expect((await rawRequest(server.port, '/', { headers: { host: `127.0.0.1:${server.port + 1}` } })).status).toBe(403);
  });

  it('/api/jobs/ sans identifiant répond 404 plutôt que d’énumérer tous les jobs', async () => {
    const { base, db } = await startTestServer();
    insertJob(db, 'e1', 'done');
    insertJob(db, 'e2', 'done');

    const res = await getJson(`${base}/api/jobs/`);

    expect(res.res.status).toBe(404);
    expect(res.body.error).toBe('Job inconnu : (identifiant vide)');
    expect(res.body.error).not.toContain('e1');
  });

  it('un identifiant mal encodé répond 400, pas 500', async () => {
    const { server } = await startTestServer();

    const res = await rawRequest(server.port, '/api/jobs/%');

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe('Identifiant de job mal encodé');
  });

  it('HEAD sur la page renvoie les en-têtes sans corps, une cible non absolue est un 404', async () => {
    const { server } = await startTestServer();

    const head = await rawRequest(server.port, '/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');

    expect((await rawRequest(server.port, '//evil.example')).status).toBe(404);
  });

  it('/favicon.ico répond 204 : le navigateur le demande à chaque chargement', async () => {
    const { base } = await startTestServer();

    expect((await fetch(`${base}/favicon.ico`)).status).toBe(204);
  });

  it('un port déjà pris est refusé avec un message clair', async () => {
    const { server } = await startTestServer();

    await expect(startTestServer(server.port)).rejects.toThrow(/déjà utilisé/);
  });
});
