import { execa } from 'execa';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRemoteRepo, remoteBranchSha, remoteCommitMessage, remoteCommitParents } from '../../test/helpers/git-fixture.js';
import { dataPaths, mirrorPath, type DataPaths } from '../config/paths.js';
import { Git, redact } from './git.js';

describe('Git', () => {
  let root: string;
  let paths: DataPaths;
  let remotePath: string;
  let headSha: string;
  let git: Git;
  const repo = 'acme/demo';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sisyphe-git-'));
    paths = dataPaths(join(root, 'data'));
    ({ remotePath, headSha } = await createRemoteRepo(root, { 'README.md': '# demo\n', 'sisyphe.yml': 'baseBranch: main\ncommands:\n  build: true\n' }));
    git = new Git(paths);
  });

  it('crée un miroir puis le rafraîchit', async () => {
    const mirror = await git.ensureMirror(repo, remotePath, remotePath, ['main']);
    expect((await stat(mirror)).isDirectory()).toBe(true);
    await expect(git.ensureMirror(repo, remotePath, remotePath, ['main'])).resolves.toBe(mirror);
  });

  it('rafraîchit la base sans toucher une branche extraite dans un worktree', async () => {
    await git.ensureMirror(repo, remotePath, remotePath, ['main']);
    const { worktreePath } = await git.createWorktree(repo, 7, 'feature/issue-7-x', 'main');
    await writeFile(join(worktreePath, 'x.txt'), 'x\n');
    await git.squashCommit(worktreePath, headSha, 'feat(#7): x');
    await git.push(worktreePath, remotePath, 'feature/issue-7-x');
    // La branche du job avance côté remote pendant que son worktree existe encore.
    const other = join(root, 'other');
    await execa('git', ['clone', '-q', remotePath, other]);
    await execa('git', ['checkout', '-q', 'feature/issue-7-x'], { cwd: other });
    await writeFile(join(other, 'y.txt'), 'y\n');
    await execa('git', ['add', '-A'], { cwd: other });
    await execa('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', 'commit', '-q', '-m', 'more'], { cwd: other });
    await execa('git', ['push', '-q', 'origin', 'feature/issue-7-x'], { cwd: other });
    await expect(git.ensureMirror(repo, remotePath, remotePath, ['main'])).resolves.toBe(mirrorPath(paths, repo));
  });

  it('lit un fichier à une ref', async () => {
    await git.ensureMirror(repo, remotePath, remotePath, ['main']);
    expect(await git.readFileAtRef(repo, 'main', 'sisyphe.yml')).toContain('baseBranch: main');
    expect(await git.readFileAtRef(repo, 'main', 'absent.yml')).toBeNull();
  });

  it('crée un worktree sur la base, détecte les changements, squash et push', async () => {
    await git.ensureMirror(repo, remotePath, remotePath, ['main']);
    const { worktreePath, baseSha } = await git.createWorktree(repo, 7, 'feature/issue-7-x', 'main');
    expect(baseSha).toBe(headSha);
    expect(await git.hasChanges(worktreePath, baseSha)).toBe(false);

    await writeFile(join(worktreePath, 'src.txt'), 'hello\n');
    await writeFile(join(worktreePath, 'README.md'), '# demo\nplus\n');
    expect(await git.hasChanges(worktreePath, baseSha)).toBe(true);
    const stat1 = await git.diffStat(worktreePath, baseSha);
    expect(stat1.files.sort()).toEqual(['README.md', 'src.txt']);
    expect(stat1.changedLines).toBe(2);

    const patch = join(root, 'diff.patch');
    await git.writePatch(worktreePath, baseSha, patch);
    expect(await readFile(patch, 'utf8')).toContain('+hello');

    const sha = await git.squashCommit(worktreePath, baseSha, 'feat(#7): x\n\nCloses #7');
    await git.push(worktreePath, remotePath, 'feature/issue-7-x');
    expect(await remoteBranchSha(remotePath, 'feature/issue-7-x')).toBe(sha);
    expect(await remoteCommitParents(remotePath, sha)).toEqual([headSha]);
    expect(await remoteCommitMessage(remotePath, sha)).toContain('Closes #7');
  });

  it('recrée un worktree existant depuis la base', async () => {
    await git.ensureMirror(repo, remotePath, remotePath, ['main']);
    const first = await git.createWorktree(repo, 7, 'feature/issue-7-x', 'main');
    await writeFile(join(first.worktreePath, 'junk.txt'), 'x');
    const second = await git.createWorktree(repo, 7, 'feature/issue-7-x', 'main');
    expect(second.worktreePath).toBe(first.worktreePath);
    await expect(stat(join(second.worktreePath, 'junk.txt'))).rejects.toThrow();
  });

  it('supprime un worktree', async () => {
    await git.ensureMirror(repo, remotePath, remotePath, ['main']);
    const { worktreePath } = await git.createWorktree(repo, 7, 'feature/issue-7-x', 'main');
    await git.removeWorktree(repo, worktreePath, 'feature/issue-7-x');
    await expect(stat(worktreePath)).rejects.toThrow();
  });

  it('masque les tokens dans les sorties', () => {
    expect(redact('fatal: https://x-access-token:ghs_abc@github.com/a/b')).toBe('fatal: https://x-access-token:***@github.com/a/b');
  });
});
