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
      note: '',
      change_type: 'feat',
      plan: ['créer la vue', 'brancher le modèle'],
      files_likely_touched: ['Sources/A.swift'],
      questions: [],
      reasons: [],
    });
    expect(v.verdict).toBe('ready');
  });

  const valid = {
    verdict: 'ready', confidence: 0.8, summary: 'Ajouter un bouton', note: '', change_type: 'feat',
    plan: ['créer la vue'], files_likely_touched: ['Sources/A.swift'], questions: [], reasons: [],
  };

  it('refuse un verdict inconnu', () => {
    expect(TriageVerdictSchema.safeParse({ ...valid, verdict: 'maybe' }).success).toBe(false);
  });

  it('refuse une confiance hors bornes et un résumé vide', () => {
    expect(TriageVerdictSchema.safeParse({ ...valid, confidence: 2 }).success).toBe(false);
    expect(TriageVerdictSchema.safeParse({ ...valid, confidence: -0.1 }).success).toBe(false);
    expect(TriageVerdictSchema.safeParse({ ...valid, summary: '' }).success).toBe(false);
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
  it('cible draft-07, exige tous les champs et interdit les champs inconnus', () => {
    const draft07 = 'http://json-schema.org/draft-07/schema#';
    expect(triageJsonSchema.$schema).toBe(draft07);
    expect(reportJsonSchema.$schema).toBe(draft07);
    expect(triageJsonSchema.required).toEqual(['verdict', 'confidence', 'summary', 'note', 'change_type', 'plan', 'files_likely_touched', 'questions', 'reasons']);
    expect(reportJsonSchema.required).toEqual(['summary', 'changes', 'decisions', 'tests_run', 'risks', 'follow_ups', 'confidence']);
    expect(triageJsonSchema.additionalProperties).toBe(false);
    expect(reportJsonSchema.additionalProperties).toBe(false);
  });

  it('propage les descriptions dans le contrat du modèle', () => {
    const props = triageJsonSchema.properties as Record<string, { description?: string }>;
    expect(props.questions.description).toContain('needs_clarification');
  });
});
