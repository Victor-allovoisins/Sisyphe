import { describe, expect, it } from 'vitest';
import { branchName, isValidBranchName, slugify } from './slug.js';

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
  it('borne à exactement 40 caractères et nettoie la ponctuation aux extrémités', () => {
    expect(slugify('a'.repeat(40) + ' b')).toBe('a'.repeat(40));
    expect(slugify('---Fix this---')).toBe('fix-this');
  });
});

describe('branchName', () => {
  it('assemble préfixe, numéro et slug', () => {
    expect(branchName('feature/', 42, 'Fix crash au login')).toBe('feature/issue-42-fix-crash-au-login');
  });
});

describe('isValidBranchName', () => {
  it('accepte nos noms composés et refuse les refs invalides pour git', () => {
    expect(isValidBranchName('feature/issue-42-fix-crash')).toBe(true);
    expect(isValidBranchName('sisyphe/fix-issue-1-x')).toBe(true);
    for (const bad of ['../issue-1-x', 'feature/.issue-1-x', 'a//b/issue-1-x', 'feature.lock/issue-1-x', '-issue-1-x', 'feature/issue-1-x/', 'a..b/issue-1-x']) {
      expect(isValidBranchName(bad), bad).toBe(false);
    }
  });
});
