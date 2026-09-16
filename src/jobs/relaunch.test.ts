import { describe, expect, it } from 'vitest';
import type { MachineConfig } from '../config/machine.js';
import { jiraProject } from '../../test/fakes/jira-workflow.js';
import { renderFailedComment } from '../deliver/comments.js';
import { relaunchFor } from './relaunch.js';

const project = jiraProject();

const machine = (jira?: MachineConfig['jira']): Pick<MachineConfig, 'triggerLabel' | 'jira'> => ({ triggerLabel: 'sisyphe', jira });

const withJira = machine({
  site: 'acme.atlassian.net',
  email: 'bot@example.test',
  apiTokenPath: '/dev/null',
  projects: [project],
});

describe('relaunchFor', () => {
  it('sans Jira, garde la consigne de label', () => {
    expect(relaunchFor(machine(), 'acme/demo')).toEqual({ kind: 'label', trigger: 'sisyphe' });
  });

  it('avec un projet Jira pour ce dépôt, demande une réassignation', () => {
    expect(relaunchFor(withJira, 'acme/demo')).toEqual({ kind: 'assignee', who: 'acc-bot' });
  });

  it('un dépôt hors périmètre Jira retombe sur le label', () => {
    expect(relaunchFor(withJira, 'acme/autre')).toEqual({ kind: 'label', trigger: 'sisyphe' });
  });
});

describe('le message de relance suit le traqueur', () => {
  it('parle de réassignation sur un ticket Jira, jamais de label', () => {
    const c = renderFailedComment('job-1', 'échec', relaunchFor(withJira, 'acme/demo'));
    expect(c).toContain('réassignez-le à `acc-bot`');
    expect(c).not.toContain('label');
  });

  it('parle de label sur une issue GitHub', () => {
    const c = renderFailedComment('job-1', 'échec', relaunchFor(machine(), 'acme/demo'));
    expect(c).toContain('`sisyphe:failed`');
    expect(c).not.toContain('réassignez');
  });
});
