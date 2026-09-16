import { describe, expect, it } from 'vitest';
import { JIRA_STATUSES_DEFAULT, type MachineConfig } from '../config/machine.js';
import { renderFailedComment } from '../deliver/comments.js';
import { relaunchFor } from './relaunch.js';

const project = {
  key: 'IOS',
  accountId: 'sisyphe-ios',
  repo: 'ILokYou/ILokYou-iOS',
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

describe('relaunchFor', () => {
  it('sans Jira, garde la consigne de label', () => {
    expect(relaunchFor(machine(), 'ILokYou/ILokYou-iOS')).toEqual({ kind: 'label', trigger: 'sisyphe' });
  });

  it('avec un projet Jira pour ce dépôt, demande une réassignation', () => {
    expect(relaunchFor(withJira, 'ILokYou/ILokYou-iOS')).toEqual({ kind: 'assignee', who: 'sisyphe-ios' });
  });

  it('un dépôt hors périmètre Jira retombe sur le label', () => {
    expect(relaunchFor(withJira, 'ILokYou/autre')).toEqual({ kind: 'label', trigger: 'sisyphe' });
  });
});

describe('le message de relance suit le traqueur', () => {
  it('parle de réassignation sur un ticket Jira, jamais de label', () => {
    const c = renderFailedComment('job-1', 'échec', relaunchFor(withJira, 'ILokYou/ILokYou-iOS'));
    expect(c).toContain('réassignez-le à `sisyphe-ios`');
    expect(c).not.toContain('label');
  });

  it('parle de label sur une issue GitHub', () => {
    const c = renderFailedComment('job-1', 'échec', relaunchFor(machine(), 'ILokYou/ILokYou-iOS'));
    expect(c).toContain('`sisyphe:failed`');
    expect(c).not.toContain('réassignez');
  });
});
