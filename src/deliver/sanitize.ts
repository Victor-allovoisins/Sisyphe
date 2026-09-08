/**
 * Neutralise ce qu'un texte écrit par le modèle pourrait déclencher côté GitHub :
 * mots-clés de fermeture d'issue (`Fixes #12` fermerait #12 au merge) et
 * commentaires HTML (faux marqueur de job). À appliquer à tout texte du modèle,
 * jamais aux lignes écrites par Sisyphe.
 */
export function sanitizeModelText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s+)(#\d+)/gi, '$1$2`$3`');
}
