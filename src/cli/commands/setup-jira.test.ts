import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMachineConfig } from '../../config/machine.js';
import { jiraProject } from '../../../test/fakes/jira-workflow.js';
import { askJira, buildRawConfig, isYes } from './setup.js';

let dir: string;
let tokenPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sisyphe-setup-jira-'));
  tokenPath = join(dir, 'jira-token.txt');
  await writeFile(tokenPath, 'jeton\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Répond aux questions dans l'ordre où elles arrivent ; une question de trop fait échouer le test. */
function scripted(answers: string[]) {
  const asked: string[] = [];
  let i = 0;
  const next = (q: string) => {
    asked.push(q);
    if (i >= answers.length) throw new Error(`question inattendue : ${q}`);
    return answers[i++];
  };
  return {
    asked,
    ask: async (q: string) => next(q),
    askValidated: async (q: string, validate: (v: string) => string | null | Promise<string | null>) => {
      const v = next(q);
      const err = await validate(v);
      if (err) throw new Error(`réponse refusée « ${v} » : ${err}`);
      return v;
    },
  };
}

const found = (n: number) =>
  vi.fn(async () => Array.from({ length: n }, (_, i) => ({ accountId: `acc-${i + 1}`, displayName: `Compte ${i + 1}`, emailAddress: `c${i + 1}@x.test` })));

/** Les statuts que le projet déclare : proposés à l'humain, jamais appliqués tels quels. */
const statuses = vi.fn(async () => ['À faire', 'En analyse', 'Prêt', 'En cours', 'En revue', 'Terminé']);

/** Les quatre réponses de workflow, dans l'ordre où askWorkflow les demande. */
const WORKFLOW_ANSWERS = ['À faire, En analyse, Prêt, En cours, En revue, Terminé', 'À faire, En analyse', 'En cours', 'En revue'];

describe('isYes', () => {
  it('accepte les formes courantes et rien d’autre', () => {
    for (const y of ['o', 'O', 'oui', 'y', 'YES']) expect(isYes(y)).toBe(true);
    for (const n of ['n', 'non', '', 'peut-être']) expect(isYes(n)).toBe(false);
  });
});

describe('askJira', () => {
  it('ne demande rien de plus quand on répond non', async () => {
    const s = scripted(['n']);
    expect(await askJira({ ...s, repos: ['acme/demo'], dataDir: dir })).toBeUndefined();
    expect(s.asked).toHaveLength(1);
  });

  it('construit la section et résout l’accountId depuis une adresse', async () => {
    const lookup = found(1);
    const s = scripted(['o', 'acme.atlassian.net', 'bot@example.test', tokenPath, 'proj', 'robot@example.test', ...WORKFLOW_ANSWERS]);
    const jira = await askJira({ ...s, repos: ['acme/demo'], dataDir: dir, lookup, statuses });

    expect(jira?.site).toBe('acme.atlassian.net');
    expect(jira?.projects).toEqual([
      expect.objectContaining({ key: 'PROJ', accountId: 'acc-1', repo: 'acme/demo', inProgressStatus: 'En cours', doneStatus: 'En revue' }),
    ]);
    // Le jeton sert à la recherche, il n'est jamais recopié dans la configuration.
    expect(JSON.stringify(jira)).not.toContain('jeton');
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ apiToken: 'jeton' }), 'robot@example.test');
  });

  it('fait choisir quand plusieurs comptes répondent', async () => {
    const s = scripted(['o', 'acme.atlassian.net', 'bot@example.test', tokenPath, 'PROJ', 'robot', '2', ...WORKFLOW_ANSWERS]);
    const jira = await askJira({ ...s, repos: ['acme/demo'], dataDir: dir, lookup: found(3), statuses });
    expect(jira?.projects[0].accountId).toBe('acc-2');
  });

  it('laisse un dépôt sur les issues GitHub quand aucun projet n’est donné', async () => {
    const s = scripted(['o', 'acme.atlassian.net', 'bot@example.test', tokenPath, '', '']);
    const jira = await askJira({ ...s, repos: ['acme/a', 'acme/b'], dataDir: dir, lookup: found(1), statuses });
    expect(jira).toBeUndefined();
  });

  it('accepte un accountId à la main quand Jira est injoignable', async () => {
    const lookup = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const s = scripted(['o', 'acme.atlassian.net', 'bot@example.test', tokenPath, 'PROJ', 'robot', 'acc-saisi', ...WORKFLOW_ANSWERS]);
    const jira = await askJira({ ...s, repos: ['acme/demo'], dataDir: dir, lookup, statuses });
    expect(jira?.projects[0].accountId).toBe('acc-saisi');
  });
});

describe('buildRawConfig', () => {
  const answers = { appId: 1, installationId: 2, privateKeyPath: '/dev/null', repos: ['acme/demo'], dataDir: '~/.sisyphe', agentBackend: 'claude-code' as const };

  it('conserve une section jira existante quand setup n’en construit pas de neuve', () => {
    const existing = parseMachineConfig(JSON.stringify({
      github: { appId: 1, installationId: 2, privateKeyPath: '/dev/null' },
      repos: ['acme/demo'],
      jira: { site: 'acme.atlassian.net', email: 'bot@example.test', apiTokenPath: '/dev/null', projects: [jiraProject()] },
    }));
    const raw = buildRawConfig(answers, existing) as { jira?: { projects: { key: string }[] } };
    expect(raw.jira?.projects[0].key).toBe('PROJ');
  });

  it('écrit la section neuve quand setup vient d’en produire une', () => {
    const jira = { site: 'acme.atlassian.net', email: 'bot@example.test', apiTokenPath: '/dev/null', projects: [] as never[] };
    const raw = buildRawConfig({ ...answers, jira: jira as never }, undefined) as { jira?: { site: string } };
    expect(raw.jira?.site).toBe('acme.atlassian.net');
  });
});
