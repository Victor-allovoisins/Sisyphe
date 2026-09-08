import { describe, expect, it } from 'vitest';
import {
  ImplementationReportSchema,
  TriageVerdictSchema,
  fallbackReport,
  reportJsonSchema,
  triageJsonSchema,
} from './schemas.js';

describe('TriageVerdictSchema', () => {
  it('accepte un verdict complet', () => {
    const v = TriageVerdictSchema.parse({
      verdict: 'ready',
      confidence: 0.8,
      summary: 'Ajouter un bouton',
      change_type: 'feat',
      plan: ['créer la vue', 'brancher le modèle'],
      files_likely_touched: ['Sources/A.swift'],
      questions: [],
      reasons: [],
    });
    expect(v.verdict).toBe('ready');
  });

  it('refuse un verdict inconnu et une confiance hors bornes', () => {
    expect(TriageVerdictSchema.safeParse({ verdict: 'maybe' }).success).toBe(false);
    expect(
      TriageVerdictSchema.safeParse({
        verdict: 'ready', confidence: 2, summary: '', change_type: 'fix',
        plan: [], files_likely_touched: [], questions: [], reasons: [],
      }).success,
    ).toBe(false);
  });
});

describe('ImplementationReportSchema', () => {
  it('accepte un rapport complet', () => {
    const r = ImplementationReportSchema.parse({
      summary: 'Fait', changes: [{ file: 'a.ts', what: 'ajout' }], decisions: [],
      tests_run: ['npm test : ok'], risks: [], follow_ups: [], confidence: 0.9,
    });
    expect(r.changes[0].file).toBe('a.ts');
  });

  it('fallbackReport produit un rapport valide', () => {
    const r = fallbackReport('arrêt anticipé (max_turns)');
    expect(ImplementationReportSchema.safeParse(r).success).toBe(true);
    expect(r.summary).toContain('max_turns');
    expect(r.confidence).toBe(0);
  });
});

describe('JSON Schema', () => {
  it('cible draft-07 et liste les champs requis', () => {
    expect(triageJsonSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(triageJsonSchema.required).toEqual(
      expect.arrayContaining(['verdict', 'plan', 'questions', 'reasons']),
    );
    expect(reportJsonSchema.required).toEqual(expect.arrayContaining(['summary', 'changes']));
  });
});
