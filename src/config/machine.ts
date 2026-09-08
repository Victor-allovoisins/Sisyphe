import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { expandHome } from './paths.js';

export const MachineConfigSchema = z.strictObject({
  github: z.strictObject({
    appId: z.number().int().positive(),
    installationId: z.number().int().positive(),
    privateKeyPath: z.string().min(1),
  }),
  repos: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'format attendu : owner/repo')).min(1),
  triggerLabel: z.string().min(1).default('sisyphe'),
  pollIntervalSeconds: z.number().int().min(10).default(60),
  maxConcurrentJobs: z.number().int().min(1).default(1),
  dailyBudgetUsd: z.number().positive().default(60),
  sandbox: z.boolean().default(false),
  dataDir: z.string().min(1).default('~/.sisyphe'),
});
export type MachineConfig = z.infer<typeof MachineConfigSchema>;

export class MachineConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MachineConfigError';
  }
}

export function parseMachineConfig(yamlText: string): MachineConfig {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (err) {
    throw new MachineConfigError(`config.yml : YAML illisible : ${(err as Error).message}`);
  }
  const result = MachineConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`)
      .join(' ; ');
    throw new MachineConfigError(`config.yml invalide : ${issues}`);
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
      throw new MachineConfigError(`Config machine absente : ${path}. Lancer \`sisyphe setup\`.`);
    }
    throw err;
  }
  return parseMachineConfig(text);
}
