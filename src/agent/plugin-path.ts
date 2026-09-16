import { fileURLToPath } from 'node:url';
import type { AgentRunOptions } from './runner.js';

/** Nom du skill tel que l'option `skills` du SDK l'attend : qualifié par le plugin qui le porte. */
export const JIRA_SKILL = 'sisyphe:sisyphe-jira';

/**
 * Les outils natifs du run, `Skill` compris dès qu'un skill est demandé.
 *
 * Ce n'est pas un relâchement de la liste blanche : `allowedTools` — les outils auto-approuvés — reste
 * exactement ce que l'appelant a demandé, et le SDK y pose lui-même la permission `Skill(<nom>)` scopée au
 * seul skill listé. Ce qui s'élargit ici est l'autre liste, celle des outils qui *existent* pour l'agent :
 * sans `Skill` dedans, le skill se charge, apparaît dans `init.skills`, et reste malgré tout impossible à
 * invoquer — sans refus, sans erreur, l'agent conclut simplement qu'il n'existe pas (mesuré sur les deux
 * backends). C'est ici, et pas dans chaque phase, parce que l'option qui veut dire « cet agent a droit aux
 * skills » est `skills` : la faire dépendre d'un second réglage à épeler ailleurs referme le même piège.
 */
export function toolsWithSkill(o: Pick<AgentRunOptions, 'allowedTools' | 'skills'>): string[] {
  return o.skills?.length ? [...o.allowedTools, 'Skill'] : o.allowedTools;
}

/**
 * Le plugin livré avec Sisyphe. Il vit à la racine du dépôt (`agent-plugin/`), pas dans `dist/` : ce sont
 * des fichiers Markdown et JSON, `tsc` ne les copie pas, et un chemin calculé depuis `dist/agent/` reste
 * valide dans les deux cas — le paquet installé est le dépôt lui-même (`npm link`).
 */
export function agentPluginPath(): string {
  return fileURLToPath(new URL('../../agent-plugin', import.meta.url));
}
