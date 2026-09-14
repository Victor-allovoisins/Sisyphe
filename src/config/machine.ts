import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { expandHome } from './paths.js';

/** Absolu ou relatif au home : un chemin relatif au cwd serait relatif à `/` sous launchd. */
const homeOrAbsolute = z.string().regex(/^(~\/|\/)/, 'chemin absolu ou commençant par ~/');

/** Owner GitHub : lettres, chiffres, tirets, jamais `_`. Garantit que le premier `__` d'un repoKey est le séparateur. */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

/** Les backends canoniques, dans l'ordre d'affichage. `cli` n'en fait pas partie : c'est un alias lu de `claude-code`. */
export const AGENT_BACKENDS = ['sdk', 'claude-code', 'codex', 'opencode'] as const;
export type AgentBackend = (typeof AGENT_BACKENDS)[number];

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
  /**
   * `sdk` : Agent SDK, exige ANTHROPIC_API_KEY. `claude-code` : la CLI Claude Code locale (`claude -p`),
   * donc l'abonnement claude.ai. `codex` et `opencode` : leurs CLI locales. L'alias historique `cli` est lu
   * comme `claude-code` au parse et n'est jamais réécrit tel quel.
   */
  agentBackend: z.enum(['sdk', 'claude-code', 'codex', 'opencode', 'cli']).transform((v) => (v === 'cli' ? 'claude-code' : v)).default('sdk'),
  /** Surcharge de modèle par phase pour `codex`/`opencode` ; absent, chaque CLI applique son défaut. */
  agentModels: z.strictObject({
    triage: z.string().min(1).max(100).optional(),
    implement: z.string().min(1).max(100).optional(),
  }).optional(),
  dataDir: homeOrAbsolute.default('~/.sisyphe'),
});
export type MachineConfig = z.infer<typeof MachineConfigSchema>;

/** Plafond historique, appliqué à une config `sdk` muette : sous clé API, le coût est facturé pour de bon. */
const SDK_DEFAULT_DAILY_BUDGET_USD = 60;

/**
 * Plafond quotidien réellement appliqué, ou `undefined` quand il n'y en a aucun.
 *
 * La valeur brute est conservée telle quelle dans `MachineConfig` et résolue ici, à l'usage, parce que tout
 * ce qui réécrit la configuration la recopie : résolue à la lecture, `sisyphe setup` graverait dans le fichier
 * un plafond de 60 jamais saisi dès qu'une config `sdk` sans plafond passe en CLI, et « aucun plafond »
 * deviendrait inexprimable sous `sdk`, où l'absence du champ vaut 60.
 */
export function effectiveDailyBudget(machine: Pick<MachineConfig, 'dailyBudgetUsd' | 'agentBackend'>): number | undefined {
  // `null` : plafond explicitement vidé depuis la page de réglages, quel que soit le backend.
  if (machine.dailyBudgetUsd === null) return undefined;
  if (machine.dailyBudgetUsd !== undefined) return machine.dailyBudgetUsd;
  // Champ absent : `sdk` garde le plafond historique — rien n'est désactivé en silence sur une config
  // existante ; les backends CLI n'en ont aucun, le coût y étant notionnel et non facturé.
  return machine.agentBackend === 'sdk' ? SDK_DEFAULT_DAILY_BUDGET_USD : undefined;
}

/**
 * Modèle à passer au runner pour une phase.
 *
 * `sdk` et `claude-code` gardent les modèles de `sisyphe.yml` (noms Claude). `codex` et `opencode` prennent
 * la surcharge machine `agentModels` ; absente, `undefined` laisse chaque CLI appliquer son propre défaut —
 * on ne leur impose jamais un nom de modèle Claude qui n'existerait pas chez eux.
 */
export function phaseModel(
  machine: Pick<MachineConfig, 'agentBackend' | 'agentModels'>,
  phase: 'triage' | 'implement',
  repoModel: string,
): string | undefined {
  if (machine.agentBackend === 'sdk' || machine.agentBackend === 'claude-code') return repoModel;
  return machine.agentModels?.[phase];
}

/**
 * Combinaison que `createApp` refuse au démarrage. Le message vit ici pour que le refus du démarrage et
 * celui de la page de réglages soient le même mot pour mot : la page doit dire ce que dirait le démarrage.
 */
export const SANDBOX_BACKEND_ERROR =
  "`sandbox: true` n'est supporté que par le backend `sdk` : mettre `sandbox: false` ou `agentBackend: sdk`";

export type MachineConfigErrorKind = 'missing' | 'invalid';

export class MachineConfigError extends Error {
  constructor(public readonly kind: MachineConfigErrorKind, message: string) {
    super(message);
    this.name = 'MachineConfigError';
  }
}

/**
 * Valide le YAML **sans développer les chemins** : la configuration telle qu'elle est écrite dans le fichier.
 *
 * C'est cette forme qu'il faut réécrire — celle de `parseMachineConfig` graverait `/Users/<nom>/.sisyphe`
 * dans un fichier qui disait `~/.sisyphe`, à la première réécriture et pour toujours. Pour s'en servir,
 * en revanche (ouvrir un fichier, calculer des chemins), c'est `parseMachineConfig` qu'il faut.
 */
export function parseMachineConfigAsWritten(yamlText: string): MachineConfig {
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
  return result.data;
}

/** La configuration prête à l'usage : chemins développés (`~/…` → absolu). */
export function parseMachineConfig(yamlText: string): MachineConfig {
  const c = parseMachineConfigAsWritten(yamlText);
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
