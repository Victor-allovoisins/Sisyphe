import { execa } from 'execa';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, sep } from 'node:path';
import { mirrorPath, worktreePath as worktreePathFor, type DataPaths } from '../config/paths.js';
import { isValidBranchName } from '../jobs/slug.js';

export class GitError extends Error {
  constructor(message: string, public readonly command: string, public readonly output: string) {
    super(output ? `${message}\n${output}` : message);
    this.name = 'GitError';
  }
}

export interface DiffStat {
  files: string[];
  changedLines: number;
}

export const SISYPHE_AUTHOR = { name: 'Sisyphe', email: 'sisyphe[bot]@users.noreply.github.com' };

/** Namespace du miroir où vivent les branches de base : jamais extraites dans un worktree, donc toujours rafraîchissables. */
export const BASE_REF_PREFIX = 'refs/sisyphe/base/';

/**
 * Environnement hermétique : ni config globale ni système (gpgsign, hooks, insteadOf, credential helper), pas de prompt.
 * LC_ALL=C : messages git en anglais, stables pour le matching.
 */
const GIT_ENV = {
  LC_ALL: 'C',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: SISYPHE_AUTHOR.name,
  GIT_AUTHOR_EMAIL: SISYPHE_AUTHOR.email,
  GIT_COMMITTER_NAME: SISYPHE_AUTHOR.name,
  GIT_COMMITTER_EMAIL: SISYPHE_AUTHOR.email,
};

const MAX_OUTPUT = 2000;

/** Masque tout userinfo d'URL (`//user:secret@`) et les tokens GitHub nus. */
export function redact(text: string): string {
  return text
    .replace(/\/\/[^/@\s]+:[^@\s]+@/g, '//***:***@')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh*_***');
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

interface ExecOutcome {
  exitCode?: number;
  all?: string;
  stderr?: string;
  message?: string;
}

export class Git {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly paths: DataPaths) {}

  private exec(args: string[], cwd?: string) {
    return execa('git', args, { cwd, env: GIT_ENV, reject: false, all: true });
  }

  private fail(args: string[], result: ExecOutcome): GitError {
    const detail = redact((result.all || result.stderr || result.message || '').slice(-MAX_OUTPUT));
    return new GitError(`git ${args[0]} a échoué (code ${result.exitCode ?? 'spawn'})`, redact(`git ${args.join(' ')}`), detail);
  }

  private async run(args: string[], cwd?: string): Promise<string> {
    const result = await this.exec(args, cwd);
    if (result.exitCode !== 0) throw this.fail(args, result);
    return result.stdout.trim();
  }

  /** Sérialise les opérations sur le miroir d'un repo : plusieurs jobs peuvent viser le même repo. */
  private withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repo) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(repo, next);
    return next;
  }

  private assertBranchName(name: string): void {
    if (!isValidBranchName(name)) throw new GitError(`Nom de branche invalide : ${name}`, 'check-ref-format', '');
  }

  /**
   * Crée le miroir bare la première fois (`init` + remote public, pour l'identification seulement), puis
   * rafraîchit les branches demandées dans `refs/sisyphe/base/<b>`. Ce namespace n'est jamais extrait
   * dans un worktree, donc git ne refuse jamais la mise à jour, et un agent ne peut pas le déplacer.
   * L'URL avec token ne passe que sur la ligne de commande du fetch : `--no-write-fetch-head` et reflogs
   * désactivés, rien n'atterrit sur le disque.
   */
  async ensureMirror(repo: string, fetchUrl: string, publicUrl: string, branches: string[]): Promise<string> {
    return this.withRepoLock(repo, async () => {
      const dir = mirrorPath(this.paths, repo);
      if (!(await exists(dir))) {
        await mkdir(dirname(dir), { recursive: true });
        await this.run(['init', '-q', '--bare', dir]);
        await this.run(['remote', 'add', 'origin', publicUrl], dir);
        await this.run(['config', 'core.logAllRefUpdates', 'false'], dir);
      }
      const wanted = [...new Set(branches)];
      for (const b of wanted) this.assertBranchName(b);
      if (wanted.length > 0) {
        const refspecs = wanted.map((b) => `+refs/heads/${b}:${BASE_REF_PREFIX}${b}`);
        await this.run(['fetch', '-q', '--force', '--no-write-fetch-head', fetchUrl, ...refspecs], dir);
      }
      return dir;
    });
  }

  /**
   * La branche existe-t-elle sur le distant ? Interrogé sans rien rapatrier (`ls-remote`), parce que la
   * question se pose avant de savoir sur quoi brancher : `ensureMirror` échouerait sur une branche absente.
   */
  async remoteBranchExists(fetchUrl: string, branch: string): Promise<boolean> {
    this.assertBranchName(branch);
    const r = await this.exec(['ls-remote', '--heads', '--exit-code', fetchUrl, `refs/heads/${branch}`]);
    // 2 : aucune ref ne correspond, c'est une réponse, pas une panne. Tout autre code non nul en est une.
    if (r.exitCode === 2) return false;
    if (r.exitCode !== 0) throw this.fail(['ls-remote', '--heads', branch], r);
    return true;
  }

  /** Contenu d'un fichier sur une branche de base rafraîchie ; null si le fichier n'y existe pas ; erreur si la branche n'a pas été rafraîchie. */
  async readFileAtRef(repo: string, branch: string, path: string): Promise<string | null> {
    this.assertBranchName(branch);
    const result = await this.exec(['show', `${BASE_REF_PREFIX}${branch}:${path}`], mirrorPath(this.paths, repo));
    if (result.exitCode === 0) return result.stdout;
    if (/does not exist in/.test(result.all ?? '')) return null;
    throw this.fail(['show'], result);
  }

  /** Worktree neuf sur la base ; un worktree ou une branche laissés par un job précédent sont d'abord nettoyés. */
  async createWorktree(repo: string, issueNumber: number, branch: string, baseBranch: string): Promise<{ worktreePath: string; baseSha: string }> {
    this.assertBranchName(branch);
    this.assertBranchName(baseBranch);
    const mirror = mirrorPath(this.paths, repo);
    const wt = worktreePathFor(this.paths, repo, issueNumber);
    await this.removeWorktree(repo, wt, branch); // prune inclus : un dossier disparu ne bloque plus la branche
    await mkdir(dirname(wt), { recursive: true });
    const baseSha = await this.run(['rev-parse', '--verify', `${BASE_REF_PREFIX}${baseBranch}^{commit}`], mirror);
    await this.run(['worktree', 'add', '-q', '-B', branch, wt, baseSha], mirror);
    return { worktreePath: wt, baseSha };
  }

  async removeWorktree(repo: string, wt: string, branch?: string): Promise<void> {
    if (!wt.startsWith(this.paths.workDir + sep)) throw new GitError(`Refus de supprimer hors de workDir : ${wt}`, 'removeWorktree', '');
    const mirror = mirrorPath(this.paths, repo);
    await this.exec(['worktree', 'remove', '--force', wt], mirror);
    await rm(wt, { recursive: true, force: true });
    await this.exec(['worktree', 'prune'], mirror);
    if (branch) await this.exec(['branch', '-D', branch], mirror);
  }

  /**
   * `git add -A`, puis refus d'un dépôt git imbriqué ajouté par l'agent (gitlink 160000) : la PR porterait un
   * sous-module pointant nulle part. À appeler une fois, avant `diffStat`/`writePatch`/`writeTree`.
   */
  async stage(wt: string, baseSha: string): Promise<void> {
    await this.run(['add', '-A'], wt);
    const raw = await this.run(['diff', '--cached', '--raw', '--no-renames', baseSha], wt);
    const nested = raw
      .split('\n')
      .filter((l) => /^:\d{6} 160000 /.test(l) && !l.startsWith(':160000 160000 '))
      .map((l) => l.split('\t')[1]);
    if (nested.length > 0) throw new GitError(`Dépôt git imbriqué ajouté par l'agent : ${nested.join(', ')}`, 'git diff --cached --raw', '');
  }

  async diffStat(wt: string, baseSha: string): Promise<DiffStat> {
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

  /** Patch binaire écrit octet pour octet dans `outFile` (pas de décodage UTF-8, saut de ligne final conservé). */
  async writePatch(wt: string, baseSha: string, outFile: string): Promise<void> {
    const args = ['diff', '--cached', '--binary', '--no-renames', baseSha];
    const result = await execa('git', args, { cwd: wt, env: GIT_ENV, reject: false, stdout: { file: outFile }, stderr: 'pipe' });
    if (result.exitCode !== 0) throw this.fail(args, { exitCode: result.exitCode, stderr: result.stderr, message: result.message });
  }

  /** Arbre exact de l'index après `stage` : c'est cet objet, et lui seul, que la livraison commite. */
  async writeTree(wt: string): Promise<string> {
    return this.run(['write-tree'], wt);
  }

  /**
   * Commit unique de `treeSha` sur `baseSha`, posé sur la branche du job et sur HEAD, quel que soit
   * l'état où l'agent a laissé le worktree : ce que la vérification a vu est ce qui part.
   */
  async commitTree(wt: string, branch: string, treeSha: string, baseSha: string, message: string): Promise<string> {
    this.assertBranchName(branch);
    const sha = await this.run(['commit-tree', treeSha, '-p', baseSha, '-m', message], wt);
    await this.run(['update-ref', `refs/heads/${branch}`, sha], wt);
    await this.run(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], wt);
    return sha;
  }

  async push(wt: string, pushUrl: string, branch: string, sha = 'HEAD'): Promise<void> {
    this.assertBranchName(branch);
    if (!/^(HEAD|[0-9a-f]{40})$/.test(sha)) throw new GitError(`Sha invalide : ${sha}`, 'push', '');
    await this.run(['push', '-q', '--force', pushUrl, `${sha}:refs/heads/${branch}`], wt);
  }

  /** Fichiers suivis dont le contenu du worktree diffère de `treeSha`. Ne touche pas l'index. */
  async modifiedTrackedSince(wt: string, treeSha: string): Promise<string[]> {
    if (!/^[0-9a-f]{40}$/.test(treeSha)) throw new GitError(`Arbre invalide : ${treeSha}`, 'diff', '');
    const out = await this.run(['diff', '--name-only', '--no-renames', treeSha, '--'], wt);
    return out.split('\n').filter(Boolean);
  }
}
