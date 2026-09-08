/**
 * Neutralise ce qu'un texte écrit par le modèle pourrait déclencher côté GitHub :
 * - mots-clés de fermeture d'issue (`Fixes #12`, `closes owner/repo#12`, `Resolves GH-12`, `fixes: #12`, forme URL) : la référence est mise entre backticks ;
 * - commentaires HTML, y compris non fermés ou éclatés entre deux champs (faux marqueur de job, masquage de sections) ;
 * - mentions `@login` (ping de vraies personnes) : espace sans chasse inséré après le `@`.
 * Par défaut le texte devient une seule ligne (il s'insère dans une puce). En mode `multiline`, on garde les
 * paragraphes mais on désarme les en-têtes `#` et les règles horizontales en début de ligne, qui forgeraient une section Sisyphe.
 * À appliquer à tout texte du modèle ou du repo, jamais aux lignes écrites par Sisyphe.
 */
const CLOSE_REF =
  /(\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+)((?:[\w.-]+\/[\w.-]+)?#\d+|GH-\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+)/gi;

export function sanitizeModelText(text: string, opts: { multiline?: boolean } = {}): string {
  let out = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!--|-->/g, '')
    .replace(CLOSE_REF, '$1`$2`')
    .replace(/@(?=\w)/g, '@​');
  if (opts.multiline) {
    out = out
      .split(/\r?\n/)
      .map((line) => line.replace(/^(\s{0,3})(#{1,6}\s)/, '$1\\$2').replace(/^(\s{0,3})([-*_])(?:\s*\2){2,}\s*$/, '$1\\$2$2$2'))
      .join('\n');
  } else {
    out = out.replace(/\s*\r?\n\s*/g, ' ');
  }
  return out;
}

/** Texte destiné à un span de code : une ligne, sans backtick. */
export function sanitizeCodeSpan(text: string): string {
  return sanitizeModelText(text).replace(/`/g, '');
}

/**
 * Borne un corps de commentaire ou de PR sous la limite GitHub (65 536 caractères) en préservant la fin,
 * où Sisyphe place `Closes #n` et le marqueur de job. À appliquer dans le client GitHub, à l'envoi.
 */
export function clampForGitHub(text: string, max = 60_000, keepTail = 1_000): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - keepTail - 60);
  const tail = text.slice(text.length - keepTail);
  return `${head}\n\n…(${text.length - head.length - tail.length} caractères coupés)…\n\n${tail}`;
}
