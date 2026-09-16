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
  it('accepte un autre séparateur, sans en laisser traîner un à la fin', () => {
    expect(slugify('Fix crash au login', 40, '_')).toBe('fix_crash_au_login');
    // La coupe tombe pile sur le séparateur : il ne doit pas rester en fin de slug.
    expect(slugify('a'.repeat(39) + ' b', 40, '_')).toBe('a'.repeat(39));
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
  it('suit la convention AlloVoisins : slug snake_case puis numéro', () => {
    expect(branchName('feature/', 42, 'Fix crash au login')).toBe('feature/fix_crash_au_login_42');
  });
  it("reprend l'exemple de la référence av-tools", () => {
    expect(branchName('feature/', 517, 'Stripe coupons')).toBe('feature/stripe_coupons_517');
  });
  it('reste un nom de branche valide quand le titre ne donne rien', () => {
    const b = branchName('backlog/', 885, '🚀🚀🚀');
    expect(b).toBe('backlog/issue_885');
    expect(isValidBranchName(b)).toBe(true);
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
