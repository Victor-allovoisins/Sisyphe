/**
 * Titre → slug kebab-case ASCII : toujours `[a-z0-9-]+`, jamais vide, jamais terminé par un tiret.
 * Donc toujours un composant de ref git valide ; la validité du préfixe est l'affaire de la config.
 */
export function slugify(title: string, maxLength = 40): string {
  const ascii = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const slug = ascii.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const cut = slug.slice(0, maxLength).replace(/-+$/g, '');
  return cut.length > 0 ? cut : 'issue';
}

export function branchName(prefix: string, issueNumber: number, title: string): string {
  return `${prefix}issue-${issueNumber}-${slugify(title)}`;
}

/**
 * Sous-ensemble des règles de `git check-ref-format` suffisant pour nos noms : caractères
 * `[A-Za-z0-9._/-]`, pas de `..`, pas de `-` initial, pas de `/` ou `.` final, et aucun composant
 * vide, commençant par `.` ou finissant par `.lock`.
 */
export function isValidBranchName(name: string): boolean {
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false;
  if (name.startsWith('-') || name.endsWith('/') || name.endsWith('.') || name.includes('..')) return false;
  return name.split('/').every((c) => c.length > 0 && !c.startsWith('.') && !c.endsWith('.lock'));
}
