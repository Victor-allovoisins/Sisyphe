import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPaths } from '../../config/paths.js';
import { SCHEMA_VERSION, openDatabase } from '../../store/db.js';
import { JobStore } from '../../store/jobs.js';
import { DEFAULT_UI_PORT } from '../../ui/server.js';
import { openUiDatabase, parsePort, startUi, startupMessage, uiCommand } from './ui.js';

/** Port libre au moment du test : `parsePort` refuse 0, qui est pourtant le port éphémère habituel. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const userVersion = (path: string): number => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
};

describe('parsePort', () => {
  it('sans option, le port par défaut', () => {
    expect(parsePort(undefined)).toBe(DEFAULT_UI_PORT);
  });

  it('accepte un entier dans la plage des ports', () => {
    expect(parsePort('7799')).toBe(7799);
  });

  it('refuse ce qui n’est pas un port', () => {
    for (const bad of ['0', '70000', '-1', 'abc', '80.5']) {
      expect(() => parsePort(bad)).toThrow(/Port invalide/);
    }
  });
});

describe('startupMessage', () => {
  it('annonce l’URL, et « lecture seule » seulement avec l’option', () => {
    expect(startupMessage('127.0.0.1', 7777, false)).toBe('Sisyphe UI : http://127.0.0.1:7777');
    expect(startupMessage('127.0.0.1', 7777, true)).toBe('Sisyphe UI (lecture seule) : http://127.0.0.1:7777');
  });
});

describe('openUiDatabase', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sisyphe-uidb-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('base absente : elle est créée et migrée, puis rendue en lecture seule', () => {
    const dbPath = join(dir, 'sisyphe.db');

    const db = openUiDatabase(dbPath);

    expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);
    expect(() => db.exec('CREATE TABLE t (a INTEGER)')).toThrow(); // strictement en lecture
    db.close();
  });

  it('base en retard d’une version : elle est migrée sans perdre les jobs', () => {
    const dbPath = join(dir, 'sisyphe.db');
    // Base v1 authentique : ouverte en v2 puis redescendue en supprimant ce que la migration 2 a ajouté.
    const seed = openDatabase(dbPath);
    const job = new JobStore(seed).create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    seed.exec('DROP TABLE actions');
    seed.exec('PRAGMA user_version = 1');
    seed.close();

    const db = openUiDatabase(dbPath);

    expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);
    expect(new JobStore(db).get(job.id)?.issueTitle).toBe('t');
    db.close();
  });

  it('base déjà à jour : rien à migrer, la lecture fonctionne', () => {
    const dbPath = join(dir, 'sisyphe.db');
    openDatabase(dbPath).close();

    const db = openUiDatabase(dbPath);

    expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);
    expect(new JobStore(db).listActive()).toEqual([]);
    db.close();
  });
});

describe('startUi', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sisyphe-ui-'));
    vi.stubEnv('SISYPHE_HOME', dir);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  const writeConfig = () =>
    writeFile(
      join(dir, 'config.yml'),
      `github:\n  appId: 1\n  installationId: 2\n  privateKeyPath: /dev/null\nrepos:\n  - acme/demo\ndataDir: ${join(dir, 'data')}\n`,
    );

  it('dossier vierge : dossiers de données et base migrée créés, puis le serveur répond', async () => {
    await writeConfig();
    const paths = dataPaths(join(dir, 'data'));

    const ui = await startUi({ port: String(await freePort()) });

    try {
      expect(userVersion(paths.dbPath)).toBe(SCHEMA_VERSION);
      const res = await fetch(`http://${ui.server.host}:${ui.server.port}/`);
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      await ui.close();
    }
  });

  // Câblage seulement : ni launchctl ni socket de contrôle ne sont sollicités (aucun appel à /api/overview).
  it('--read-only : le contrôleur d’actions n’est pas branché, tout POST est refusé', async () => {
    await writeConfig();

    const ui = await startUi({ port: String(await freePort()), readOnly: true });

    try {
      const res = await fetch(`http://${ui.server.host}:${ui.server.port}/api/actions/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sisyphe-action': '1' },
        body: '{}',
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toContain('lecture seule');
    } finally {
      await ui.close();
    }
  });

  it('config absente : erreur renvoyant vers install.sh ou sisyphe setup, sans rien créer', async () => {
    await expect(startUi({})).rejects.toThrow(/install\.sh ou `sisyphe setup`/);
    await expect(uiCommand({})).rejects.toThrow('Config machine absente');
  });
});
