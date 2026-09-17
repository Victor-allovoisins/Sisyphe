import type { MachineConfig } from '../config/machine.js';
import { labelRelaunch, type Relaunch } from '../deliver/comments.js';
import type { IssueTracker } from '../github/source.js';

/**
 * Quelle consigne de relance imprimer pour ce dépôt. Un projet Jira configuré pour lui l'emporte : le
 * lecteur du message est alors sur un ticket, où aucun label `sisyphe` n'existe. Le compte nommé est celui
 * auquel il faut réassigner — le même que celui qui déclenche le traitement.
 *
 * Le traqueur n'est là que pour traduire l'`accountId` en nom affiché : le message est lu par celui qui a
 * signalé le bug, à qui `acc-…` ne dit rien. Sans traqueur, sans la méthode, ou sur un échec de résolution,
 * on ne nomme personne plutôt que d'imprimer l'identifiant.
 */
/**
 * La même décision, sans le nom : quel *genre* de consigne ce dépôt réclame. Sert de valeur de départ à
 * `runJob`, dont le prologue ne souffre aucun `await` — sans elle, un échec dans les deux instructions qui
 * précèdent la résolution imprimerait une consigne de label sur un ticket Jira, où aucun label n'existe.
 */
export function relaunchKindFor(machine: Pick<MachineConfig, 'triggerLabel' | 'jira'>, repo: string): Relaunch {
  const project = machine.jira?.projects.find((p) => p.repo === repo);
  return project ? { kind: 'assignee', who: null } : labelRelaunch(machine.triggerLabel);
}

export async function relaunchFor(
  machine: Pick<MachineConfig, 'triggerLabel' | 'jira'>,
  repo: string,
  tracker?: Pick<IssueTracker, 'accountName'>,
): Promise<Relaunch> {
  const project = machine.jira?.projects.find((p) => p.repo === repo);
  if (!project) return labelRelaunch(machine.triggerLabel);
  return { kind: 'assignee', who: (await tracker?.accountName?.(project.accountId)) ?? null };
}
