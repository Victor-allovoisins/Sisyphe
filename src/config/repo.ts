import { parse } from 'yaml';
import { z } from 'zod';
import { branchName, isValidBranchName } from '../jobs/slug.js';

export const REPO_CONFIG_FILENAME = 'sisyphe.yml';

const nonEmpty = z.string().min(1);

/** Valeur absente ou vide (`models:` sans contenu est lu comme null) → undefined, pour que les défauts s'appliquent. */
const nullable = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => v ?? undefined, schema);

/**
 * Section optionnelle d'objets : `strictObject` refuse les clés inconnues, `.prefault({})` applique les défauts internes.
 * Prend le schéma déjà construit (et non un `ZodRawShape` générique) : Zod 4 ne peut pas vérifier que `{}` satisfait
 * `$InferObjectInput` pour un shape générique quelconque (il ne sait pas statiquement que tous ses champs ont un défaut),
 * et le refuse à la compilation. Construire `strictObject(...).prefault({})` sur un objet concret à chaque appel lève
 * l'ambiguïté sans recourir à un cast.
 */
const section = <T extends z.ZodTypeAny>(schema: T) => nullable(schema);

// Zod 4 : `.default(x)` renvoie x sans le parser, `.prefault(x)` parse x et applique donc les défauts internes.
// `strictObject` partout : une clé inconnue (faute de frappe sur protectedPaths) désactiverait une barrière en silence.
export const RepoConfigSchema = z.strictObject({
  baseBranch: nonEmpty,
  /**
   * Gabarit de branche de release, `{version}` étant la version cible du ticket. Sert quand le suivi est
   * sur Jira : un ticket porte sa `fixVersion`, et un correctif part de la release correspondante quand elle
   * est déjà ouverte — sinon de `baseBranch`. Sans suivi Jira, ce champ ne sert à rien.
   */
  releaseBranchPattern: z.string().min(1).includes('{version}', { message: 'doit contenir {version}' }).default('release/{version}'),
  branchPrefix: z
    .string()
    .regex(/^[A-Za-z0-9._/-]*$/, 'caractères autorisés : lettres, chiffres, . _ / -')
    .default('feature/')
    .refine((p) => isValidBranchName(branchName(p, 1, 'x')), 'préfixe produisant un nom de branche git invalide'),
  commands: z.strictObject({
    setup: nonEmpty.optional(),
    build: nonEmpty,
    test: nonEmpty.optional(),
    lint: nonEmpty.optional(),
  }),
  protectedPaths: nullable(z.array(nonEmpty).default([])),
  models: section(
    z
      .strictObject({
        triage: nonEmpty.default('claude-sonnet-5'),
        implement: nonEmpty.default('claude-opus-5'),
      })
      .prefault({}),
  ),
  budget: section(
    z
      .strictObject({
        triageUsd: z.number().positive().max(500).default(1),
        implementUsd: z.number().positive().max(500).default(8),
      })
      .prefault({}),
  ),
  limits: section(
    z
      .strictObject({
        maxAttempts: z.number().int().min(1).max(10).default(3),
        maxDiffLines: z.number().int().min(1).max(100_000).default(800),
        maxFilesEstimate: z.number().int().min(1).max(1000).default(15),
      })
      .prefault({}),
  ),
  timeouts: section(
    z
      .strictObject({
        triageMinutes: z.number().positive().max(1440).default(10),
        implementMinutes: z.number().positive().max(1440).default(60),
        verifyMinutes: z.number().positive().max(1440).default(30),
      })
      .prefault({}),
  ),
  pr: section(
    z
      .strictObject({
        labels: z.array(nonEmpty).default(['sisyphe']),
        reviewers: z.array(nonEmpty).default([]),
        draft: z.boolean().default(false),
      })
      .prefault({}),
  ),
  instructions: nullable(z.string().max(20_000).default('')),
  /**
   * Ce que ce dépôt ne laisse jamais sauter, quoi que le triage demande. Vide par défaut : sur un projet
   * où `build` coûte autant que `test` (iOS, xcodebuild sur simulateur), un plancher à `build` annulerait
   * l'essentiel du gain. L'équipe qui veut cette garantie se la donne elle-même.
   */
  verify: section(
    z
      .strictObject({
        alwaysRun: z.array(z.enum(['build', 'test', 'lint'])).default([]),
      })
      .prefault({}),
  ),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export type RepoConfigErrorKind = 'missing' | 'invalid';

export class RepoConfigError extends Error {
  constructor(public readonly kind: RepoConfigErrorKind, message: string) {
    super(message);
    this.name = 'RepoConfigError';
  }
}

export function parseRepoConfig(yamlText: string): RepoConfig {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (err) {
    throw new RepoConfigError('invalid', `YAML illisible : ${(err as Error).message}`);
  }
  const result = RepoConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `- ${i.path.join('.') || '(racine)'} : ${i.message}`).join('\n');
    throw new RepoConfigError('invalid', `${REPO_CONFIG_FILENAME} invalide :\n${issues}`);
  }
  return result.data;
}

export const EXAMPLE_REPO_CONFIG = `baseBranch: main
commands:
  build: npm run build
  test: npm test
`;
