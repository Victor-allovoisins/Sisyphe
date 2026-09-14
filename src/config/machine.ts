import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { expandHome } from './paths.js';

/** Absolu ou relatif au home : un chemin relatif au cwd serait relatif à `/` sous launchd. */
const homeOrAbsolute = z.string().regex(/^(~\/|\/)/, 'chemin absolu ou commençant par ~/');

/** Owner GitHub : lettres, chiffres, tirets, jamais `_`. Garantit que le premier `__` d'un repoKey est le séparateur. */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

export const MachineConfigSchema = z.strictObject({
  github: z.strictObject({
    appId: z.number().int().positive(),
    installationId: z.number().int().positive(),
    privateKeyPath: homeOrAbsolute,
  }),
  repos: z
    .array(z.string().regex(REPO_PATTERN, 'format attendu : owner/repo'))
    .min(1)
    .refine((v) => new Set(v).size === v.length, 'repos en double'),
  triggerLabel: z.string().min(1).max(38).regex(/^[A-Za-z0-9][\w.-]*$/, 'lettres, chiffres, . _ -').default('sisyphe'),
  pollIntervalSeconds: z.number().int().min(10).max(3600).default(60),
  maxConcurrentJobs: z.number().int().min(1).max(8).default(1),
  /** Facultatif : absent, le plafond est résolu après le parse selon le backend (voir `parseMachineConfig`). */
  dailyBudgetUsd: z.number().positive().max(1000).optional(),
  sandbox: z.boolean().default(false),
  /** `sdk` : Agent SDK, exige ANTHROPIC_API_KEY. `cli` : la CLI Claude Code locale (`claude -p`), donc l'abonnement claude.ai. */
  agentBackend: z.enum(['sdk', 'cli']).default('sdk'),
  dataDir: homeOrAbsolute.default('~/.sisyphe'),
});
export type MachineConfig = z.infer<typeof MachineConfigSchema>;
/** Plafond historique, conservé pour une config `sdk` muette : sous clé API, le coût est facturé. */
const SDK_DEFAULT_DAILY_BUDGET_USD = 60;
export type AgentBackend = MachineConfig['agentBackend'];

export type MachineConfigErrorKind = 'missing' | 'invalid';

export class MachineConfigError extends Error {
  constructor(public readonly kind: MachineConfigErrorKind, message: string) {
    super(message);
    this.name = 'MachineConfigError';
  }
}

export function parseMachineConfig(yamlText: string): MachineConfig {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (err) {
    throw new MachineConfigError('invalid', `config.yml : YAML illisible : ${(err as Error).message}`);
  }
  const result = MachineConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => `- ${i.path.join('.') || '(racine)'} : ${i.message}`).join('\n');
    throw new MachineConfigError('invalid', `config.yml invalide :\n${issues}`);
  }
  const c = result.data;
  return {
    ...c,
    // Résolu ici, après le parse, pour que tous les appelants reçoivent la même valeur : champ absent sous `sdk`,
    // le plafond historique de 60 $ s'applique — rien n'est désactivé en silence sur une config existante ; champ
    // absent sous `cli`, aucun plafond, le coût n'y étant que notionnel. Seule une valeur explicitement vidée
    // depuis la page des réglages supprime le plafond d'une config `sdk`.
    dailyBudgetUsd: c.dailyBudgetUsd ?? (c.agentBackend === 'sdk' ? SDK_DEFAULT_DAILY_BUDGET_USD : undefined),
    dataDir: expandHome(c.dataDir),
    github: { ...c.github, privateKeyPath: expandHome(c.github.privateKeyPath) },
  };
}

export async function loadMachineConfig(path: string): Promise<MachineConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new MachineConfigError('missing', `Config machine absente : ${path}. Lancer \`sisyphe setup\`.`);
    }
    throw err;
  }
  return parseMachineConfig(text);
}
