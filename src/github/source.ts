export interface RepoRef {
  owner: string;
  name: string;
  full: string;
}

export function parseRepo(full: string): RepoRef {
  const [owner, name, ...rest] = full.split('/');
  if (!owner || !name || rest.length > 0) throw new Error(`Repo invalide : ${full} (attendu owner/repo)`);
  return { owner, name, full: `${owner}/${name}` };
}

export interface IssueRef {
  repo: RepoRef;
  number: number;
}

export function issueRefOf(job: { repo: string; issueNumber: number }): IssueRef {
  return { repo: parseRepo(job.repo), number: job.issueNumber };
}

export interface IssueComment {
  author: string;
  body: string;
  /** ISO 8601. */
  createdAt: string;
}

export interface Issue {
  repo: RepoRef;
  number: number;
  title: string;
  /** Jamais null : chaîne vide si l'issue n'a pas de description. */
  body: string;
  author: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
}

export type StatusLabel = 'in-progress' | 'blocked' | 'done' | 'failed';

export interface PullRequestInput {
  repo: RepoRef;
  title: string;
  head: string;
  base: string;
  body: string;
  draft: boolean;
  labels: string[];
  reviewers: string[];
}

export interface PullRef {
  repo: RepoRef;
  number: number;
  url: string;
}

export interface PullRequestState {
  state: 'open' | 'closed';
  mergedAt: string | null;
}

export interface TriggerCheck {
  ok: boolean;
  /** null quand aucun événement `labeled` du label trigger n'a été trouvé. */
  login: string | null;
}

/**
 * Tout ce que Sisyphe demande à la forge. Une implémentation GitHub en v1,
 * une fake pour les tests. L'implémentation connaît le label trigger.
 */
export interface IssueSource {
  /** Issues ouvertes portant le label trigger et aucun label de statut. */
  listCandidates(repo: RepoRef): Promise<IssueRef[]>;
  listWithStatus(repo: RepoRef, status: StatusLabel): Promise<IssueRef[]>;
  getIssue(ref: IssueRef): Promise<Issue>;
  /** Le dernier poseur du label trigger a-t-il write/maintain/admin ? */
  canTrigger(ref: IssueRef): Promise<TriggerCheck>;
  removeTriggerLabel(ref: IssueRef): Promise<void>;
  /** Pose ce label de statut et retire les autres ; null retire tout statut. */
  setStatus(ref: IssueRef, status: StatusLabel | null): Promise<void>;
  comment(ref: IssueRef, markdown: string): Promise<void>;
  /** Ouverte et label trigger toujours présent. */
  isStillActive(ref: IssueRef): Promise<boolean>;
  getDefaultBranch(repo: RepoRef): Promise<string>;
  /** URL HTTPS avec token d'installation, valide environ une heure : à ré-obtenir juste avant chaque fetch ou push, jamais mémorisée au-delà d'une opération. */
  getAuthenticatedRemoteUrl(repo: RepoRef): Promise<string>;
  openPullRequest(input: PullRequestInput): Promise<PullRef>;
  updatePullRequest(ref: PullRef, patch: { title: string; body: string; draft: boolean; base: string }): Promise<void>;
  /** Recherche la PR ouverte dont la branche source est headBranch ; les PR fermées ou fusionnées ne comptent pas. */
  findPullRequest(repo: RepoRef, headBranch: string): Promise<PullRef | null>;
  getPullRequestState(ref: PullRef): Promise<PullRequestState>;
  ensureLabels(repo: RepoRef): Promise<void>;
}
