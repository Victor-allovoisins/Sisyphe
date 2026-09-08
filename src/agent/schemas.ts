import { z } from 'zod';

export const TriageVerdictSchema = z.object({
  verdict: z.enum(['ready', 'needs_clarification', 'too_big', 'out_of_scope']),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  change_type: z.enum(['feat', 'fix', 'refactor', 'chore', 'docs']),
  plan: z.array(z.string()),
  files_likely_touched: z.array(z.string()),
  questions: z.array(z.string()),
  reasons: z.array(z.string()),
});
export type TriageVerdict = z.infer<typeof TriageVerdictSchema>;

export const ImplementationReportSchema = z.object({
  summary: z.string(),
  changes: z.array(z.object({ file: z.string(), what: z.string() })),
  decisions: z.array(z.string()),
  tests_run: z.array(z.string()),
  risks: z.array(z.string()),
  follow_ups: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});
export type ImplementationReport = z.infer<typeof ImplementationReportSchema>;

// Le SDK valide en draft-07 : Zod 4 cible 2020-12 par défaut, d'où l'option.
export const triageJsonSchema = z.toJSONSchema(TriageVerdictSchema, { target: 'draft-7' }) as Record<string, unknown> & {
  $schema: string;
  required: string[];
};
export const reportJsonSchema = z.toJSONSchema(ImplementationReportSchema, { target: 'draft-7' }) as Record<string, unknown> & {
  $schema: string;
  required: string[];
};

/** Rapport de secours quand l'agent n'a pas produit de JSON conforme. */
export function fallbackReport(reason: string): ImplementationReport {
  return {
    summary: `Rapport généré par Sisyphe : ${reason}. Le diff doit être relu intégralement.`,
    changes: [],
    decisions: [],
    tests_run: [],
    risks: ["L'agent n'a pas produit de rapport structuré."],
    follow_ups: [],
    confidence: 0,
  };
}
