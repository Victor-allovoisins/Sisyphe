import { describe, expect, it, vi } from 'vitest';
import { parseRepo, type IssueRef } from '../../github/source.js';
import { parseJiraArgv, runJiraVerb, type JiraCli } from './jira.js';

const ref: IssueRef = { repo: parseRepo('acme/ios'), number: 886 };

function fake(over: Partial<JiraCli> = {}): JiraCli {
  return {
    refFromKey: () => ref,
    getIssue: async () => ({
      repo: ref.repo, number: 886, title: 'Couleur', body: 'corps', author: 'Victor',
      state: 'open', labels: [], comments: [],
      tracker: { key: 'IOS-886', issueType: 'Bug', fixVersions: [], status: 'En développement' },
    }),
    listTransitions: async () => [{ id: '31', to: { name: 'En relecture' } }],
    transitionTo: async () => ({ hops: ['A relire', 'En relecture'] }),
    comment: async () => undefined,
    addTriggerLabel: async () => undefined,
    removeTriggerLabel: async () => undefined,
    get: async () => ({ values: [] }),
    ...over,
  };
}

describe('runJiraVerb', () => {
  it('show rend le ticket en JSON, statut et clé compris', async () => {
    const out = await runJiraVerb(fake(), { verb: 'show', key: 'IOS-886' });
    expect(JSON.parse(out)).toMatchObject({ key: 'IOS-886', status: 'En développement', title: 'Couleur' });
  });

  it('transitions liste les statuts atteignables, pas les noms de transition', async () => {
    const out = await runJiraVerb(fake(), { verb: 'transitions', key: 'IOS-886' });
    expect(JSON.parse(out)).toEqual([{ id: '31', to: 'En relecture' }]);
  });

  it('transition rend la suite des sauts effectués', async () => {
    const out = await runJiraVerb(fake(), { verb: 'transition', key: 'IOS-886', target: 'En relecture' });
    expect(out).toContain('A relire → En relecture');
  });

  it('comment refuse un corps vide plutôt que de poster du vide', async () => {
    await expect(runJiraVerb(fake(), { verb: 'comment', key: 'IOS-886', body: '   ' })).rejects.toThrow(/vide/i);
  });

  it('assign --back rend le ticket, assign --bot le reprend', async () => {
    const back = vi.fn(async () => undefined);
    const bot = vi.fn(async () => undefined);
    await runJiraVerb(fake({ removeTriggerLabel: back }), { verb: 'assign', key: 'IOS-886', to: 'back' });
    await runJiraVerb(fake({ addTriggerLabel: bot }), { verb: 'assign', key: 'IOS-886', to: 'bot' });
    expect(back).toHaveBeenCalledOnce();
    expect(bot).toHaveBeenCalledOnce();
  });

  it('get passe le chemin au client, qui décide de l’accepter', async () => {
    const get = vi.fn(async () => ({ values: [] }));
    await runJiraVerb(fake({ get }), { verb: 'get', path: '/rest/api/3/issue/IOS-886/changelog' });
    expect(get).toHaveBeenCalledWith('/rest/api/3/issue/IOS-886/changelog');
  });
});

describe('parseJiraArgv', () => {
  it('assign sans drapeau lève une erreur qui nomme les deux choix', () => {
    expect(() => parseJiraArgv(['assign', 'IOS-886'])).toThrow(/--back/);
    expect(() => parseJiraArgv(['assign', 'IOS-886'])).toThrow(/--bot/);
  });

  it('assign avec les deux drapeaux lève aussi : un choix ambigu n’est pas un choix', () => {
    expect(() => parseJiraArgv(['assign', 'IOS-886', '--back', '--bot'])).toThrow(/--back/);
  });

  it('assign --back / --bot produisent la cible attendue', () => {
    expect(parseJiraArgv(['assign', 'IOS-886', '--back'])).toEqual({ verb: 'assign', key: 'IOS-886', to: 'back' });
    expect(parseJiraArgv(['assign', 'IOS-886', '--bot'])).toEqual({ verb: 'assign', key: 'IOS-886', to: 'bot' });
  });

  it('comment reçoit le corps déjà lu, sans toucher à stdin', () => {
    expect(parseJiraArgv(['comment', 'IOS-886'], { body: 'texte' })).toEqual({ verb: 'comment', key: 'IOS-886', body: 'texte' });
  });

  it('transition exige la clé et la cible', () => {
    expect(parseJiraArgv(['transition', 'IOS-886', 'En relecture'])).toEqual({ verb: 'transition', key: 'IOS-886', target: 'En relecture' });
    expect(() => parseJiraArgv(['transition', 'IOS-886'])).toThrow(/statut cible/);
  });

  it('un verbe inconnu liste les verbes valides', () => {
    expect(() => parseJiraArgv(['bricoler'])).toThrow(/show, transitions, transition, comment, assign, get/);
  });
});
