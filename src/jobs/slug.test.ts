import { describe, expect, it } from 'vitest';
import { branchName, slugify } from './slug.js';

describe('slugify', () => {
  it('translittère accents et ponctuation', () => {
    expect(slugify('Ajouter un écran « Détails » !')).toBe('ajouter-un-ecran-details');
  });
  it('tronque à 40 caractères sans tiret final', () => {
    const s = slugify('a'.repeat(30) + ' ' + 'b'.repeat(30));
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith('-')).toBe(false);
  });
  it('retombe sur "issue" si rien ne reste', () => {
    expect(slugify('🚀🚀🚀')).toBe('issue');
  });
});

describe('branchName', () => {
  it('assemble préfixe, numéro et slug', () => {
    expect(branchName('feature/', 42, 'Fix crash au login')).toBe('feature/issue-42-fix-crash-au-login');
  });
});
