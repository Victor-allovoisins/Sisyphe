import { describe, expect, it } from 'vitest';
import { resolveVerifyScope } from './scope.js';

const base = {
  requested: { steps: ['build'] as const, why: 'changement de libellé' },
  configured: ['setup', 'build', 'test', 'lint'] as const,
  alwaysRun: [] as const,
  attempt: 1,
  largeDiff: false,
  protectedPathsTouched: [] as string[],
  filesLikelyTouched: ['App/Vue.swift'],
  changedFiles: ['App/Vue.swift'],
};

describe('resolveVerifyScope', () => {
  it('retient ce que le triage demande, croisé avec ce que le dépôt déclare', () => {
    const s = resolveVerifyScope({ ...base, configured: ['setup', 'build'] });
    expect(s.steps).toEqual(['setup', 'build']);
    expect(s.widened).toBe(false);
    expect(s.reason).toBe('changement de libellé');
  });

  it('setup est toujours retenu, même quand le triage ne demande rien', () => {
    expect(resolveVerifyScope({ ...base, requested: { steps: [], why: 'aucun code' } }).steps).toEqual(['setup']);
  });

  it('le plancher du dépôt s’ajoute à ce que le triage demande', () => {
    const s = resolveVerifyScope({ ...base, alwaysRun: ['lint'] });
    expect(s.steps).toEqual(['setup', 'build', 'lint']);
    expect(s.widened).toBe(false);
  });

  it('élargit sur un diff volumineux', () => {
    const s = resolveVerifyScope({ ...base, largeDiff: true });
    expect(s.steps).toEqual(['setup', 'build', 'test', 'lint']);
    expect(s.widened).toBe(true);
    expect(s.reason).toMatch(/volumineux/i);
  });

  it('élargit sur un chemin protégé touché', () => {
    expect(resolveVerifyScope({ ...base, protectedPathsTouched: ['App/Config.xcconfig'] })).toMatchObject({ widened: true });
  });

  it('élargit quand le diff sort de ce que le triage avait prévu', () => {
    const s = resolveVerifyScope({ ...base, changedFiles: ['App/Vue.swift', 'Core/Reseau.swift'] });
    expect(s.widened).toBe(true);
    expect(s.reason).toContain('Core/Reseau.swift');
  });

  it('élargit sur une reprise : le périmètre annoncé n’est plus crédible', () => {
    expect(resolveVerifyScope({ ...base, attempt: 2 })).toMatchObject({ widened: true });
  });

  it('n’élargit jamais au-delà de ce que le dépôt déclare', () => {
    const s = resolveVerifyScope({ ...base, configured: ['setup', 'build'], attempt: 2 });
    expect(s.steps).toEqual(['setup', 'build']);
  });

  it('borne la liste des fichiers citée : elle finit dans le corps de la pull request', () => {
    const many = Array.from({ length: 30 }, (_, k) => `App/Vue${k}.swift`);
    const s = resolveVerifyScope({ ...base, filesLikelyTouched: [], changedFiles: many });
    expect(s.reason).toContain('App/Vue0.swift');
    expect(s.reason).not.toContain('App/Vue20.swift');
    expect(s.reason).toContain('et 20 autres');
  });
});
