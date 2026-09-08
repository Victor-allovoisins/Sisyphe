import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger, purgeOldFiles } from './logger.js';

async function readFileEventually(path: string, tries = 20): Promise<string> {
  for (let i = 0; i < tries; i++) {
    try {
      const content = await readFile(path, 'utf8');
      if (content.length > 0) return content;
    } catch {
      // pas encore créé
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`aucun contenu écrit dans ${path}`);
}

describe('createLogger', () => {
  it('écrit une ligne JSON dans logsDir/daemon-YYYY-MM-DD.log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-log-'));
    const day = new Date().toISOString().slice(0, 10);
    const file = join(dir, `daemon-${day}.log`);

    const log = createLogger({ logsDir: dir });
    log.info('hello');

    const content = await readFileEventually(file);
    const firstLine = content.trim().split('\n')[0];
    const parsed = JSON.parse(firstLine) as { msg: string };
    expect(parsed.msg).toBe('hello');
  });

  it('respecte le niveau configuré : un info n’écrit rien si level=warn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-log-'));
    const day = new Date().toISOString().slice(0, 10);
    const file = join(dir, `daemon-${day}.log`);

    const log = createLogger({ logsDir: dir, level: 'warn' });
    log.info('ne doit pas apparaître');
    log.warn('doit apparaître');

    const content = await readFileEventually(file);
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { msg: string };
    expect(parsed.msg).toBe('doit apparaître');
  });

  it('dégrade en stdout si le fichier de log ne peut pas être ouvert', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-log-'));
    const day = new Date().toISOString().slice(0, 10);
    // Un dossier au chemin exact du fichier attendu provoque EISDIR à l'ouverture.
    await mkdir(join(dir, `daemon-${day}.log`));

    let log!: ReturnType<typeof createLogger>;
    expect(() => {
      log = createLogger({ logsDir: dir });
    }).not.toThrow();
    expect(() => log.info('x')).not.toThrow();
  });
});

describe('purgeOldFiles', () => {
  it('supprime les fichiers plus vieux que N jours, garde les récents et les sous-dossiers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-purge-'));
    const oldFile = join(dir, 'old.log');
    const freshFile = join(dir, 'fresh.log');
    const subDir = join(dir, 'sub');
    await writeFile(oldFile, 'x');
    await writeFile(freshFile, 'y');
    await mkdir(subDir);
    const oldTime = new Date(Date.now() - 30 * 86_400_000);
    await utimes(oldFile, oldTime, oldTime);

    await purgeOldFiles(dir, 14);

    const remaining = (await readdir(dir)).sort();
    expect(remaining).toEqual(['fresh.log', 'sub']);
  });

  it('ne rejette pas si le dossier n’existe pas', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-purge-'));
    await expect(purgeOldFiles(join(dir, 'absent'), 14)).resolves.toBeUndefined();
  });
});
