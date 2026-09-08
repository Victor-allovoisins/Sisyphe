export function slugify(title: string, maxLength = 40): string {
  const ascii = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const slug = ascii.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const cut = slug.slice(0, maxLength).replace(/-+$/g, '');
  return cut.length > 0 ? cut : 'issue';
}

export function branchName(prefix: string, issueNumber: number, title: string): string {
  return `${prefix}issue-${issueNumber}-${slugify(title)}`;
}
