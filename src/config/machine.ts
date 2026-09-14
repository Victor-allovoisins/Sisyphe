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
  /** Trois formes : un nombre (le plafond), `null` (aucun plafond, explicitement), ou l'absence. Voir `effectiveDailyBudget`. */
  dailyBudgetUsd: z.number().positive().max(1000).nullable().optional(),
  sandbox: z.boolean().default(false),
  /** `sdk` : Agent SDK, exige ANTHROPIC_API_KEY. `cli` : la CLI Claude Code locale (`claude -p`), donc l'abonnement claude.ai. */
  agentBackend: z.enum(['sdk', 'cli']).default('sdk'),
  dataDir: homeOrAbsolute.default('~/.sisyphe'),
});
export type MachineConfig = z.infer<typeof MachineConfigSchema>;
export type AgentBackend = MachineConfig['agentBackend'];

/** Plafond historique, appliqué à une config `sdk` muette : sous clé API, le coût est facturé pour de bon. */
const SDK_DEFAULT_DAILY_BUDGET_USD = 60;

/**
 * Plafond quotidien réellement appliqué, ou `undefined` quand il n'y en a aucun.
 *
 * La valeur brute est conservée telle quelle dans `MachineConfig` et résolue ici, à l'usage, parce que tout
 * ce qui réécrit la configuration la recopie : résolue à la lecture, `sisyphe setup` graverait dans le fichier
 * un plafond de 60 jamais saisi dès qu'une config `sdk` sans plafond passe en `cli`, et « aucun plafond »
 * deviendrait inexprimable sous `sdk`, où l'absence du champ vaut 60.
 */
export function effectiveDailyBudget(machine: Pick<MachineConfig, 'dailyBudgetUsd' | 'agentBackend'>): number | undefined {
  // `null` : plafond explicitement vidé depuis la page de réglages, quel que soit le backend.
  if (machine.dailyBudgetUsd === null) return undefined;
  if (machine.dailyBudgetUsd !== undefined) return machine.dailyBudgetUsd;
  // Champ absent : `sdk` garde le plafond historique — rien n'est désactivé en silence sur une config
  // existante ; `cli` n'en a aucun, le coût y étant notionnel et non facturé.
  return machine.agentBackend === 'sdk' ? SDK_DEFAULT_DAILY_BUDGET_USD : undefined;
}

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
