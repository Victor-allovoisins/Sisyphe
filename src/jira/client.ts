import { readFile } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { MachineConfig } from '../config/machine.js';
import { withRetry, type RetryOptions } from '../github/retry.js';
import type { Issue, IssueRef, IssueTracker, RepoRef, StatusLabel, TriggerCheck } from '../github/source.js';
import { adfToMarkdown } from './adf.js';
import { markdownToAdf } from './to-adf.js';
import { walkTo, type JiraTransition } from './transitions.js';

type JiraConfig = NonNullable<MachineConfig['jira']>;
export type JiraProject = JiraConfig['projects'][number];

/** Corps de commentaire : Jira refuse au-delà de 32 767 caractères sur un champ texte riche. */
const MAX_COMMENT_CHARS = 30_000;

export interface JiraClientConfig {
  site: string;
  email: string;
  apiToken: string;
  projects: JiraProject[];
  log?: Logger;
  retry?: Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'sleep'>;
  /** Injecté par les tests ; en production, le `fetch` de Node. */
  fetchImpl?: typeof fetch;
}

interface JiraFields {
  summary?: string;
  description?: unknown;
  labels?: string[];
  status?: { name?: string; statusCategory?: { key?: string } };
  reporter?: { displayName?: string; accountId?: string };
  assignee?: { displayName?: string; accountId?: string } | null;
  issuetype?: { name?: string };
  fixVersions?: { name?: string }[];
}

interface JiraIssueJson {
  key: string;
  fields?: JiraFields;
}

/** Erreur HTTP portant son `status`, pour que `withRetry` et les appelants la classent comme celles d'Octokit. */
export class JiraHttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    body: string,
  ) {
    super(`Jira ${method} ${path} → ${status}${body ? ` : ${body.slice(0, 300)}` : ''}`);
    this.name = 'JiraHttpError';
  }
}

/** `IOS-885` → 885. Renvoie null sur une clé qui n'a pas cette forme. */
export function numberFromKey(key: string): number | null {
  const m = /-(\d+)$/.exec(key);
  return m ? Number(m[1]) : null;
}

/** Échappe une valeur pour une chaîne JQL entre guillemets. */
export function jqlQuote(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Le suivi des tickets sur Jira.
 *
 * Deux écarts assumés par rapport au modèle GitHub, qui viennent de la décision de faire de Sisyphe un
 * membre de l'équipe plutôt qu'un robot à labels :
 *
 * - **Le déclencheur est l'assignation**, pas un label. Un ticket assigné au compte dédié du projet et posé
 *   sur un statut candidat devient un job. Rendre la main, c'est réassigner au demandeur : le ticket cesse
 *   alors d'être candidat sans qu'aucun état supplémentaire n'ait à être stocké, et il le redevient dès
 *   qu'un humain le réassigne. C'est pourquoi `resumeIfCommented` n'a plus rien à faire.
 * - **Le statut suit le workflow de l'équipe**, de proche en proche (voir `transitions.ts`). Sisyphe ne
 *   ferme jamais un ticket : il le pose sur « En relecture », comme un développeur qui ouvre une PR.
 */
export class JiraIssueTracker implements IssueTracker {
  private readonly byRepo = new Map<string, JiraProject>();
  private readonly auth: string;

  constructor(private readonly cfg: JiraClientConfig) {
    for (const p of cfg.projects) this.byRepo.set(p.repo, p);
    this.auth = `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')}`;
  }

  static async fromFiles(cfg: JiraConfig & { log?: Logger }): Promise<JiraIssueTracker> {
    return new JiraIssueTracker({
      site: cfg.site,
      email: cfg.email,
      apiToken: (await readFile(cfg.apiTokenPath, 'utf8')).trim(),
      projects: cfg.projects,
      log: cfg.log,
    });
  }

  /** Le projet Jira qui sert ce dépôt. Absent : c'est une erreur de configuration, pas un cas courant. */
  project(repo: RepoRef): JiraProject {
    const p = this.byRepo.get(repo.full);
    if (!p) throw new Error(`Aucun projet Jira configuré pour le dépôt ${repo.full}`);
    return p;
  }

  /**
   * `IssueRef.number` reste le numéro seul et la clé est reconstruite ici.
   * Tient tant qu'un dépôt correspond à un seul projet Jira — ce que la configuration impose (`repo` unique).
   * Le jour où ce n'est plus vrai, il faudra porter la clé dans le store, donc migrer `issueNumber`.
   */
  private key(ref: IssueRef): string {
    return `${this.project(ref.repo).key}-${ref.number}`;
  }

  private async request<T>(method: string, path: string, body?: unknown, opts?: RetryOptions): Promise<T> {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    return withRetry(async () => {
      const res = await doFetch(`https://${this.cfg.site}${path}`, {
        method,
        headers: {
          Authorization: this.auth,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!res.ok) throw new JiraHttpError(res.status, method, path, await res.text().catch(() => ''));
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }, { ...this.cfg.retry, ...opts });
  }

  /**
   * Recherche paginée. `nextPageToken` est **omis** au premier appel : le passer à `null` ou vide fait
   * répondre « token invalide ou expiré » à l'API, ce qui viderait le résultat sans rien signaler.
   */
  private async search(jql: string, fields: string[]): Promise<JiraIssueJson[]> {
    const out: JiraIssueJson[] = [];
    let token: string | undefined;
    for (let page = 0; page < 50; page++) {
      const body: Record<string, unknown> = { jql, fields, maxResults: 100 };
      if (token) body.nextPageToken = token;
      const r = await this.request<{ issues?: JiraIssueJson[]; nextPageToken?: string }>('POST', '/rest/api/3/search/jql', body);
      out.push(...(r.issues ?? []));
      if (!r.nextPageToken) return out;
      token = r.nextPageToken;
    }
    return out;
  }

  private refsOf(repo: RepoRef, issues: JiraIssueJson[]): IssueRef[] {
    const refs: IssueRef[] = [];
    for (const i of issues) {
      const n = numberFromKey(i.key);
      if (n === null) this.cfg.log?.warn({ key: i.key }, 'clé Jira inattendue, ticket ignoré');
      else refs.push({ repo, number: n });
    }
    return refs;
  }

  /** Assigné au compte dédié et posé sur un statut candidat. Le store écarte ensuite ceux déjà en cours. */
  async listCandidates(repo: RepoRef): Promise<IssueRef[]> {
    const p = this.project(repo);
    const statuses = p.candidateStatuses.map(jqlQuote).join(', ');
    const jql = `project = ${jqlQuote(p.key)} AND assignee = ${jqlQuote(p.accountId)} AND status IN (${statuses}) ORDER BY created ASC`;
    return this.refsOf(repo, await this.search(jql, ['summary']));
  }

  /**
   * `blocked` n'existe pas comme état Jira : un ticket rendu n'est plus assigné au compte dédié, donc
   * introuvable par définition. On renvoie une liste vide plutôt que d'inventer un statut, et `resumeBlocked`
   * n'a plus rien à balayer — la réassignation par un humain suffit à le rendre candidat.
   */
  async listWithStatus(repo: RepoRef, st: StatusLabel): Promise<IssueRef[]> {
    const p = this.project(repo);
    const status = st === 'in-progress' ? p.inProgressStatus : st === 'done' ? p.doneStatus : null;
    if (!status) return [];
    const jql = `project = ${jqlQuote(p.key)} AND assignee = ${jqlQuote(p.accountId)} AND status = ${jqlQuote(status)}`;
    return this.refsOf(repo, await this.search(jql, ['summary']));
  }

  private async fetchIssue(key: string): Promise<JiraIssueJson> {
    const fields = 'summary,description,status,reporter,assignee,labels,issuetype,fixVersions';
    return this.request<JiraIssueJson>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${fields}`);
  }

  async getIssue(ref: IssueRef): Promise<Issue> {
    const key = this.key(ref);
    const [issue, comments] = await Promise.all([
      this.fetchIssue(key),
      this.request<{ comments?: { author?: { displayName?: string }; body?: unknown; created?: string }[] }>(
        'GET',
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=100&orderBy=created`,
      ),
    ]);
    const f = issue.fields ?? {};
    return {
      repo: ref.repo,
      number: ref.number,
      title: f.summary ?? key,
      body: adfToMarkdown(f.description),
      author: f.reporter?.displayName ?? 'inconnu',
      // Sisyphe ne connaît qu'ouvert ou fermé : la catégorie « done » du workflow fait office de fermeture.
      state: f.status?.statusCategory?.key === 'done' ? 'closed' : 'open',
      labels: f.labels ?? [],
      comments: (comments.comments ?? []).map((c) => ({
        author: c.author?.displayName ?? 'inconnu',
        body: adfToMarkdown(c.body),
        createdAt: c.created ?? new Date(0).toISOString(),
      })),
      tracker: {
        key,
        issueType: f.issuetype?.name ?? '',
        fixVersions: (f.fixVersions ?? []).map((v) => v.name ?? '').filter(Boolean),
        status: f.status?.name ?? '',
      },
    };
  }

  /**
   * Qui a confié le ticket à Sisyphe. On lit le changelog à l'envers jusqu'au dernier passage de l'assigné
   * vers notre compte ; à défaut (assignation à la création, historique purgé), on retombe sur le rapporteur.
   *
   * Contrairement à GitHub, il n'y a pas de contrôle de droits à faire : pouvoir assigner un ticket du projet
   * *est* l'autorisation. Le refus ne peut donc venir que d'un ticket qui ne nous est pas assigné du tout.
   */
  async canTrigger(ref: IssueRef): Promise<TriggerCheck> {
    const key = this.key(ref);
    const p = this.project(ref.repo);
    const issue = await this.fetchIssue(key);
    if (issue.fields?.assignee?.accountId !== p.accountId) {
      return { ok: false, login: issue.fields?.assignee?.displayName ?? null };
    }
    const assigner = await this.lastAssigner(key);
    return { ok: true, login: assigner?.displayName ?? issue.fields?.reporter?.displayName ?? null };
  }

  /** Dernière personne à avoir touché à l'assignation. Le changelog est un confort : son absence n'arrête rien. */
  private async lastAssigner(key: string): Promise<{ displayName: string | null; accountId: string | null } | null> {
    try {
      const r = await this.request<{ values?: { author?: { displayName?: string; accountId?: string }; items?: { field?: string }[] }[] }>(
        'GET',
        `/rest/api/3/issue/${encodeURIComponent(key)}/changelog?maxResults=100`,
      );
      const entries = r.values ?? [];
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.items?.some((it) => it.field === 'assignee')) {
          return { displayName: e.author?.displayName ?? null, accountId: e.author?.accountId ?? null };
        }
      }
    } catch (err) {
      this.cfg.log?.warn({ err, key }, 'changelog illisible, on retombe sur le rapporteur');
    }
    return null;
  }

  /**
   * Rendre la main : réassigner à celui qui nous a confié le ticket, à défaut à son rapporteur.
   * Le ticket cesse d'être candidat sans changer de colonne — on redonne la main, on ne fait pas reculer
   * le board. `accountId: null` laisserait le ticket sans assigné, donc orphelin : on ne s'y résout jamais.
   */
  async removeTriggerLabel(ref: IssueRef): Promise<void> {
    const key = this.key(ref);
    const [issue, assigner] = await Promise.all([this.fetchIssue(key), this.lastAssigner(key)]);
    const target = assigner?.accountId ?? issue.fields?.reporter?.accountId ?? null;
    await this.request('PUT', `/rest/api/3/issue/${encodeURIComponent(key)}/assignee`, { accountId: target });
  }

  /** Reprendre la main : s'assigner le ticket. Idempotent. */
  async addTriggerLabel(ref: IssueRef): Promise<void> {
    const p = this.project(ref.repo);
    await this.request('PUT', `/rest/api/3/issue/${encodeURIComponent(this.key(ref))}/assignee`, { accountId: p.accountId });
  }

  /**
   * `in-progress` et `done` deviennent des transitions de workflow.
   *
   * Tout le reste — `blocked`, `failed`, et `null` — rend le ticket à celui qui l'a confié, sans le déplacer :
   * un développeur qui bute ne fait pas reculer la colonne, il redonne la main. `null` compris : sur GitHub il
   * efface un label pour que l'issue redevienne candidate, et son équivalent Jira n'est pas « ne rien faire »
   * mais « ce ticket n'est plus à moi ». Sans cela, un job annulé ou orphelin laisserait le ticket en cours et
   * assigné au compte dédié : hors des statuts candidats, donc jamais repris, et assigné au bot, donc invisible.
   *
   * Cas assumé : après une PR ouverte dont la vérification échoue, le ticket est rendu sans quitter la colonne
   * de travail. Le commentaire porte le lien de la PR, et c'est à la personne qui reprend la main de décider
   * si elle passe en relecture ou repart en arrière.
   */
  async setStatus(ref: IssueRef, st: StatusLabel | null): Promise<void> {
    if (st === 'in-progress' || st === 'done') {
      const p = this.project(ref.repo);
      await this.transitionTo(ref, st === 'in-progress' ? p.inProgressStatus : p.doneStatus);
      return;
    }
    await this.removeTriggerLabel(ref);
  }

  async transitionTo(ref: IssueRef, target: string): Promise<{ hops: string[] }> {
    const key = this.key(ref);
    const p = this.project(ref.repo);
    return walkTo({
      target,
      statusesInOrder: p.statusesInOrder,
      currentStatus: async () => (await this.fetchIssue(key)).fields?.status?.name ?? '',
      availableTransitions: async () => {
        const r = await this.request<{ transitions?: JiraTransition[] }>('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`);
        return r.transitions ?? [];
      },
      // Non rejoué en cas d'erreur : une transition qui a abouti puis expiré ferait avancer deux fois.
      apply: async (id) => {
        await this.request('POST', `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id } }, { retryOnError: false });
      },
    });
  }

  /**
   * Ces commentaires sont lus par la personne qui a signalé le bug : ils partent en ADF lisible, pas en bloc
   * de code. `retryOnError: false` — un POST abouti puis expiré ne doit pas produire un doublon.
   */
  async comment(ref: IssueRef, markdown: string): Promise<void> {
    const text = markdown.length > MAX_COMMENT_CHARS ? `${markdown.slice(0, MAX_COMMENT_CHARS)}\n\n[…] message tronqué` : markdown;
    await this.request(
      'POST',
      `/rest/api/3/issue/${encodeURIComponent(this.key(ref))}/comment`,
      { body: markdownToAdf(text) },
      { retryOnError: false },
    );
  }

  /** Toujours faux : la réassignation est le seul signal de reprise, et elle repasse par `listCandidates`. */
  async resumeIfCommented(): Promise<boolean> {
    return false;
  }

  /** Toujours à nous, et pas encore terminé côté workflow. */
  async isStillActive(ref: IssueRef): Promise<boolean> {
    const p = this.project(ref.repo);
    const issue = await this.fetchIssue(this.key(ref));
    return issue.fields?.assignee?.accountId === p.accountId && issue.fields?.status?.statusCategory?.key !== 'done';
  }

  /**
   * Rien à créer sur Jira — mais l'occasion de vérifier que les statuts configurés existent vraiment dans le
   * projet. Une faute de frappe sur « Developpement fini » ne se verrait sinon qu'au moment de livrer,
   * job en cours et branche déjà poussée.
   */
  async ensureLabels(repo: RepoRef): Promise<void> {
    const p = this.project(repo);
    const r = await this.request<{ values?: { name?: string }[] }>(
      'GET',
      `/rest/api/3/project/${encodeURIComponent(p.key)}/statuses`,
    ).catch(() => null);
    if (!r) return;
    const known = new Set((r.values ?? []).map((s) => (s.name ?? '').toLowerCase()));
    if (known.size === 0) return;
    const missing = [...p.statusesInOrder, p.inProgressStatus, p.doneStatus].filter((s) => !known.has(s.toLowerCase()));
    if (missing.length > 0) {
      this.cfg.log?.warn({ project: p.key, missing }, 'statuts configurés absents du projet Jira');
    }
  }

  /** Lecture simple servant de contrôle d'accès à `doctor` : le compte, et les projets joignables. */
  async checkAccess(): Promise<{ displayName: string; projects: { key: string; reachable: boolean }[] }> {
    const me = await this.request<{ displayName?: string }>('GET', '/rest/api/3/myself');
    const projects = await Promise.all(
      this.cfg.projects.map(async (p) => ({
        key: p.key,
        reachable: await this.request('GET', `/rest/api/3/project/${encodeURIComponent(p.key)}`).then(() => true, () => false),
      })),
    );
    return { displayName: me.displayName ?? this.cfg.email, projects };
  }
}

/**
 * Résout l'`accountId` d'un compte Jira depuis son adresse ou son nom.
 *
 * Personne ne connaît son `accountId` par cœur : `sisyphe setup` demande une adresse et s'occupe du reste.
 * Une recherche qui ramène plusieurs comptes n'est pas tranchée ici — c'est à l'appelant de faire choisir,
 * parce qu'assigner les tickets au mauvais compte ne se verrait qu'à l'usage.
 */
export async function searchAccounts(
  cfg: { site: string; email: string; apiToken: string; fetchImpl?: typeof fetch },
  query: string,
): Promise<{ accountId: string; displayName: string; emailAddress?: string }[]> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(`https://${cfg.site}/rest/api/3/user/search?query=${encodeURIComponent(query)}&maxResults=10`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new JiraHttpError(res.status, 'GET', '/rest/api/3/user/search', await res.text().catch(() => ''));
  const users = (await res.json()) as { accountId?: string; displayName?: string; emailAddress?: string }[];
  return users
    .filter((u): u is { accountId: string; displayName?: string; emailAddress?: string } => typeof u.accountId === 'string')
    .map((u) => ({ accountId: u.accountId, displayName: u.displayName ?? u.accountId, emailAddress: u.emailAddress }));
}
