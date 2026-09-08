import { allStatusLabelNames, statusLabelName } from '../../src/github/labels.js';
import type {
  Issue, IssueRef, IssueSource, PullRef, PullRequestInput, PullRequestState, RepoRef, StatusLabel, TriggerCheck,
} from '../../src/github/source.js';

export interface FakeIssueInput {
  number: number;
  title: string;
  body?: string;
  author?: string;
  /** Remplace la liste par défaut `[triggerLabel]` : passer `[triggerLabel, ...]` pour la compléter. */
  labels?: string[];
  comments?: Issue['comments'];
  /** null simule l'absence d'événement `labeled` du label trigger ; omis, retombe sur `author`. */
  labeledBy?: string | null;
  state?: 'open' | 'closed';
}

export interface FakePull {
  number: number;
  /** Nom complet du repo (owner/name), pour isoler les PR entre repos homonymes de branche. */
  repo: string;
  url: string;
  title: string;
  head: string;
  base: string;
  body: string;
  draft: boolean;
  labels: string[];
  reviewers: string[];
  state: 'open' | 'closed';
  mergedAt: string | null;
}

type StoredIssue = Issue & { labeledBy: string | null };

export class FakeIssueSource implements IssueSource {
  readonly issues = new Map<string, StoredIssue>();
  readonly comments = new Map<string, string[]>();
  readonly pulls: FakePull[] = [];
  readonly permissions: Record<string, 'admin' | 'write' | 'maintain' | 'read'> = {};
  readonly calls: string[] = [];
  readonly labelsEnsured: string[] = [];
  defaultBranch = 'main';
  remoteUrl = 'file:///dev/null';
  private nextPr = 100;

  constructor(readonly triggerLabel = 'sisyphe') {}

  private key(ref: IssueRef): string {
    return `${ref.repo.full}#${ref.number}`;
  }

  private stored(ref: IssueRef): StoredIssue {
    const i = this.issues.get(this.key(ref));
    if (!i) throw new Error(`Issue inconnue : ${this.key(ref)}`);
    return i;
  }

  addIssue(repo: RepoRef, input: FakeIssueInput): void {
    const author = input.author ?? 'alice';
    this.issues.set(this.key({ repo, number: input.number }), {
      repo, number: input.number, title: input.title, body: input.body ?? '', author,
      state: input.state ?? 'open', labels: input.labels ?? [this.triggerLabel], comments: input.comments ?? [],
      labeledBy: 'labeledBy' in input ? (input.labeledBy ?? null) : author,
    });
  }

  labelsOf(ref: IssueRef): string[] {
    return [...this.stored(ref).labels];
  }

  commentsOf(ref: IssueRef): string[] {
    return this.comments.get(this.key(ref)) ?? [];
  }

  async listCandidates(repo: RepoRef): Promise<IssueRef[]> {
    this.calls.push('listCandidates');
    const status = new Set(allStatusLabelNames(this.triggerLabel));
    return [...this.issues.values()]
      .filter((i) => i.repo.full === repo.full && i.state === 'open' && i.labels.includes(this.triggerLabel) && !i.labels.some((l) => status.has(l)))
      .map((i) => ({ repo, number: i.number }));
  }

  async listWithStatus(repo: RepoRef, status: StatusLabel): Promise<IssueRef[]> {
    const name = statusLabelName(this.triggerLabel, status);
    return [...this.issues.values()].filter((i) => i.repo.full === repo.full && i.labels.includes(name)).map((i) => ({ repo, number: i.number }));
  }

  async getIssue(ref: IssueRef): Promise<Issue> {
    const { labeledBy: _ignored, ...issue } = this.stored(ref);
    return { ...issue, labels: [...issue.labels], comments: [...issue.comments] };
  }

  async canTrigger(ref: IssueRef): Promise<TriggerCheck> {
    const login = this.stored(ref).labeledBy;
    const p = login ? this.permissions[login] : undefined;
    return { ok: p === 'admin' || p === 'write' || p === 'maintain', login };
  }

  async removeTriggerLabel(ref: IssueRef): Promise<void> {
    this.calls.push('removeTriggerLabel');
    const i = this.stored(ref);
    i.labels = i.labels.filter((l) => l !== this.triggerLabel);
  }

  async setStatus(ref: IssueRef, status: StatusLabel | null): Promise<void> {
    this.calls.push(`setStatus:${status}`);
    const i = this.stored(ref);
    const all = new Set(allStatusLabelNames(this.triggerLabel));
    i.labels = i.labels.filter((l) => !all.has(l));
    if (status) i.labels.push(statusLabelName(this.triggerLabel, status));
  }

  async comment(ref: IssueRef, markdown: string): Promise<void> {
    this.calls.push('comment');
    const k = this.key(ref);
    this.comments.set(k, [...(this.comments.get(k) ?? []), markdown]);
  }

  async isStillActive(ref: IssueRef): Promise<boolean> {
    const i = this.issues.get(this.key(ref));
    return !!i && i.state === 'open' && i.labels.includes(this.triggerLabel);
  }

  async getDefaultBranch(): Promise<string> {
    return this.defaultBranch;
  }

  async getAuthenticatedRemoteUrl(): Promise<string> {
    return this.remoteUrl;
  }

  async openPullRequest(input: PullRequestInput): Promise<PullRef> {
    this.calls.push('openPullRequest');
    const number = this.nextPr++;
    const url = `https://github.com/${input.repo.full}/pull/${number}`;
    this.pulls.push({
      number, repo: input.repo.full, url, title: input.title, head: input.head, base: input.base, body: input.body, draft: input.draft,
      labels: [...input.labels], reviewers: [...input.reviewers], state: 'open', mergedAt: null,
    });
    return { repo: input.repo, number, url };
  }

  async updatePullRequest(ref: PullRef, patch: { title: string; body: string; draft: boolean }): Promise<void> {
    this.calls.push('updatePullRequest');
    const pr = this.pulls.find((p) => p.repo === ref.repo.full && p.number === ref.number);
    if (!pr) throw new Error(`PR inconnue : ${ref.number}`);
    Object.assign(pr, patch);
  }

  async findPullRequest(repo: RepoRef, headBranch: string): Promise<PullRef | null> {
    const pr = this.pulls.find((p) => p.repo === repo.full && p.head === headBranch && p.state === 'open');
    return pr ? { repo, number: pr.number, url: pr.url } : null;
  }

  async getPullRequestState(ref: PullRef): Promise<PullRequestState> {
    const pr = this.pulls.find((p) => p.repo === ref.repo.full && p.number === ref.number);
    if (!pr) throw new Error(`PR inconnue : ${ref.number}`);
    return { state: pr.state, mergedAt: pr.mergedAt };
  }

  async ensureLabels(repo: RepoRef): Promise<void> {
    this.labelsEnsured.push(repo.full);
  }
}
