import { execa } from 'execa';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { TEST_ENV, createRemoteRepo, writeFiles } from '../../test/helpers/git-fixture.js';
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
      'build.sh': 'test -f src/feature.txt || { echo "feature manquante" >&2; exit 1; }',
      'test.sh': 'grep -q hello src/feature.txt',
    });
    git = new Git(paths);
    await git.ensureMirror(repo, remotePath, remotePath, ['main']);
    ({ worktreePath, baseSha } = await git.createWorktree(repo, 1, 'feature/issue-1-x', 'main'));
    jobDir = join(root, 'job');
    await writeFiles(jobDir, { '.keep': '' });
  });

  const run = (over: { scan?: ScanFn; cfg?: typeof config; signal?: AbortSignal } = {}) =>
    runVerification({ worktreePath, baseSha, config: over.cfg ?? config, jobDir, env, git, scan: over.scan ?? (async () => []), signal: over.signal });

  it('signale l’absence de changement', async () => {
    const r = await run();
    expect(r.noChanges).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.treeSha).toBeNull();
  });

  it('passe quand build et test sont verts et renvoie l’arbre vérifié', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n' });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.steps.map((s) => [s.name, s.status])).toEqual([['build', 'ok'], ['test', 'ok']]);
    expect(r.files).toEqual(['src/feature.txt']);
    expect(r.flags).toEqual({ protectedPathsTouched: [], largeDiff: false, secretsFound: [] });
    expect(r.driftedFiles).toEqual([]);
  });

  it('signale les fichiers suivis modifiés par la vérification, sans les inclure dans l’arbre livré', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n', 'build.sh': 'echo bumped > lock.txt; test -f src/feature.txt', 'lock.txt': 'v1\n' });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.driftedFiles).toEqual(['lock.txt']);
    const delivered = (await execa('git', ['show', `${r.treeSha}:lock.txt`], { cwd: worktreePath, env: TEST_ENV })).stdout;
    expect(delivered).toBe('v1');
  });

  it('échoue au build avec la fin de la sortie et marque le test non exécuté', async () => {
    await writeFiles(worktreePath, { 'src/other.txt': 'x\n' });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe('build');
    expect(r.failureTail).toContain('feature manquante');
    expect(r.steps.map((s) => [s.name, s.status])).toEqual([['build', 'failed'], ['test', 'skipped']]);
  });

  it('échoue au test, avec un message même sans sortie', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'bye\n' });
    const r = await run();
    expect(r.failedStep).toBe('test');
    expect(r.failureTail).toContain('sans aucune sortie');
  });

  it('pose les flags chemins protégés et gros diff', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n', 'secrets/key.txt': '1\n2\n3\n4\n' });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.flags.protectedPathsTouched).toEqual(['secrets/key.txt']);
    expect(r.flags.largeDiff).toBe(true);
  });

  it('s’arrête avant les commandes si un secret est détecté, avec un délai passé au scan', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n' });
    let seenTimeout = 0;
    const r = await run({ scan: async (_p, _r, opts) => { seenTimeout = opts.timeoutMs; return [{ file: 'src/feature.txt', ruleId: 'aws-access-token', line: 5 }]; } });
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe('secrets');
    expect(r.steps).toEqual([]);
    expect(r.flags.secretsFound).toEqual(['src/feature.txt (aws-access-token)']);
    expect(seenTimeout).toBeGreaterThan(1000);
  });

  it('épuise le budget : étape en timeout, suivantes non exécutées', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n', 'build.sh': 'sleep 5' });
    const cfg = parseRepoConfig(`baseBranch: main\ncommands:\n  build: sh build.sh\n  test: sh test.sh\ntimeouts:\n  verifyMinutes: 0.005\n`);
    const r = await run({ cfg });
    expect(r.failedStep).toBe('build');
    expect(r.steps.map((s) => [s.name, s.status])).toEqual([['build', 'timeout'], ['test', 'skipped']]);
    expect(r.failureTail).toContain('délai');
  });

  it('propage l’annulation', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n', 'build.sh': 'sleep 5' });
    const controller = new AbortController();
    setTimeout(() => controller.abort('cancelled'), 200);
    await expect(run({ signal: controller.signal })).rejects.toBe('cancelled');
  });
});
