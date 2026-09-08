import { execa } from 'execa';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mirrorPath, worktreePath as worktreePathFor, type DataPaths } from '../config/paths.js';

export class GitError extends Error {
  constructor(message: string, public readonly command: string, public readonly output: string) {
    super(`${message}\n${output}`);
    this.name = 'GitError';
  }
}

export interface DiffStat {
  files: string[];
  changedLines: number;
}

export const SISYPHE_AUTHOR = { name: 'Sisyphe', email: 'sisyphe[bot]@users.noreply.github.com' };

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: SISYPHE_AUTHOR.name,
  GIT_AUTHOR_EMAIL: SISYPHE_AUTHOR.email,
  GIT_COMMITTER_NAME: SISYPHE_AUTHOR.name,
  GIT_COMMITTER_EMAIL: SISYPHE_AUTHOR.email,
};

export function redact(text: string): string {
  return text.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export class Git {
  constructor(private readonly paths: DataPaths) {}

  private async run(args: string[], cwd?: string): Promise<string> {
    const result = await execa('git', args, { cwd, env: GIT_ENV, reject: false, all: true });
    if (result.exitCode !== 0) {
      throw new GitError(`git ${args[0]} a échoué (code ${result.exitCode})`, redact(`git ${args.join(' ')}`), redact(result.all ?? ''));
    }
    return result.stdout.trim();
  }

  /**
   * Clone --mirror la première fois (aucun worktree n'existe alors), puis ne rafraîchit que les
   * branches demandées : ne jamais toucher une branche extraite dans le worktree d'un job.
   * `publicUrl` est stocké dans le miroir, `fetchUrl` (avec token) ne l'est jamais.
   * `--no-write-fetch-head` évite que l'URL avec token finisse dans `FETCH_HEAD`.
   */
  async ensureMirror(repo: string, fetchUrl: string, publicUrl: string, branches: string[]): Promise<string> {
    const dir = mirrorPath(this.paths, repo);
    if (!(await exists(dir))) {
      await mkdir(dirname(dir), { recursive: true });
      await this.run(['clone', '--mirror', '-q', fetchUrl, dir]);
      await this.run(['remote', 'set-url', 'origin', publicUrl], dir);
    } else if (branches.length > 0) {
      const refspecs = [...new Set(branches)].map((b) => `+refs/heads/${b}:refs/heads/${b}`);
      await this.run(['fetch', '-q', '--force', '--no-write-fetch-head', fetchUrl, ...refspecs], dir);
    }
    return dir;
  }

  async readFileAtRef(repo: string, ref: string, path: string): Promise<string | null> {
    const mirror = mirrorPath(this.paths, repo);
    const result = await execa('git', ['show', `refs/heads/${ref}:${path}`], { cwd: mirror, env: GIT_ENV, reject: false });
    return result.exitCode === 0 ? result.stdout : null;
  }

  async createWorktree(repo: string, issueNumber: number, branch: string, baseBranch: string): Promise<{ worktreePath: string; baseSha: string }> {
    const mirror = mirrorPath(this.paths, repo);
    const wt = worktreePathFor(this.paths, repo, issueNumber);
    if (await exists(wt)) await this.removeWorktree(repo, wt, branch);
    await mkdir(dirname(wt), { recursive: true });
    const baseSha = await this.run(['rev-parse', `refs/heads/${baseBranch}`], mirror);
    await this.run(['worktree', 'add', '-q', '-B', branch, wt, baseSha], mirror);
    return { worktreePath: wt, baseSha };
  }

  async removeWorktree(repo: string, wt: string, branch?: string): Promise<void> {
    const mirror = mirrorPath(this.paths, repo);
    await execa('git', ['worktree', 'remove', '--force', wt], { cwd: mirror, env: GIT_ENV, reject: false });
    await rm(wt, { recursive: true, force: true });
    await execa('git', ['worktree', 'prune'], { cwd: mirror, env: GIT_ENV, reject: false });
    if (branch) await execa('git', ['branch', '-D', branch], { cwd: mirror, env: GIT_ENV, reject: false });
  }

  private async stageAll(wt: string): Promise<void> {
    await this.run(['add', '-A'], wt);
  }

  async hasChanges(wt: string, baseSha: string): Promise<boolean> {
    await this.stageAll(wt);
    return (await this.run(['diff', '--cached', '--name-only', baseSha], wt)).length > 0;
  }

  async diffStat(wt: string, baseSha: string): Promise<DiffStat> {
    await this.stageAll(wt);
    const out = await this.run(['diff', '--cached', '--numstat', '--no-renames', baseSha], wt);
    const files: string[] = [];
    let changedLines = 0;
    for (const line of out.split('\n').filter(Boolean)) {
      const [added, deleted, file] = line.split('\t');
      if (!file) continue;
      files.push(file);
      changedLines += (Number(added) || 0) + (Number(deleted) || 0); // '-' pour les binaires → 0
    }
    return { files, changedLines };
  }

  async writePatch(wt: string, baseSha: string, outFile: string): Promise<void> {
    await this.stageAll(wt);
    const result = await execa('git', ['diff', '--cached', '--binary', '--no-renames', baseSha], { cwd: wt, env: GIT_ENV });
    await writeFile(outFile, result.stdout);
  }

  /** Ramène tout le travail en un seul commit au-dessus de baseSha. */
  async squashCommit(wt: string, baseSha: string, message: string): Promise<string> {
    await this.run(['reset', '-q', '--soft', baseSha], wt);
    await this.stageAll(wt);
    await this.run(['commit', '-q', '--no-verify', '-m', message], wt);
    return this.run(['rev-parse', 'HEAD'], wt);
  }

  async push(wt: string, pushUrl: string, branch: string): Promise<void> {
    await this.run(['push', '-q', '--force', pushUrl, `HEAD:refs/heads/${branch}`], wt);
  }
}
