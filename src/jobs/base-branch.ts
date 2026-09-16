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
 * Quand le ticket ne porte pas de version, on ne devine pas : on rend la main. C'est une information qu'un
 * humain doit fournir, et se tromper de base coûte une PR ouverte au mauvais endroit.
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
  if (versions.length === 0) {
    return { kind: 'blocked', reason: "le ticket n'indique aucune version cible (champ « Versions corrigées »)" };
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
