import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dataPaths, expandHome, jobDir, mirrorPath, repoCachePath, repoKey, worktreePath } from './paths.js';

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
});
