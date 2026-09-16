import { fileURLToPath } from 'node:url';

/** Nom du skill tel que l'option `skills` du SDK l'attend : qualifié par le plugin qui le porte. */
export const JIRA_SKILL = 'sisyphe:sisyphe-jira';

/**
 * Le plugin livré avec Sisyphe. Il vit à la racine du dépôt (`agent-plugin/`), pas dans `dist/` : ce sont
 * des fichiers Markdown et JSON, `tsc` ne les copie pas, et un chemin calculé depuis `dist/agent/` reste
 * valide dans les deux cas — le paquet installé est le dépôt lui-même (`npm link`).
 */
export function agentPluginPath(): string {
  return fileURLToPath(new URL('../../agent-plugin', import.meta.url));
}
