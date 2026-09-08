import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export const REPO_CONFIG_FILENAME = 'sisyphe.yml';

// Zod 4 : `.default(x)` renvoie x sans le parser, `.prefault(x)` parse x et
// applique donc les défauts internes. Indispensable pour les objets imbriqués.
export const RepoConfigSchema = z.object({
  baseBranch: z.string().min(1),
  branchPrefix: z.string().default('feature/'),
  commands: z.object({
    setup: z.string().min(1).optional(),
    build: z.string().min(1),
    test: z.string().min(1).optional(),
    lint: z.string().min(1).optional(),
  }),
  protectedPaths: z.array(z.string()).default([]),
  models: z
    .object({
      triage: z.string().default('claude-sonnet-5'),
      implement: z.string().default('claude-opus-5'),
    })
    .prefault({}),
  budget: z
    .object({
      triageUsd: z.number().positive().default(1),
      implementUsd: z.number().positive().default(8),
    })
    .prefault({}),
  limits: z
    .object({
      maxAttempts: z.number().int().min(1).default(3),
      maxDiffLines: z.number().int().min(1).default(800),
      maxFilesEstimate: z.number().int().min(1).default(15),
    })
    .prefault({}),
  timeouts: z
    .object({
      triageMinutes: z.number().positive().default(10),
      implementMinutes: z.number().positive().default(60),
      verifyMinutes: z.number().positive().default(30),
    })
    .prefault({}),
  pr: z
    .object({
      labels: z.array(z.string()).default(['sisyphe']),
      reviewers: z.array(z.string()).default([]),
      draft: z.boolean().default(false),
    })
    .prefault({}),
  instructions: z.string().default(''),
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
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`)
      .join(' ; ');
    throw new RepoConfigError('invalid', `${REPO_CONFIG_FILENAME} invalide : ${issues}`);
  }
  return result.data;
}

export async function loadRepoConfig(dir: string): Promise<RepoConfig> {
  const file = join(dir, REPO_CONFIG_FILENAME);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RepoConfigError('missing', `${REPO_CONFIG_FILENAME} absent à la racine du repo`);
    }
    throw err;
  }
  return parseRepoConfig(text);
}

export const EXAMPLE_REPO_CONFIG = `baseBranch: main
commands:
  build: npm run build
  test: npm test
`;
