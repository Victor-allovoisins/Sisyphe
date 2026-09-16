/** Ce que le préfixe autorisé laisse faire, et rien d'autre. Voir `decideBash`. */
export const JIRA_COMMAND_PREFIX = 'sisyphe jira ';

/** Ce qui enchaîne, redirige ou substitue une commande : une seule de ces marques et on refuse. */
const SHELL_METACHARACTERS = /[;&|<>`$(){}\n\r\\]/;

export interface BashDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Le garde-fou Bash de la phase `jira`. Elle travaille avec le texte du ticket en contexte, écrit par
 * des tiers : seul `sisyphe jira …` passe, et seulement s'il ne porte aucune marque d'enchaînement.
 * Refuser toute métacaractère plutôt que d'essayer d'analyser la ligne — un analyseur de shell partiel
 * se fait contourner, une liste de caractères interdits non.
 *
 * Le `trim()` est plus large que le découpage du shell (il enlève aussi l'espace insécable, le BOM,
 * les séparateurs Unicode) : un préfixe qui ne passe que grâce à lui donne au shell un nom de commande
 * introuvable, donc l'écart penche du bon côté. Il n'enlève que les bords, jamais un enchaînement au
 * milieu : `sisyphe jira show X\nrm -rf /` garde son saut de ligne et se fait prendre.
 *
 * Ferme par défaut : entrée absente, vide ou inattendue = refus.
 */
export function decideBash(command: string | undefined): BashDecision {
  if (typeof command !== 'string' || !command.trim()) {
    return { allowed: false, reason: 'Commande absente : refusée.' };
  }
  const trimmed = command.trim();
  if (SHELL_METACHARACTERS.test(trimmed)) {
    return { allowed: false, reason: 'Commande refusée : enchaînement, redirection ou substitution shell interdits dans cette phase.' };
  }
  if (!trimmed.startsWith(JIRA_COMMAND_PREFIX)) {
    return { allowed: false, reason: `Commande refusée : seul « ${JIRA_COMMAND_PREFIX.trim()} … » est autorisé dans cette phase.` };
  }
  return { allowed: true, reason: '' };
}
