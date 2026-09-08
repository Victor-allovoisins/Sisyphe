import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return resolve(p);
}

/** `owner/repo` → `owner__repo`. Un seul segment de chemin par construction, quel que soit l'input. */
export function repoKey(repo: string): string {
  return repo.replaceAll('/', '__');
}

export interface DataPaths {
  root: string;
  dbPath: string;
  mirrorsDir: string;
  workDir: string;
  cacheDir: string;
  jobsDir: string;
  logsDir: string;
}

export function dataPaths(dataDir: string): DataPaths {
  const root = expandHome(dataDir);
  return {
    root,
    dbPath: join(root, 'sisyphe.db'),
    mirrorsDir: join(root, 'mirrors'),
    workDir: join(root, 'work'),
    cacheDir: join(root, 'cache'),
    jobsDir: join(root, 'jobs'),
    logsDir: join(root, 'logs'),
  };
}

export function mirrorPath(p: DataPaths, repo: string): string {
  return join(p.mirrorsDir, `${repoKey(repo)}.git`);
}

export function worktreePath(p: DataPaths, repo: string, issueNumber: number): string {
  return join(p.workDir, repoKey(repo), `issue-${issueNumber}`);
}

export function repoCachePath(p: DataPaths, repo: string): string {
  return join(p.cacheDir, repoKey(repo));
}

export function jobDir(p: DataPaths, jobId: string): string {
  return join(p.jobsDir, jobId);
}

/** Répertoires en 0700 : la clé privée GitHub et les transcripts de repos privés vivent dessous. Idempotent. */
export async function ensureDataDirs(p: DataPaths): Promise<void> {
  for (const d of [p.root, p.mirrorsDir, p.workDir, p.cacheDir, p.jobsDir, p.logsDir]) {
    await mkdir(d, { recursive: true, mode: 0o700 });
  }
}

/** Racine par défaut : SISYPHE_HOME si définie et non vide (`||`, pas `??`), sinon ~/.sisyphe. */
export function defaultDataDir(): string {
  return process.env.SISYPHE_HOME || '~/.sisyphe';
}

/** La config machine vit toujours sous la racine par défaut, même si `dataDir` pointe ailleurs. */
export function machineConfigPath(): string {
  return join(expandHome(defaultDataDir()), 'config.yml');
}
