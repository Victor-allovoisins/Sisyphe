import { execa } from 'execa';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_ENV, createRemoteRepo, remoteBranchSha, remoteCommitMessage, remoteCommitParents } from '../../test/helpers/git-fixture.js';
import { dataPaths, mirrorPath, type DataPaths } from '../config/paths.js';
import { BASE_REF_PREFIX, Git, GitError, redact } from './git.js';

const PUBLIC_URL = 'https://github.com/acme/demo.git';
const BRANCH = 'feature/issue-7-x';
const repo = 'acme/demo';

describe('Git', () => {
  let root: string;
  let paths: DataPaths;
  let remotePath: string;
  let headSha: string;
  let git: Git;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sisyphe-git-'));
    paths = dataPaths(join(root, 'data'));
    ({ remotePath, headSha } = await createRemoteRepo(root, { 'README.md': '# demo\n', 'sisyphe.yml': 'baseBranch: main\ncommands:\n  build: "true"\n' }));
    git = new Git(paths);
    await git.ensureMirror(repo, remotePath, PUBLIC_URL, ['main']);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Un clone tiers fait avancer une branche côté remote. */
  async function pushFromElsewhere(branch: string, file: string): Promise<void> {
    const other = await mkdtemp(join(root, 'other-'));
    const g = (args: string[]) => execa('git', args, { cwd: other, env: TEST_ENV });
    await execa('git', ['clone', '-q', remotePath, other], { env: TEST_ENV });
    await g(['checkout', '-q', branch]);
    await writeFile(join(other, file), 'more\n');
    await g(['add', '-A']);
    await g(['commit', '-q', '-m', 'more']);
    await g(['push', '-q', 'origin', branch]);
  }

  it('crée le miroir sans jamais stocker l’URL de fetch et rafraîchit la base dans son namespace', async () => {
    const mirror = mirrorPath(paths, repo);
    const config = await readFile(join(mirror, 'config'), 'utf8');
    expect(config).toContain(PUBLIC_URL);
    expect(config).not.toContain(remotePath);
    expect(config.toLowerCase()).toContain('logallrefupdates = false');
    await expect(stat(join(mirror, 'FETCH_HEAD'))).rejects.toThrow();
    await pushFromElsewhere('main', 'z.txt');
    await git.ensureMirror(repo, remotePath, PUBLIC_URL, ['main']);
    const sha = (await execa('git', ['rev-parse', `${BASE_REF_PREFIX}main`], { cwd: mirror, env: TEST_ENV })).stdout.trim();
    expect(sha).toBe(await remoteBranchSha(remotePath, 'main'));
    await expect(stat(join(mirror, 'FETCH_HEAD'))).rejects.toThrow();
  });

  it('lit un fichier sur la base et distingue fichier absent et branche non rafraîchie', async () => {
    expect(await git.readFileAtRef(repo, 'main', 'sisyphe.yml')).toContain('baseBranch: main');
    expect(await git.readFileAtRef(repo, 'main', 'absent.yml')).toBeNull();
    await expect(git.readFileAtRef(repo, 'nope', 'sisyphe.yml')).rejects.toBeInstanceOf(GitError);
  });

  it('worktree sur la base, détection des changements, patch applicable, squash et push', async () => {
    const { worktreePath, baseSha } = await git.createWorktree(repo, 7, BRANCH, 'main');
    expect(baseSha).toBe(headSha);
    expect(await git.hasChanges(worktreePath, baseSha)).toBe(false);

    await writeFile(join(worktreePath, 'src.txt'), 'hello\n');
    await writeFile(join(worktreePath, 'README.md'), '# demo\nplus\n');
    await writeFile(join(worktreePath, 'bin.dat'), Buffer.from([0, 1, 2, 255]));
    expect(await git.hasChanges(worktreePath, baseSha)).toBe(true);
    const st = await git.diffStat(worktreePath, baseSha);
    expect(st.files.sort()).toEqual(['README.md', 'bin.dat', 'src.txt']);
    expect(st.changedLines).toBe(2);

    const patch = join(root, 'diff.patch');
    await git.writePatch(worktreePath, baseSha, patch);
    expect(await readFile(patch, 'utf8')).toContain('+hello');
    const clean = join(root, 'clean');
    await execa('git', ['clone', '-q', remotePath, clean], { env: TEST_ENV });
    const check = await execa('git', ['apply', '--check', patch], { cwd: clean, env: TEST_ENV, reject: false });
    expect(check.exitCode, check.stderr).toBe(0);

    const sha = await git.squashCommit(worktreePath, BRANCH, baseSha, 'feat(#7): x\n\nCloses #7');
    await git.push(worktreePath, remotePath, BRANCH);
    expect(await remoteBranchSha(remotePath, BRANCH)).toBe(sha);
    expect(await remoteCommitParents(remotePath, sha)).toEqual([headSha]);
    expect(await remoteCommitMessage(remotePath, sha)).toContain('Closes #7');
  });

  it('recrée un worktree existant depuis la base', async () => {
    const first = await git.createWorktree(repo, 7, BRANCH, 'main');
    await writeFile(join(first.worktreePath, 'junk.txt'), 'x');
    const second = await git.createWorktree(repo, 7, BRANCH, 'main');
    expect(second.worktreePath).toBe(first.worktreePath);
    await expect(stat(join(second.worktreePath, 'junk.txt'))).rejects.toThrow();
  });

  it('supprime un worktree et refuse un chemin hors workDir', async () => {
    const { worktreePath } = await git.createWorktree(repo, 7, BRANCH, 'main');
    await expect(git.removeWorktree(repo, '/tmp/ailleurs')).rejects.toBeInstanceOf(GitError);
    await git.removeWorktree(repo, worktreePath, BRANCH);
    await expect(stat(worktreePath)).rejects.toThrow();
  });

  it('masque les secrets, y compris dans un push qui échoue', async () => {
    expect(redact('fatal: https://x-access-token:ghs_abc@github.com/a/b')).toBe('fatal: https://***:***@github.com/a/b');
    expect(redact('token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')).toBe('token gh*_***');
    const { worktreePath, baseSha } = await git.createWorktree(repo, 7, BRANCH, 'main');
    await writeFile(join(worktreePath, 'x.txt'), 'x\n');
    await git.squashCommit(worktreePath, BRANCH, baseSha, 'x');
    const err = await git.push(worktreePath, 'https://x-access-token:SUPERSECRET@127.0.0.1:1/x.git', BRANCH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as Error).message).not.toContain('SUPERSECRET');
    expect((err as GitError).command).not.toContain('SUPERSECRET');
  });

  describe('worktree hostile', () => {
    it('squash des commits de l’agent depuis un HEAD détaché sur une autre branche, base intacte', async () => {
      const { worktreePath, baseSha } = await git.createWorktree(repo, 7, BRANCH, 'main');
      const g = (args: string[]) => execa('git', args, { cwd: worktreePath, env: TEST_ENV });
      await writeFile(join(worktreePath, 'a.txt'), 'a\n');
      await g(['add', '-A']);
      await g(['commit', '-q', '-m', 'agent 1']);
      await writeFile(join(worktreePath, 'b.txt'), 'b\n');
      await g(['add', '-A']);
      await g(['commit', '-q', '-m', 'agent 2']);
      await g(['checkout', '-q', '-b', 'agent-side-branch']);
      await g(['checkout', '-q', '--detach']);

      const sha = await git.squashCommit(worktreePath, BRANCH, baseSha, 'feat(#7): squash');
      const parents = (await g(['rev-list', '--parents', '-n', '1', sha])).stdout.trim().split(' ').slice(1);
      expect(parents).toEqual([baseSha]);
      expect((await g(['symbolic-ref', 'HEAD'])).stdout.trim()).toBe(`refs/heads/${BRANCH}`);
      await git.push(worktreePath, remotePath, BRANCH);
      expect(await remoteBranchSha(remotePath, BRANCH)).toBe(sha);
      await expect(git.ensureMirror(repo, remotePath, PUBLIC_URL, ['main'])).resolves.toBe(mirrorPath(paths, repo));
    });

    it('refuse un dépôt git imbriqué ajouté par l’agent', async () => {
      const { worktreePath, baseSha } = await git.createWorktree(repo, 7, BRANCH, 'main');
      const nested = join(worktreePath, 'vendor', 'thing');
      await execa('git', ['init', '-q', nested], { env: TEST_ENV });
      await writeFile(join(nested, 'f'), 'f\n');
      await execa('git', ['add', '-A'], { cwd: nested, env: TEST_ENV });
      await execa('git', ['commit', '-q', '-m', 'n'], { cwd: nested, env: TEST_ENV });
      await expect(git.hasChanges(worktreePath, baseSha)).rejects.toThrow(/imbriqué/);
    });

    it('recrée un worktree dont le dossier a disparu derrière le dos de git', async () => {
      const first = await git.createWorktree(repo, 7, BRANCH, 'main');
      await rm(first.worktreePath, { recursive: true, force: true });
      const second = await git.createWorktree(repo, 7, BRANCH, 'main');
      expect(second.worktreePath).toBe(first.worktreePath);
      expect(await git.hasChanges(second.worktreePath, second.baseSha)).toBe(false);
    });

    it('rafraîchit la base alors qu’un worktree de job existe et que sa branche a avancé côté remote', async () => {
      const { worktreePath, baseSha } = await git.createWorktree(repo, 7, BRANCH, 'main');
      await writeFile(join(worktreePath, 'x.txt'), 'x\n');
      await git.squashCommit(worktreePath, BRANCH, baseSha, 'feat(#7): x');
      await git.push(worktreePath, remotePath, BRANCH);
      await pushFromElsewhere(BRANCH, 'y.txt');
      await pushFromElsewhere('main', 'z.txt');
      await expect(git.ensureMirror(repo, remotePath, PUBLIC_URL, ['main'])).resolves.toBe(mirrorPath(paths, repo));
    });
  });
});
