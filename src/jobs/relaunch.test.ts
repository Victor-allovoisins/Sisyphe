import { describe, expect, it } from 'vitest';
import { JIRA_STATUSES_DEFAULT, type MachineConfig } from '../config/machine.js';
import { renderFailedComment } from '../deliver/comments.js';
import { relaunchFor, relaunchKindFor } from './relaunch.js';

const REPO = 'ILokYou/ILokYou-iOS';

const project = {
  key: 'IOS',
  accountId: 'acc-sisyphe-ios',
  repo: REPO,
  candidateStatuses: ['Nouveau'],
  statusesInOrder: [...JIRA_STATUSES_DEFAULT],
  inProgressStatus: 'En développement',
  doneStatus: 'En relecture',
};

const machine = (jira?: MachineConfig['jira']): Pick<MachineConfig, 'triggerLabel' | 'jira'> => ({ triggerLabel: 'sisyphe', jira });

const withJira = machine({
  site: 'allovoisins.atlassian.net',
  email: 'bot@example.test',
  apiTokenPath: '/dev/null',
  projects: [project],
});

const named = (name: string | null) => ({ accountName: async () => name });

describe('relaunchFor', () => {
  it('sans Jira, garde la consigne de label', async () => {
    expect(await relaunchFor(machine(), REPO)).toEqual({ kind: 'label', trigger: 'sisyphe' });
  });

  it('nomme le compte par son nom affiché', async () => {
    const r = await relaunchFor(withJira, REPO, named('Sisyphe iOS'));
    expect(r).toEqual({ kind: 'assignee', who: 'Sisyphe iOS' });
  });

  it('sans nom résoluble, ne nomme personne plutôt qu’un identifiant', async () => {
    const r = await relaunchFor(withJira, REPO, named(null));
    expect(r).toEqual({ kind: 'assignee', who: null });
    expect(renderFailedComment('job-1', 'échec', r)).not.toContain('acc-');
  });

  it('un traqueur qui ne sait pas nommer un compte ne nomme personne', async () => {
    expect(await relaunchFor(withJira, REPO, {})).toEqual({ kind: 'assignee', who: null });
  });

  it('un dépôt hors périmètre Jira retombe sur le label', async () => {
    expect(await relaunchFor(withJira, 'ILokYou/autre', named('Sisyphe iOS'))).toEqual({ kind: 'label', trigger: 'sisyphe' });
  });
});

describe('relaunchKindFor', () => {
  it('porte le bon genre de consigne sans interroger personne', () => {
    // Valeur de départ du prologue de `runJob`, qui ne souffre aucun await : elle doit déjà parler
    // d'assignation sur un dépôt Jira, sinon un échec précoce imprimerait un label sur un ticket.
    expect(relaunchKindFor(withJira, REPO)).toEqual({ kind: 'assignee', who: null });
    expect(relaunchKindFor(withJira, 'ILokYou/autre')).toEqual({ kind: 'label', trigger: 'sisyphe' });
    expect(relaunchKindFor(machine(), REPO)).toEqual({ kind: 'label', trigger: 'sisyphe' });
  });

  it('ne promet jamais de label au lecteur d’un ticket Jira', () => {
    expect(renderFailedComment('job-1', 'échec', relaunchKindFor(withJira, REPO))).not.toContain('label');
  });
});

describe('le message de relance suit le traqueur', () => {
  it('parle de réassignation sur un ticket Jira, jamais de label', async () => {
    const c = renderFailedComment('job-1', 'échec', await relaunchFor(withJira, REPO, named('Sisyphe iOS')));
    expect(c).toContain('réassignez-le à Sisyphe iOS');
    expect(c).not.toContain('label');
  });

  it('parle de label sur une issue GitHub', async () => {
    const c = renderFailedComment('job-1', 'échec', await relaunchFor(machine(), REPO));
    expect(c).toContain('`sisyphe:failed`');
    expect(c).not.toContain('réassignez');
  });
});
