import type { RepoConfig } from '../config/repo.js';
import type { Issue } from '../github/source.js';

/**
 * Sur quelle branche partir.
 *
 * Avec les issues GitHub, la réponse est dans `sisyphe.yml` et ne varie pas. Avec Jira, elle dépend du
 * ticket : la référence de l'équipe (`av-tools`, `jira-ios.yml`) laisse la branche de base en `ask_user`
 * pour la plupart des types de tickets, or Sisyphe n'a personne à qui demander. On la déduit donc de la
 * version cible du ticket, ce que fait un développeur : un correctif destiné à une release déjà ouverte part
 * de cette release, sinon du tronc.
 *
 * Un ticket **sans version est un ticket de backlog**, et c'est le cas le plus courant : il part du tronc,
 * sans rien demander à personne. Seul un ticket qui vise **plusieurs** versions est rendu — là il y a
 * vraiment un choix à faire, et se tromper coûte une PR ouverte au mauvais endroit.
 */
export type BaseBranchResolution =
  | { kind: 'ok'; branch: string; reason: string }
  | { kind: 'blocked'; reason: string };

export function releaseBranchFor(config: RepoConfig, version: string): string {
  return config.releaseBranchPattern.replace('{version}', version);
}

export async function resolveBaseBranch(opts: {
  config: RepoConfig;
  issue: Issue;
  /** Existence sur le distant ; injectée pour que la décision reste testable sans réseau. */
  branchExists: (branch: string) => Promise<boolean>;
}): Promise<BaseBranchResolution> {
  const { config, issue } = opts;

  // Pas de traqueur riche (issue GitHub) : le comportement historique, à l'identique.
  if (!issue.tracker) return { kind: 'ok', branch: config.baseBranch, reason: 'branche de base du dépôt' };

  const versions = issue.tracker.fixVersions;
  // Le cas le plus fréquent : ticket de backlog, aucune version visée. On part du tronc, comme un développeur
  // à qui on confie un ticket de backlog — et surtout on ne le rend pas, sans quoi la majorité des tickets
  // reviendrait aussitôt à son auteur sans qu'aucun travail n'ait eu lieu.
  if (versions.length === 0) {
    return { kind: 'ok', branch: config.baseBranch, reason: 'ticket de backlog, aucune version visée' };
  }
  if (versions.length > 1) {
    return { kind: 'blocked', reason: `le ticket vise plusieurs versions (${versions.join(', ')}), on ne peut pas choisir à sa place` };
  }

  const version = versions[0];
  const release = releaseBranchFor(config, version);
  // Un nom de branche invalide viendrait d'une version fantaisiste : on ne le passe pas à git.
  if (/\s/.test(release)) {
    return { kind: 'blocked', reason: `la version « ${version} » ne donne pas un nom de branche utilisable` };
  }
  if (await opts.branchExists(release)) {
    return { kind: 'ok', branch: release, reason: `version ${version}, branche de release ouverte` };
  }
  return { kind: 'ok', branch: config.baseBranch, reason: `version ${version}, pas encore de branche de release` };
}
