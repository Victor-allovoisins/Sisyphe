import { App } from '@octokit/app';
import { Octokit } from '@octokit/rest';
import { readFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import { clampForGitHub } from '../deliver/sanitize.js';
import { allStatusLabelNames, labelDefinitions, statusLabelName } from './labels.js';
import { withRetry, type RetryOptions } from './retry.js';
import type {
  Issue, IssueRef, IssueSource, PullRef, PullRequestInput, PullRequestState, RepoRef, StatusLabel, TriggerCheck,
} from './source.js';

export interface GitHubClientConfig {
  appId: number;
  installationId: number;
  privateKey: string;
  triggerLabel: string;
  log?: Logger;
  /** Surcharge des réglages de withRetry (tests : sleep no-op pour ne pas attendre pour de vrai). */
  retry?: Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'sleep'>;
}

export function hasWriteAccess(permission: string | undefined): boolean {
  return permission === 'admin' || permission === 'write' || permission === 'maintain';
}

type LabelEvent = { event: string; label?: { name?: string | null } | null; actor?: { login: string } | null };

export function lastLabeler(events: LabelEvent[], label: string): string | null {
  let login: string | null = null;
  for (const e of events) if (e.event === 'labeled' && e.label?.name === label) login = e.actor?.login ?? null;
  return login;
}

export function labelNames(labels: Array<string | { name?: string | null }>): string[] {
  return labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean);
}

const status = (err: unknown) => (err as { status?: number }).status;

export class GitHubIssueSource implements IssueSource {
  private readonly app: App;
  private octokitPromise: Promise<Octokit> | null = null;
  private readonly defaultBranches = new Map<string, string>();

  constructor(private readonly cfg: GitHubClientConfig) {
    this.app = new App({ appId: cfg.appId, privateKey: cfg.privateKey, Octokit });
  }

  static async fromFiles(cfg: { appId: number; installationId: number; privateKeyPath: string; triggerLabel: string; log?: Logger }): Promise<GitHubIssueSource> {
    return new GitHubIssueSource({ ...cfg, privateKey: await readFile(cfg.privateKeyPath, 'utf8') });
  }

  private octokit(): Promise<Octokit> {
    this.octokitPromise ??= this.app.getInstallationOctokit(this.cfg.installationId) as unknown as Promise<Octokit>;
    return this.octokitPromise;
  }

  private call<T>(fn: (o: Octokit) => Promise<T>, opts?: RetryOptions): Promise<T> {
    // Les options par appel (ex. retryOnError: false) gardent la priorité sur la config globale.
    return withRetry(async () => fn(await this.octokit()), { ...this.cfg.retry, ...opts });
  }

  /** Vérifie l'authentification de l'App et l'accès à l'installation. Utilisé par `doctor`. */
  async checkAccess(): Promise<{ appSlug: string; repos: string[] }> {
    const app = await withRetry(() => this.app.octokit.request('GET /app'));
    const repos = await this.call((o) => o.paginate(o.rest.apps.listReposAccessibleToInstallation, { per_page: 100 }));
    return { appSlug: (app.data as { slug?: string }).slug ?? '?', repos: repos.map((r) => r.full_name) };
  }

  async getFileContent(repo: RepoRef, path: string, ref?: string): Promise<string | null> {
    try {
      const r = await this.call((o) => o.rest.repos.getContent({ owner: repo.owner, repo: repo.name, path, ref }));
      const data = r.data as { type?: string; content?: string; encoding?: string };
      if (data.type !== 'file' || !data.content) return null;
      return Buffer.from(data.content, (data.encoding as BufferEncoding) ?? 'base64').toString('utf8');
    } catch (err) {
      if (status(err) === 404) return null;
      throw err;
    }
  }

  async listCandidates(repo: RepoRef): Promise<IssueRef[]> {
    const statusSet = new Set(allStatusLabelNames(this.cfg.triggerLabel));
    const issues = await this.call((o) =>
      o.paginate(o.rest.issues.listForRepo, { owner: repo.owner, repo: repo.name, state: 'open', labels: this.cfg.triggerLabel, per_page: 100 }),
    );
    return issues
      .filter((i) => !i.pull_request && !labelNames(i.labels).some((l) => statusSet.has(l)))
      .map((i) => ({ repo, number: i.number }));
  }

  async listWithStatus(repo: RepoRef, st: StatusLabel): Promise<IssueRef[]> {
    const issues = await this.call((o) =>
      o.paginate(o.rest.issues.listForRepo, { owner: repo.owner, repo: repo.name, state: 'open', labels: statusLabelName(this.cfg.triggerLabel, st), per_page: 100 }),
    );
    return issues.filter((i) => !i.pull_request).map((i) => ({ repo, number: i.number }));
  }

  async getIssue(ref: IssueRef): Promise<Issue> {
    const base = { owner: ref.repo.owner, repo: ref.repo.name, issue_number: ref.number };
    const [issue, comments] = await Promise.all([
      this.call((o) => o.rest.issues.get(base)),
      this.call((o) => o.paginate(o.rest.issues.listComments, { ...base, per_page: 100 })),
    ]);
    return {
      repo: ref.repo,
      number: ref.number,
      title: issue.data.title,
      body: issue.data.body ?? '',
      author: issue.data.user?.login ?? 'inconnu',
      state: issue.data.state === 'closed' ? 'closed' : 'open',
      labels: labelNames(issue.data.labels),
      comments: comments.map((c) => ({ author: c.user?.login ?? 'inconnu', body: c.body ?? '', createdAt: c.created_at })),
    };
  }

  async canTrigger(ref: IssueRef): Promise<TriggerCheck> {
    const events = await this.call((o) =>
      o.paginate(o.rest.issues.listEvents, { owner: ref.repo.owner, repo: ref.repo.name, issue_number: ref.number, per_page: 100 }),
    );
    let login = lastLabeler(events as unknown as LabelEvent[], this.cfg.triggerLabel);
    // Aucun événement `labeled` retrouvé (historique tronqué, label posé à la création…) : si le label
    // trigger est bien présent, on retombe sur l'auteur de l'issue plutôt que de refuser sans raison.
    if (!login) {
      const issue = await this.call((o) => o.rest.issues.get({ owner: ref.repo.owner, repo: ref.repo.name, issue_number: ref.number }));
      if (labelNames(issue.data.labels).includes(this.cfg.triggerLabel)) login = issue.data.user?.login ?? null;
    }
    if (!login || login.endsWith('[bot]')) return { ok: false, login };
    try {
      const perm = await this.call((o) => o.rest.repos.getCollaboratorPermissionLevel({ owner: ref.repo.owner, repo: ref.repo.name, username: login }));
      return { ok: hasWriteAccess(perm.data.permission), login };
    } catch (err) {
      const s = status(err);
      // Transitoire (réseau, 5xx) : on laisse remonter, poll ignore l'issue et réessaiera au prochain cycle
      // plutôt que de retirer le label et d'accuser à tort. 4xx : refus, jamais d'autorisation sur un doute.
      if (s === undefined || s >= 500) throw err;
      return { ok: false, login };
    }
  }

  private async removeLabel(ref: IssueRef, name: string): Promise<void> {
    try {
      await this.call((o) => o.rest.issues.removeLabel({ owner: ref.repo.owner, repo: ref.repo.name, issue_number: ref.number, name }));
    } catch (err) {
      if (status(err) !== 404) throw err;
    }
  }

  async removeTriggerLabel(ref: IssueRef): Promise<void> {
    await this.removeLabel(ref, this.cfg.triggerLabel);
  }

  /** addLabels est déjà idempotent côté GitHub (label déjà présent → 200 sans effet) : pas de gestion d'erreur particulière. */
  async addTriggerLabel(ref: IssueRef): Promise<void> {
    await this.call((o) => o.rest.issues.addLabels({ owner: ref.repo.owner, repo: ref.repo.name, issue_number: ref.number, labels: [this.cfg.triggerLabel] }));
  }

  async setStatus(ref: IssueRef, st: StatusLabel | null): Promise<void> {
    const issue = await this.call((o) => o.rest.issues.get({ owner: ref.repo.owner, repo: ref.repo.name, issue_number: ref.number }));
    const current = labelNames(issue.data.labels);
    const wanted = st ? statusLabelName(this.cfg.triggerLabel, st) : null;
    for (const name of allStatusLabelNames(this.cfg.triggerLabel)) {
      if (name !== wanted && current.includes(name)) await this.removeLabel(ref, name);
    }
    if (wanted && !current.includes(wanted)) {
      await this.call((o) => o.rest.issues.addLabels({ owner: ref.repo.owner, repo: ref.repo.name, issue_number: ref.number, labels: [wanted] }));
    }
  }

  /**
   * Les corps sont bornés ici, à l'envoi : GitHub refuse au-delà de 65 536 caractères.
   * `retryOnError: false` : un POST qui a abouti puis expiré ne doit pas être rejoué (doublon de commentaire).
   */
  async comment(ref: IssueRef, markdown: string): Promise<void> {
    await this.call(
      (o) => o.rest.issues.createComment({ owner: ref.repo.owner, repo: ref.repo.name, issue_number: ref.number, body: clampForGitHub(markdown) }),
      { retryOnError: false },
    );
  }

  async isStillActive(ref: IssueRef): Promise<boolean> {
    const issue = await this.call((o) => o.rest.issues.get({ owner: ref.repo.owner, repo: ref.repo.name, issue_number: ref.number }));
    return issue.data.state === 'open' && labelNames(issue.data.labels).includes(this.cfg.triggerLabel);
  }

  async getDefaultBranch(repo: RepoRef): Promise<string> {
    const cached = this.defaultBranches.get(repo.full);
    if (cached) return cached;
    const r = await this.call((o) => o.rest.repos.get({ owner: repo.owner, repo: repo.name }));
    this.defaultBranches.set(repo.full, r.data.default_branch);
    return r.data.default_branch;
  }

  async getAuthenticatedRemoteUrl(repo: RepoRef): Promise<string> {
    const auth = await this.call(async (o) => (await o.auth({ type: 'installation' })) as { token: string });
    return `https://x-access-token:${auth.token}@github.com/${repo.full}.git`;
  }

  async openPullRequest(input: PullRequestInput): Promise<PullRef> {
    const { owner, name: repo } = input.repo;
    let pr;
    try {
      // retryOnError: false — un create() qui a abouti puis expiré côté client ne doit pas être rejoué (doublon de PR).
      pr = await this.call(
        (o) => o.rest.pulls.create({ owner, repo, title: input.title, head: input.head, base: input.base, body: clampForGitHub(input.body), draft: input.draft }),
        { retryOnError: false },
      );
    } catch (err) {
      // 422 : GitHub refuse souvent une 2e création faute d'avoir vu la 1re aboutir (retry applicatif, double appel…).
      if (status(err) === 422) {
        try {
          const existing = await this.findPullRequest(input.repo, input.head);
          if (existing) return existing;
        } catch {
          // La recherche de secours a échoué à son tour : on relance le 422 d'origine, pas cette erreur-ci.
        }
      }
      throw err;
    }
    const number = pr.data.number;
    // Après la création, plus rien ne doit pouvoir faire échouer l'opération : la PR existe déjà.
    if (input.labels.length) {
      try {
        await this.call((o) => o.rest.issues.addLabels({ owner, repo, issue_number: number, labels: input.labels }));
      } catch (err) {
        this.cfg.log?.warn({ err, repo: input.repo.full, pr: number }, 'openPullRequest : étape post-création échouée');
      }
    }
    if (input.reviewers.length) {
      try {
        await this.call((o) => o.rest.pulls.requestReviewers({ owner, repo, pull_number: number, reviewers: input.reviewers }));
      } catch (err) {
        this.cfg.log?.warn({ err, repo: input.repo.full, pr: number }, 'openPullRequest : étape post-création échouée');
      }
    }
    return { repo: input.repo, number, url: pr.data.html_url };
  }

  async updatePullRequest(ref: PullRef, patch: { title: string; body: string; draft: boolean; base: string }): Promise<void> {
    const { owner, name: repo } = ref.repo;
    const current = await this.call((o) => o.rest.pulls.get({ owner, repo, pull_number: ref.number }));
    await this.call((o) => o.rest.pulls.update({ owner, repo, pull_number: ref.number, title: patch.title, body: clampForGitHub(patch.body), base: patch.base }));
    if (Boolean(current.data.draft) !== patch.draft) {
      // Le passage draft <-> prêt n'existe qu'en GraphQL.
      const mutation = patch.draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
      await this.call((o) => o.graphql(`mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { clientMutationId } }`, { id: current.data.node_id }));
    }
  }

  async findPullRequest(repo: RepoRef, headBranch: string): Promise<PullRef | null> {
    const list = await this.call((o) => o.rest.pulls.list({ owner: repo.owner, repo: repo.name, state: 'open', head: `${repo.owner}:${headBranch}`, per_page: 1 }));
    const pr = list.data[0];
    return pr ? { repo, number: pr.number, url: pr.html_url } : null;
  }

  async getPullRequestState(ref: PullRef): Promise<PullRequestState> {
    const pr = await this.call((o) => o.rest.pulls.get({ owner: ref.repo.owner, repo: ref.repo.name, pull_number: ref.number }));
    return { state: pr.data.state === 'closed' ? 'closed' : 'open', mergedAt: pr.data.merged_at };
  }

  async ensureLabels(repo: RepoRef): Promise<void> {
    const existing = await this.call((o) => o.paginate(o.rest.issues.listLabelsForRepo, { owner: repo.owner, repo: repo.name, per_page: 100 }));
    const names = new Set(existing.map((l) => l.name));
    for (const def of labelDefinitions(this.cfg.triggerLabel)) {
      if (names.has(def.name)) continue;
      try {
        await this.call((o) => o.rest.issues.createLabel({ owner: repo.owner, repo: repo.name, name: def.name, color: def.color, description: def.description }));
      } catch (err) {
        // 422 : le label existe déjà (créé entre-temps, ou déjà là avec une casse différente) — rien à faire.
        if (status(err) !== 422) throw err;
      }
    }
  }
}
