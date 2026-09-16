import type { MachineConfig } from '../config/machine.js';
import { labelRelaunch, type Relaunch } from '../deliver/comments.js';

/**
 * Quelle consigne de relance imprimer pour ce dépôt. Un projet Jira configuré pour lui l'emporte : le
 * lecteur du message est alors sur un ticket, où aucun label `sisyphe` n'existe. Le compte nommé est celui
 * auquel il faut réassigner — le même que celui qui déclenche le traitement.
 */
export function relaunchFor(machine: Pick<MachineConfig, 'triggerLabel' | 'jira'>, repo: string): Relaunch {
  const project = machine.jira?.projects.find((p) => p.repo === repo);
  if (project) return { kind: 'assignee', who: project.accountId };
  return labelRelaunch(machine.triggerLabel);
}
