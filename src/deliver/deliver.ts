import type { ImplementationReport } from '../agent/schemas.js';
import type { RepoConfig } from '../config/repo.js';
import { SISYPHE_AUTHOR, type Git } from '../git/git.js';
import { parseRepo, type Forge, type Issue, type PullRef } from '../github/source.js';
import type { Job, Phase } from '../store/types.js';
import type { VerifyResult } from '../verify/verify.js';
import { renderPrBody } from './pr-body.js';

export interface DeliverInput {
  job: Job;
  issue: Issue;
  config: RepoConfig;
  report: ImplementationReport;
  verify: VerifyResult;
  phases: Phase[];
  forge: Forge;
  git: Git;
  worktreePath: string;
  pushUrl: string;
  /** Base réellement retenue pour ce job : le `sisyphe.yml` ne décide plus seul quand le suivi est sur Jira. */
  baseBranch: string;
  /** Template de PR lu sur la branche de base par le pipeline (contenu du repo, de confiance). */
  prTemplate: string | null;
  durationMs: number;
  ticket: TicketRef | null;
}

/** Le ticket tel que la livraison doit le nommer. `null` : suivi GitHub, le nommage historique s'applique. */
export interface TicketRef {
  key: string;
  url: string;
}

export interface DeliverResult {
  prNumber: number;
  prUrl: string;
  /** Le commit de travail, porteur de l'arbre vérifié — pas l'éventuel commit de build, qui ne désigne aucun contenu. */
  commitSha: string;
  draft: boolean;
}

const MAX_SUBJECT = 200;

/** Titre d'issue nettoyé : contrôlé par l'auteur de l'issue, il finit dans un sujet de commit et un titre de PR. */
export function cleanTitle(title: string): string {
  const oneLine = title.replace(/[\x00-\x1F\x7F]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Sans titre';
  return oneLine.length > MAX_SUBJECT ? `${oneLine.slice(0, MAX_SUBJECT - 1)}…` : oneLine;
}

export function commitMessage(job: Job, ticket: TicketRef | null): string {
  const type = job.verdict?.change_type ?? 'chore';
  const author = `Co-Authored-By: ${SISYPHE_AUTHOR.name} <${SISYPHE_AUTHOR.email}>`;
  // La clé dans le sujet suffit à l'app GitHub for Jira : c'est ainsi qu'elle relie le commit au ticket.
  // Pas de `Closes` sous Jira — le numéro y désignerait une issue GitHub sans rapport, qu'une fusion sur la
  // branche par défaut fermerait pour de bon.
  if (ticket) return `${type}(${ticket.key}): ${cleanTitle(job.issueTitle)}\n\n${author}`;
  return `${type}(#${job.issueNumber}): ${cleanTitle(job.issueTitle)}\n\nCloses #${job.issueNumber}\n\n${author}`;
}

export function prTitle(job: Job, ticket: TicketRef | null): string {
  const type = job.verdict?.change_type ?? 'chore';
  // Convention av-tools : `type(KEY): description`, pour qu'une PR de Sisyphe ne se distingue pas d'une autre.
  if (ticket) return `${type}(${ticket.key}): ${cleanTitle(job.issueTitle)}`;
  return `[#${job.issueNumber}] ${cleanTitle(job.issueTitle)}`;
}

/** Les drapeaux calculés par la vérification sont lus à la source (`verify.flags`), pas dans leur copie sur le job. */
export function shouldBeDraft(job: Job, verify: VerifyResult, config: RepoConfig): boolean {
  return config.pr.draft || job.flags.verificationFailed || verify.flags.largeDiff;
}

/**
 * Note de version du build de préproduction. La CI la reprend telle quelle (`head_commit.message`) dans
 * Firebase, son commentaire Jira et sa carte Teams : elle est lue par des humains qui installent l'app et
 * ne connaissent pas le code, d'où la clé du ticket et son titre en clair plutôt qu'un marqueur seul.
 */
export function buildCommitMessage(job: Job, ticket: TicketRef): string {
  return `!build ${ticket.key} — ${cleanTitle(job.issueTitle)}`;
}

/**
 * Un build de préproduction ne part que pour une version installable : le quota Xcode Cloud est la ressource
 * rare, on ne le dépense pas pour du code que personne ne testera.
 * Ressemble à l'inverse de `shouldBeDraft` mais s'en distingue volontairement : `config.pr.draft` est un
 * réglage de présentation du dépôt (« toutes mes PR sont en brouillon »), pas un signal de qualité, et un
 * dépôt qui l'active ne doit pas perdre ses builds pour autant.
 * Sans ticket (suivi GitHub), pas de clé à mettre dans la note de version — et le dépôt visé n'est pas celui
 * qui lit le marqueur : on ne pousse rien.
 */
export function shouldTriggerBuild(job: Job, verify: VerifyResult, ticket: TicketRef | null): ticket is TicketRef {
  return ticket !== null && !job.flags.verificationFailed && !verify.flags.largeDiff;
}

/**
 * Commite l'arbre vérifié, pousse, crée ou met à jour la PR. Ne touche plus au ticket : statut et
 * commentaire de fin sont le travail de `finish()` dans le pipeline, qui les tient pour *toutes* les
 * sorties du job — la livraison n'en est qu'une, et n'a aucune raison d'en connaître le protocole.
 * Tout ici lève : rien de durable n'existe avant la PR, et rien ne reste à faire après elle.
 * Non idempotent : chaque appel produit un nouveau commit (horodatage) et un force-push.
 */
export async function deliver(i: DeliverInput): Promise<DeliverResult> {
  const { job, config, forge, baseBranch } = i;
  if (!job.branch || !job.baseSha) throw new Error('Job sans branche ou base : livraison impossible');
  if (!i.verify.treeSha) throw new Error('Aucun arbre vérifié : livraison impossible');
  // Seul point qui pousse : le garde anti-secrets est appliqué ici, quel que soit le chemin pris en amont.
  if (i.verify.flags.secretsFound.length > 0) throw new Error(`Secrets détectés dans le diff : livraison refusée (${i.verify.flags.secretsFound.join(', ')})`);
  const repo = parseRepo(job.repo);

  // On commite l'arbre exact que la vérification a inspecté, pas l'état du worktree après build/test.
  const commitSha = await i.git.commitTree(i.worktreePath, job.branch, i.verify.treeSha, job.baseSha, commitMessage(job, i.ticket));
  // Commit vide dédié, et surtout pas le marqueur dans le message du commit de travail : celui-là est fusionné
  // dans la branche de base et son message y reste pour toujours, un marqueur de CI n'y a pas sa place.
  // Il doit être le dernier commit poussé : la CI ne regarde que `head_commit.message`.
  const buildSha = shouldTriggerBuild(job, i.verify, i.ticket)
    ? await i.git.commitEmpty(i.worktreePath, job.branch, commitSha, buildCommitMessage(job, i.ticket))
    : null;
  // Un seul push pour les deux commits, donc un seul déclenchement du workflow.
  await i.git.push(i.worktreePath, i.pushUrl, job.branch, buildSha ?? commitSha);

  const draft = shouldBeDraft(job, i.verify, config);
  const title = prTitle(job, i.ticket);
  const body = renderPrBody({ job, report: i.report, verify: i.verify, phases: i.phases, prTemplate: i.prTemplate, costUsd: job.costUsd, durationMs: i.durationMs, ticket: i.ticket });

  const existing = await forge.findPullRequest(repo, job.branch);
  let pr: PullRef;
  if (existing) {
    await forge.updatePullRequest(existing, { title, body, draft, base: baseBranch });
    pr = existing;
  } else {
    // L'auteur de l'issue est relecteur par défaut ; s'il n'a pas accès au repo, le client GitHub ignore le 422 : c'est le contrôle d'accès.
    const reviewers = config.pr.reviewers.length > 0 ? config.pr.reviewers : [i.issue.author];
    pr = await forge.openPullRequest({ repo, title, head: job.branch, base: baseBranch, body, draft, labels: config.pr.labels, reviewers });
  }

  return { prNumber: pr.number, prUrl: pr.url, commitSha, draft };
}
