import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return resolve(p);
}

export function repoKey(repo: string): string {
  return repo.replace('/', '__');
}

export interface DataPaths {
  root: string;
  dbPath: string;
  configPath: string;
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
    configPath: join(root, 'config.yml'),
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

export async function ensureDataDirs(p: DataPaths): Promise<void> {
  for (const d of [p.root, p.mirrorsDir, p.workDir, p.cacheDir, p.jobsDir, p.logsDir]) {
    await mkdir(d, { recursive: true });
  }
}

/** Racine des données : SISYPHE_HOME si défini, sinon ~/.sisyphe. */
export function defaultDataDir(): string {
  return process.env.SISYPHE_HOME ?? '~/.sisyphe';
}
