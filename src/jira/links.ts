/**
 * L'URL de consultation d'un ticket. Seul endroit qui connaît cette forme : l'UI, le corps de PR et les
 * commentaires la réclament tous, et une deuxième écriture littérale finirait par diverger.
 */
export function browseUrl(site: string, key: string): string {
  return `https://${site}/browse/${key}`;
}
