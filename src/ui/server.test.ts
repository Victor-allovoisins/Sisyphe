import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { parseMachineConfig } from '../config/machine.js';
import { dataPaths } from '../config/paths.js';
import { ActionStore } from '../store/actions.js';
import { openDatabase } from '../store/db.js';
import { JobStore } from '../store/jobs.js';
import { PhaseStore } from '../store/phases.js';
import { emptyFlags, type JobState } from '../store/types.js';
import { createUiData } from './data.js';
import { startUiServer, type ActionRunner, type UiServer } from './server.js';
import { createSettingsData } from './settings.js';

const PAGE = '<!doctype html><title>Sisyphe test</title>';
/** Contenu de la clé privée factice : il ne doit apparaître dans aucune réponse. */
const KEY_SECRET = 'NE-DOIT-JAMAIS-SORTIR';

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

/** `fetch` impose l'en-tête Host et normalise le chemin ; ces tests-là ont justement besoin de les choisir. */
function rawRequest(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
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
    req.end(opts.body);
  });
}

/** En-têtes anti-CSRF complets ; chaque test qui en retire un vérifie le refus. */
const ACTION_HEADERS: Record<string, string> = { 'content-type': 'application/json', 'x-sisyphe-action': '1' };

interface TestServerOptions {
  port?: number;
  /** Absent : l'interface est en lecture seule et refuse tout POST. */
  actions?: ActionRunner;
  paused?: boolean | null;
  readOnly?: boolean;
}

async function startTestServer(
  opts: TestServerOptions = {},
): Promise<{ server: UiServer; db: DatabaseSync; actions: ActionStore; base: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sisyphe-srv-'));
  const paths = dataPaths(root);
  const db = openDatabase(':memory:');
  const actions = new ActionStore(db);
  const keyPath = join(root, 'app.pem');
  await writeFile(keyPath, `-----BEGIN RSA PRIVATE KEY-----\n${KEY_SECRET}\n-----END RSA PRIVATE KEY-----\n`);
  const configText = `github:\n  appId: 1\n  installationId: 1\n  privateKeyPath: ${keyPath}\nrepos:\n  - acme/demo\ndataDir: ${root}\n`;
  const configPath = join(root, 'config.yml');
  await writeFile(configPath, configText);
  const machine = parseMachineConfig(configText);
  // Données de réglages réelles sur le dossier temporaire ; ni contrôle réel ni sous-process.
  const settings = createSettingsData({
    paths,
    configPath,
    buildChecks: () => [{ name: 'git', run: async () => '2.39.5' }],
    exec: async () => ({ exitCode: 1, stdout: '', stderr: 'absent' }),
  });
  const paused = opts.paused ?? null;
  const data = createUiData({
    store: new JobStore(db),
    phases: new PhaseStore(db),
    paths,
    machine,
    service: { status: async () => ({ kind: 'launchd' as const, installed: true, running: true, pid: 42, enabledAtBoot: true, detail: 'state = running' }) },
    actions,
    // Sonde factice : aucun test n'ouvre la socket de contrôle.
    control: { ping: async () => (paused === null ? null : { pid: 7, paused, running: 0, queued: 0, startedAt: '2026-09-13T08:00:00.000Z', pendingRestart: [] }) },
    readOnly: opts.readOnly ?? false,
  });
  const server = await startUiServer({ data, settings, page: PAGE, port: opts.port ?? 0, intervalMs: 50, actions: opts.actions });
  servers.push(server);
  return { server, db, actions, base: `http://127.0.0.1:${server.port}`, root };
}

/** POST d'action avec les en-têtes complets par défaut ; `headers` les remplace entièrement. */
function postAction(base: string, name: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return fetch(`${base}/api/actions/${name}`, { method: 'POST', headers: init.headers ?? ACTION_HEADERS, body: init.body ?? '{}' });
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
    // `frame-ancestors` et `form-action` ne retombent pas sur `default-src` : les deux sont explicites.
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self'");
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
    expect(body.daemon).toEqual({ running: false, pid: null, paused: null });
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

  it('/api/settings : la configuration telle qu’écrite, les listes de champs et le mode, sans secret', async () => {
    const acting = await startTestServer({ actions: async () => ({ status: 200, body: { ok: true, result: null } }) });
    const readOnly = await startTestServer();

    const { res, body } = await getJson(`${acting.base}/api/settings`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body.config.repos).toEqual(['acme/demo']);
    expect(body.config.github.privateKeyPath).toBe(join(acting.root, 'app.pem'));
    expect(body.dataDir).toBe(acting.root);
    expect(body.hotReloadable).toContain('pollIntervalSeconds');
    expect(body.restartRequired).toContain('repos');
    expect(body.readOnly).toBe(false);
    expect(JSON.stringify(body)).not.toContain(KEY_SECRET);
    expect((await getJson(`${readOnly.base}/api/settings`)).body.readOnly).toBe(true);
  });

  it('/api/diagnostics et /api/disk : forme attendue, sans secret', async () => {
    const { base, root } = await startTestServer();
    await mkdir(join(root, 'cache'), { recursive: true });
    await writeFile(join(root, 'cache', 'blob'), 'x'.repeat(100));

    const diag = await getJson(`${base}/api/diagnostics`);
    expect(diag.res.status).toBe(200);
    expect(diag.body.checks).toEqual([{ name: 'git', status: 'ok', detail: '2.39.5' }]);
    expect(diag.body.versions).toEqual({ sisyphe: null, node: null, claude: null, git: null, gitleaks: null });
    expect(diag.body.paths).toMatchObject({ config: join(root, 'config.yml'), data: root });

    const disk = await getJson(`${base}/api/disk`);
    expect(disk.res.status).toBe(200);
    expect(disk.body.entries.map((e: { name: string }) => e.name)).toEqual(['cache', 'mirrors', 'work', 'logs', 'jobs']);
    expect(disk.body.totalBytes).toBe(100);

    for (const body of [diag.body, disk.body]) expect(JSON.stringify(body)).not.toContain(KEY_SECRET);
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

    await expect(startTestServer({ port: server.port })).rejects.toThrow(/déjà utilisé/);
  });

  it("l'overview publie la pause, la joignabilité, le mode et les dernières actions", async () => {
    const { base, actions } = await startTestServer({ paused: true, readOnly: true });
    actions.record({ action: 'pause', source: 'ui', outcome: 'ok' });

    const { body } = await getJson(`${base}/api/overview`);

    expect(body.daemon.paused).toBe(true);
    expect(body.control).toEqual({ reachable: true });
    expect(body.readOnly).toBe(true);
    expect(body.recentActions).toHaveLength(1);
    expect(body.recentActions[0].action).toBe('pause');
  });
});

describe('POST /api/actions/<nom>', () => {
  /** Contrôleur factice : le serveur n'a pas à savoir ce qu'une action fait, seulement à la router. */
  function recorder(response: { status: number; body: unknown }) {
    const calls: Array<{ name: string; body: unknown }> = [];
    const actions: ActionRunner = async (name, body) => {
      calls.push({ name, body });
      return response as Awaited<ReturnType<ActionRunner>>;
    };
    return { actions, calls };
  }

  it('relaie le nom et le corps au contrôleur, et rend son statut', async () => {
    const { actions, calls } = recorder({ status: 200, body: { ok: true, result: { id: 'abc' } } });
    const { base } = await startTestServer({ actions });

    const res = await postAction(base, 'cancel', { body: JSON.stringify({ jobId: 'abc' }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { id: 'abc' } });
    expect(calls).toEqual([{ name: 'cancel', body: { jobId: 'abc' } }]);
  });

  it('relaie un refus métier en 409 et un daemon injoignable en 502', async () => {
    const refused = await startTestServer({ actions: recorder({ status: 409, body: { error: 'job déjà terminé' } }).actions });
    const unreachable = await startTestServer({ actions: recorder({ status: 502, body: { error: 'daemon injoignable' } }).actions });

    const r409 = await postAction(refused.base, 'cancel', { body: JSON.stringify({ jobId: 'abc' }) });
    expect(r409.status).toBe(409);
    expect(((await r409.json()) as JsonBody).error).toBe('job déjà terminé');

    const r502 = await postAction(unreachable.base, 'poll');
    expect(r502.status).toBe(502);
    expect(((await r502.json()) as JsonBody).error).toBe('daemon injoignable');
  });

  it('sans en-tête anti-CSRF, rien n’atteint le contrôleur', async () => {
    const { actions, calls } = recorder({ status: 200, body: { ok: true, result: null } });
    const { base } = await startTestServer({ actions });

    const sansJeton = await postAction(base, 'poll', { headers: { 'content-type': 'application/json' } });
    expect(sansJeton.status).toBe(403);

    const jetonFaux = await postAction(base, 'poll', { headers: { ...ACTION_HEADERS, 'x-sisyphe-action': '0' } });
    expect(jetonFaux.status).toBe(403);

    const sansType = await postAction(base, 'poll', { headers: { 'x-sisyphe-action': '1' } });
    expect(sansType.status).toBe(403);

    const typeFormulaire = await postAction(base, 'poll', {
      headers: { ...ACTION_HEADERS, 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(typeFormulaire.status).toBe(403);

    expect(calls).toEqual([]);
  });

  it('une Origin étrangère est refusée, une origine locale passe, y compris avec un paramètre de type', async () => {
    const { actions, calls } = recorder({ status: 200, body: { ok: true, result: null } });
    const { base, server } = await startTestServer({ actions });

    const etrangere = await postAction(base, 'poll', { headers: { ...ACTION_HEADERS, origin: 'http://attaquant.example' } });
    expect(etrangere.status).toBe(403);
    expect(((await etrangere.json()) as JsonBody).error).toContain('attaquant.example');

    // Origine locale sur un autre port : c'est une autre application, pas celle-ci.
    const autrePort = await postAction(base, 'poll', { headers: { ...ACTION_HEADERS, origin: `http://127.0.0.1:${server.port + 1}` } });
    expect(autrePort.status).toBe(403);

    // Une page ouverte dans un bac à sable envoie `Origin: null` : ce n'est pas cette interface.
    expect((await postAction(base, 'poll', { headers: { ...ACTION_HEADERS, origin: 'null' } })).status).toBe(403);

    for (const origin of [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`, `http://[::1]:${server.port}`]) {
      expect((await postAction(base, 'poll', { headers: { ...ACTION_HEADERS, origin } })).status, origin).toBe(200);
    }
    // Le vrai navigateur envoie `application/json;charset=UTF-8` : le paramètre ne doit pas gêner.
    const avecCharset = await postAction(base, 'poll', { headers: { ...ACTION_HEADERS, 'content-type': 'application/json;charset=UTF-8' } });
    expect(avecCharset.status).toBe(200);

    expect(calls).toHaveLength(4);
  });

  it('settings et purge-cache : mêmes gardes anti-CSRF que les autres, et refus en lecture seule', async () => {
    const { actions, calls } = recorder({ status: 200, body: { ok: true, result: null } });
    const { base } = await startTestServer({ actions });
    const readOnly = await startTestServer({ readOnly: true });

    for (const name of ['settings', 'purge-cache']) {
      expect((await postAction(base, name, { headers: { 'content-type': 'application/json' } })).status, name).toBe(403);
      expect((await postAction(base, name, { headers: { 'x-sisyphe-action': '1' } })).status, name).toBe(403);
      expect((await postAction(base, name, { headers: { ...ACTION_HEADERS, origin: 'http://attaquant.example' } })).status, name).toBe(403);

      const refused = await postAction(readOnly.base, name);
      expect(refused.status, name).toBe(403);
      expect(((await refused.json()) as JsonBody).error).toContain('lecture seule');
    }
    expect(calls).toEqual([]);
  });

  it('en lecture seule, toute action est refusée en 403', async () => {
    const { base } = await startTestServer({ readOnly: true });

    const res = await postAction(base, 'stop');

    expect(res.status).toBe(403);
    expect(((await res.json()) as JsonBody).error).toContain('lecture seule');
  });

  it('corps illisible → 400, corps trop gros → 413, sans appeler le contrôleur', async () => {
    const { actions, calls } = recorder({ status: 200, body: { ok: true, result: null } });
    const { base } = await startTestServer({ actions });

    const casse = await postAction(base, 'cancel', { body: '{ jobId: ' });
    expect(casse.status).toBe(400);
    expect(((await casse.json()) as JsonBody).error).toContain('JSON');

    const enorme = await postAction(base, 'enqueue', { body: JSON.stringify({ repo: 'a/b'.padEnd(20_000, '!'), issueNumber: 1 }) });
    expect(enorme.status).toBe(413);

    expect(calls).toEqual([]);
  });

  it('corps vide : les actions sans argument passent quand même', async () => {
    const { actions, calls } = recorder({ status: 200, body: { ok: true, result: null } });
    const { base } = await startTestServer({ actions });

    const res = await fetch(`${base}/api/actions/poll`, { method: 'POST', headers: ACTION_HEADERS });

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ name: 'poll', body: {} }]);
  });

  it('un Host étranger est refusé avant tout le reste, même avec les bons en-têtes (DNS rebinding)', async () => {
    const { actions, calls } = recorder({ status: 200, body: { ok: true, result: null } });
    const { server } = await startTestServer({ actions });

    const res = await rawRequest(server.port, '/api/actions/stop', {
      method: 'POST',
      headers: { ...ACTION_HEADERS, host: 'sisyphe.attaquant.example' },
      body: '{}',
    });

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toBe('Hôte non autorisé');
    expect(calls).toEqual([]);
  });

  it('un nom d’action mal encodé répond 400, pas 500', async () => {
    const { actions, calls } = recorder({ status: 200, body: { ok: true, result: null } });
    const { server } = await startTestServer({ actions });

    const res = await rawRequest(server.port, '/api/actions/%zz', {
      method: 'POST',
      headers: { ...ACTION_HEADERS, host: `127.0.0.1:${server.port}` },
      body: '{}',
    });

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toContain('mal encodé');
    expect(calls).toEqual([]);
  });

  it('sur cette route, les autres méthodes restent en 405 avec Allow: GET, POST', async () => {
    const { base, server } = await startTestServer({ actions: recorder({ status: 200, body: { ok: true, result: null } }).actions });

    const put = await fetch(`${base}/api/actions/poll`, { method: 'PUT', headers: ACTION_HEADERS, body: '{}' });
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, POST');

    // GET sur la route des actions : aucune action ne se déclenche, c'est une route inconnue.
    expect((await fetch(`${base}/api/actions/poll`)).status).toBe(404);

    // Ailleurs, POST reste interdit.
    const post = await rawRequest(server.port, '/api/jobs', { method: 'POST' });
    expect(post.status).toBe(405);
  });
});
