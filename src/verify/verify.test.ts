import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRemoteRepo, writeFiles } from '../../test/helpers/git-fixture.js';
import { dataPaths, type DataPaths } from '../config/paths.js';
import { parseRepoConfig } from '../config/repo.js';
import { Git } from '../git/git.js';
import { repoEnv } from './commands.js';
import { runVerification, type ScanFn } from './verify.js';

const config = parseRepoConfig(`
baseBranch: main
commands:
  build: sh build.sh
  test: sh test.sh
protectedPaths: ["secrets/**"]
limits:
  maxDiffLines: 3
`);

describe('runVerification', () => {
  let root: string;
  let paths: DataPaths;
  let git: Git;
  let worktreePath: string;
  let baseSha: string;
  let jobDir: string;
  const env = repoEnv({ PATH: process.env.PATH ?? '' }, { cacheDir: '/tmp', issueNumber: 1, branch: 'b' });
  const repo = 'acme/demo';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sisyphe-verify-'));
    paths = dataPaths(join(root, 'data'));
    const { remotePath } = await createRemoteRepo(root, {
      'build.sh': 'test -f src/feature.txt',
      'test.sh': 'grep -q hello src/feature.txt',
    });
    git = new Git(paths);
    await git.ensureMirror(repo, remotePath, remotePath, ['main']);
    ({ worktreePath, baseSha } = await git.createWorktree(repo, 1, 'feature/issue-1-x', 'main'));
    jobDir = join(root, 'job');
    await writeFiles(jobDir, { '.keep': '' });
  });

  const run = (scan: ScanFn = async () => []) => runVerification({ worktreePath, baseSha, config, jobDir, env, git, scan });

  it('signale l’absence de changement', async () => {
    const r = await run();
    expect(r.noChanges).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('passe quand build et test sont verts', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n' });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => [s.name, s.exitCode])).toEqual([['build', 0], ['test', 0]]);
    expect(r.files).toEqual(['src/feature.txt']);
    expect(r.flags.largeDiff).toBe(false);
  });

  it('échoue au build avec la fin de la sortie', async () => {
    await writeFiles(worktreePath, { 'src/other.txt': 'x\n' });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe('build');
    expect(r.steps).toHaveLength(1);
  });

  it('échoue au test', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'bye\n' });
    const r = await run();
    expect(r.failedStep).toBe('test');
    expect(r.steps.map((s) => s.name)).toEqual(['build', 'test']);
  });

  it('pose les flags chemins protégés et gros diff', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n', 'secrets/key.txt': '1\n2\n3\n4\n' });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.flags.protectedPathsTouched).toEqual(['secrets/key.txt']);
    expect(r.flags.largeDiff).toBe(true);
  });

  it('s’arrête avant les commandes si un secret est détecté', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n' });
    const r = await run(async () => [{ file: 'src/feature.txt', ruleId: 'aws-access-token', line: 5 }]);
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe('secrets');
    expect(r.steps).toEqual([]);
    expect(r.flags.secretsFound).toEqual(['src/feature.txt (aws-access-token)']);
  });
});
