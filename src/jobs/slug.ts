/**
 * Titre → slug ASCII : toujours `[a-z0-9]` séparés par `separator`, jamais vide, jamais terminé par le
 * séparateur. Donc toujours un composant de ref git valide ; la validité du préfixe est l'affaire de la config.
 */
export function slugify(title: string, maxLength = 40, separator = '-'): string {
  const ascii = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const words = ascii.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w !== '');
  const cut = words.join(separator).slice(0, maxLength);
  const trimmed = separator === '' ? cut : cut.replace(new RegExp(`${separator}+$`), '');
  return trimmed.length > 0 ? trimmed : 'issue';
}

/**
 * Convention AlloVoisins : `{prefix}{slug_snake_case}_{numero}`, par exemple `feature/stripe_coupons_517`
 * pour IOS-517. Le numéro seul, jamais la clé complète ; snake_case, jamais de tiret dans le slug — sinon
 * la branche ne ressemble plus à celles que l'équipe ouvre à la main et les conventions divergent en silence.
 */
export function branchName(prefix: string, issueNumber: number, title: string): string {
  return `${prefix}${slugify(title, 40, '_')}_${issueNumber}`;
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
