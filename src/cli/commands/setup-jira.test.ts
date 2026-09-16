import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseMachineConfig } from '../../config/machine.js';
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

describe('isYes', () => {
  it('accepte les formes courantes et rien d’autre', () => {
    for (const y of ['o', 'O', 'oui', 'y', 'YES']) expect(isYes(y)).toBe(true);
    for (const n of ['n', 'non', '', 'peut-être']) expect(isYes(n)).toBe(false);
  });
});

describe('askJira', () => {
  it('ne demande rien de plus quand on répond non', async () => {
    const s = scripted(['n']);
    expect(await askJira({ ...s, repos: ['ILokYou/ILokYou-iOS'], dataDir: dir })).toBeUndefined();
    expect(s.asked).toHaveLength(1);
  });

  it('construit la section et résout l’accountId depuis une adresse', async () => {
    const lookup = found(1);
    const s = scripted(['o', 'allovoisins.atlassian.net', 'bot@example.test', tokenPath, 'ios', 'bot@example.test']);
    const jira = await askJira({ ...s, repos: ['ILokYou/ILokYou-iOS'], dataDir: dir, lookup });

    expect(jira?.site).toBe('allovoisins.atlassian.net');
    expect(jira?.projects).toEqual([
      expect.objectContaining({ key: 'IOS', accountId: 'acc-1', repo: 'ILokYou/ILokYou-iOS', inProgressStatus: 'En développement', doneStatus: 'En relecture' }),
    ]);
    // Le jeton sert à la recherche, il n'est jamais recopié dans la configuration.
    expect(JSON.stringify(jira)).not.toContain('jeton');
    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ apiToken: 'jeton' }), 'bot@example.test');
  });

  it('fait choisir quand plusieurs comptes répondent', async () => {
    const s = scripted(['o', 'allovoisins.atlassian.net', 'bot@example.test', tokenPath, 'IOS', 'sisyphe', '2']);
    const jira = await askJira({ ...s, repos: ['ILokYou/ILokYou-iOS'], dataDir: dir, lookup: found(3) });
    expect(jira?.projects[0].accountId).toBe('acc-2');
  });

  it('laisse un dépôt sur les issues GitHub quand aucun projet n’est donné', async () => {
    const s = scripted(['o', 'allovoisins.atlassian.net', 'bot@example.test', tokenPath, '', '']);
    const jira = await askJira({ ...s, repos: ['ILokYou/a', 'ILokYou/b'], dataDir: dir, lookup: found(1) });
    expect(jira).toBeUndefined();
  });

  it('accepte un accountId à la main quand Jira est injoignable', async () => {
    const lookup = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const s = scripted(['o', 'allovoisins.atlassian.net', 'bot@example.test', tokenPath, 'IOS', 'sisyphe', 'acc-saisi']);
    const jira = await askJira({ ...s, repos: ['ILokYou/ILokYou-iOS'], dataDir: dir, lookup });
    expect(jira?.projects[0].accountId).toBe('acc-saisi');
  });

  it('écrit le jeton collé quand le fichier n’existe pas, en 0600', async () => {
    const missing = join(dir, 'pas-encore', 'jira-token.txt');
    const s = scripted(['o', 'allovoisins.atlassian.net', 'bot@example.test', missing, 'jeton-collé', 'IOS', 'robot']);
    const jira = await askJira({ ...s, repos: ['ILokYou/ILokYou-iOS'], dataDir: dir, lookup: found(1) });

    expect(jira?.apiTokenPath).toBe(missing);
    expect((await readFile(missing, 'utf8')).trim()).toBe('jeton-collé');
    // Un mot de passe : lisible par son seul propriétaire.
    expect((await stat(missing)).mode & 0o777).toBe(0o600);
    // Et jamais recopié dans la configuration.
    expect(JSON.stringify(jira)).not.toContain('jeton-collé');
  });

  it('reprend un jeton déjà en place sans rien demander', async () => {
    const s = scripted(['o', 'allovoisins.atlassian.net', 'bot@example.test', tokenPath, 'IOS', 'robot']);
    const lookup = found(1);
    await askJira({ ...s, repos: ['ILokYou/ILokYou-iOS'], dataDir: dir, lookup });

    expect(lookup).toHaveBeenCalledWith(expect.objectContaining({ apiToken: 'jeton' }), 'robot');
    expect(s.asked.join('\n')).not.toContain('Coller le jeton');
  });
});

describe('buildRawConfig', () => {
  const answers = { appId: 1, installationId: 2, privateKeyPath: '/dev/null', repos: ['ILokYou/ILokYou-iOS'], dataDir: '~/.sisyphe', agentBackend: 'claude-code' as const };

  it('conserve une section jira existante quand setup n’en construit pas de neuve', () => {
    const existing = parseMachineConfig(`
github: { appId: 1, installationId: 2, privateKeyPath: /dev/null }
repos: [ILokYou/ILokYou-iOS]
jira:
  site: allovoisins.atlassian.net
  email: bot@example.test
  apiTokenPath: /dev/null
  projects:
    - { key: IOS, accountId: acc-1, repo: ILokYou/ILokYou-iOS }
`);
    const raw = buildRawConfig(answers, existing) as { jira?: { projects: { key: string }[] } };
    expect(raw.jira?.projects[0].key).toBe('IOS');
  });

  it('écrit la section neuve quand setup vient d’en produire une', () => {
    const jira = { site: 'allovoisins.atlassian.net', email: 'bot@example.test', apiTokenPath: '/dev/null', projects: [] as never[] };
    const raw = buildRawConfig({ ...answers, jira: jira as never }, undefined) as { jira?: { site: string } };
    expect(raw.jira?.site).toBe('allovoisins.atlassian.net');
  });
});
