/**
 * Un workflow Jira quelconque, pour les tests.
 *
 * Volontairement générique : Sisyphe ne connaît aucun workflow et n'en impose aucun. Des libellés d'équipe
 * dans les fixtures finiraient par être lus comme la norme, et par se glisser dans les défauts du schéma —
 * ce qui est précisément ce qu'on a retiré.
 */
export const WORKFLOW = ['À faire', 'En analyse', 'Prêt', 'En cours', 'En revue', 'Terminé'];

export const jiraProject = (over: Record<string, unknown> = {}) => ({
  key: 'PROJ',
  accountId: 'acc-bot',
  repo: 'acme/demo',
  candidateStatuses: ['À faire', 'En analyse'],
  statusesInOrder: [...WORKFLOW],
  inProgressStatus: 'En cours',
  doneStatus: 'En revue',
  ...over,
});
