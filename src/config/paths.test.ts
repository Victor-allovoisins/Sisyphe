import { mkdtemp, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  dataPaths,
  defaultDataDir,
  ensureDataDirs,
  expandHome,
  jobDir,
  machineConfigPath,
  mirrorPath,
  repoCachePath,
  repoKey,
  worktreePath,
} from './paths.js';

describe('paths', () => {
  it('développe ~', () => {
    expect(expandHome('~/.sisyphe')).toBe(join(homedir(), '.sisyphe'));
    expect(expandHome('/tmp/x')).toBe('/tmp/x');
  });

  it('dérive une clé de repo sans slash', () => {
    expect(repoKey('ILokYou/ILokYou-iOS')).toBe('ILokYou__ILokYou-iOS');
  });

  it('construit l’arborescence', () => {
    const p = dataPaths('/data');
    expect(p.dbPath).toBe('/data/sisyphe.db');
    expect(mirrorPath(p, 'a/b')).toBe('/data/mirrors/a__b.git');
    expect(worktreePath(p, 'a/b', 12)).toBe('/data/work/a__b/issue-12');
    expect(repoCachePath(p, 'a/b')).toBe('/data/cache/a__b');
    expect(jobDir(p, 'job-1')).toBe('/data/jobs/job-1');
  });

  it('defaultDataDir ignore une variable vide et honore SISYPHE_HOME', () => {
    vi.stubEnv('SISYPHE_HOME', '');
    expect(defaultDataDir()).toBe('~/.sisyphe');
    vi.stubEnv('SISYPHE_HOME', '/tmp/sisyphe-home');
    expect(defaultDataDir()).toBe('/tmp/sisyphe-home');
    expect(machineConfigPath()).toBe('/tmp/sisyphe-home/config.yml');
    vi.unstubAllEnvs();
  });

  it('repoKey ne produit jamais plus d’un segment', () => {
    expect(repoKey('a/b/c')).toBe('a__b__c');
  });

  it('ensureDataDirs crée l’arborescence en 0700 et est idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sisyphe-paths-'));
    const p = dataPaths(join(root, 'data'));
    await ensureDataDirs(p);
    await ensureDataDirs(p);
    const st = await stat(p.mirrorsDir);
    expect(st.isDirectory()).toBe(true);
    expect(st.mode & 0o777).toBe(0o700);
    await rm(root, { recursive: true, force: true });
  });
});
