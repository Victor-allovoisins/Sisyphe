import { execa } from 'execa';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const TEST_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
};

/** Crée un repo source avec un commit, puis un clone bare qui sert de remote. */
export async function createRemoteRepo(
  root: string,
  files: Record<string, string>,
  branch = 'main',
): Promise<{ remotePath: string; headSha: string }> {
  const src = join(root, 'src-repo');
  await mkdir(src, { recursive: true });
  const git = (args: string[]) => execa('git', args, { cwd: src, env: TEST_ENV });
  await git(['init', '-q', '-b', branch]);
  await writeFiles(src, files);
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'init']);
  const headSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const remotePath = join(root, 'remote.git');
  await execa('git', ['clone', '-q', '--bare', src, remotePath], { env: TEST_ENV });
  return { remotePath, headSha };
}

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [p, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), content);
  }
}

export async function remoteBranchSha(remotePath: string, branch: string): Promise<string | null> {
  const r = await execa('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: remotePath, reject: false });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function remoteCommitParents(remotePath: string, sha: string): Promise<string[]> {
  const r = await execa('git', ['rev-list', '--parents', '-n', '1', sha], { cwd: remotePath });
  return r.stdout.trim().split(' ').slice(1);
}

export async function remoteCommitTree(remotePath: string, sha: string): Promise<string> {
  const r = await execa('git', ['rev-parse', `${sha}^{tree}`], { cwd: remotePath });
  return r.stdout.trim();
}

export async function remoteCommitMessage(remotePath: string, sha: string): Promise<string> {
  const r = await execa('git', ['log', '-1', '--format=%B', sha], { cwd: remotePath });
  return r.stdout.trim();
}
