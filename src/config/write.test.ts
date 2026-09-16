import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { SANDBOX_BACKEND_ERROR, loadMachineConfig, parseMachineConfig, type MachineConfig } from './machine.js';
import { expandHome } from './paths.js';
import { validateMachineConfigInput, writeMachineConfig, type ConfigIssue, type ValidateMachineConfigResult } from './write.js';

let dir: string;
let configPath: string;
let keyPath: string;
/** La config actuellement sur disque, telle que l'interface l'a lue : chemins développés par `parseMachineConfig`. */
let current: MachineConfig;

/** Un corps tel que la page de réglages le poste : des chemins absolus, aucun champ optionnel de trop. */
const rawInput = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  github: { appId: 12, installationId: 34, privateKeyPath: keyPath },
  repos: ['ILokYou/ILokYou-iOS'],
  dataDir: dir,
  ...over,
});

const expectOk = (r: ValidateMachineConfigResult): MachineConfig => {
  if (!r.ok) throw new Error(`refus inattendu : ${JSON.stringify(r.issues)}`);
  return r.config;
};

const expectIssues = (r: ValidateMachineConfigResult): ConfigIssue[] => {
  if (r.ok) throw new Error('acceptation inattendue');
  return r.issues;
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sisyphe-write-'));
  configPath = join(dir, 'config.yml');
  keyPath = join(dir, 'app.pem');
  await writeFile(keyPath, 'clé factice');
  current = parseMachineConfig(stringify(rawInput()));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('validateMachineConfigInput', () => {
  it('accepte une configuration valide', async () => {
    const config = expectOk(await validateMachineConfigInput(rawInput({ maxConcurrentJobs: 3, sandbox: true }), current));
    expect(config.maxConcurrentJobs).toBe(3);
    expect(config.repos).toEqual(['ILokYou/ILokYou-iOS']);
  });

  it("reconnaît ~ et sa forme développée comme le même dataDir, et n'en écrit pas l'expansion", async () => {
    const home = { ...current, dataDir: expandHome('~/.sisyphe') };
    const config = expectOk(await validateMachineConfigInput(rawInput({ dataDir: '~/.sisyphe' }), home));
    expect(config.dataDir).toBe('~/.sisyphe');
  });

  it('conserve la section jira que la page ne renvoie pas : enregistrer un budget ne doit pas l’effacer', async () => {
    const tokenPath = join(dir, 'jira-token.txt');
    await writeFile(tokenPath, 'jeton');
    const jira = {
      site: 'allovoisins.atlassian.net',
      email: 'bot@allovoisins.com',
      apiTokenPath: tokenPath,
      projects: [{ key: 'IOS', accountId: 'acc-sisyphe', repo: 'ILokYou/ILokYou-iOS' }],
    };
    const withJira = parseMachineConfig(stringify({ ...rawInput(), jira }));
    // Le corps posté par la page n'a pas de clé `jira` du tout.
    const config = expectOk(await validateMachineConfigInput(rawInput({ maxConcurrentJobs: 2 }), withJira));
    expect(config.jira?.projects[0].key).toBe('IOS');
    expect(config.jira?.projects[0].inProgressStatus).toBe('En développement');
    expect(config.maxConcurrentJobs).toBe(2);
  });

  it('refuse un jeton Jira introuvable', async () => {
    const jira = {
      site: 'allovoisins.atlassian.net',
      email: 'bot@allovoisins.com',
      apiTokenPath: join(dir, 'absent.txt'),
      projects: [{ key: 'IOS', accountId: 'acc-sisyphe', repo: 'ILokYou/ILokYou-iOS' }],
    };
    const issues = expectIssues(await validateMachineConfigInput(rawInput({ jira }), current));
    expect(issues.map((i) => i.path)).toContain('jira.apiTokenPath');
  });

  it('remonte les messages de zod, chemin par chemin', async () => {
    const issues = expectIssues(
      await validateMachineConfigInput(
        rawInput({ github: { appId: 0, installationId: 34, privateKeyPath: keyPath }, repos: ['a/b', 'pasdeslash'] }),
        current,
      ),
    );
    expect(issues).toHaveLength(2);
    expect(issues.map((i) => i.path)).toContain('github.appId');
    expect(issues.find((i) => i.path === 'repos.1')?.message).toBe('format attendu : owner/repo');
  });

  it("refuse un corps qui n'est pas un objet", async () => {
    expect(expectIssues(await validateMachineConfigInput(null, current))[0]?.path).toBe('(racine)');
  });

  it('refuse un dataDir modifié', async () => {
    const issues = expectIssues(await validateMachineConfigInput(rawInput({ dataDir: join(dir, 'ailleurs') }), current));
    expect(issues).toEqual([{ path: 'dataDir', message: expect.stringContaining('sisyphe setup') }]);
  });

  it('refuse une clé privée illisible', async () => {
    const absente = join(dir, 'absente.pem');
    const issues = expectIssues(
      await validateMachineConfigInput(rawInput({ github: { appId: 12, installationId: 34, privateKeyPath: absente } }), current),
    );
    expect(issues).toEqual([{ path: 'github.privateKeyPath', message: expect.stringContaining(absente) }]);
  });

  it('refuse une clé privée qui est un dossier', async () => {
    // `access(…, R_OK)` réussit sur un dossier : sans le test de type, un chemin de dossier passerait.
    const dossier = join(dir, 'cles');
    await mkdir(dossier);
    const issues = expectIssues(
      await validateMachineConfigInput(rawInput({ github: { appId: 12, installationId: 34, privateKeyPath: dossier } }), current),
    );
    expect(issues).toEqual([{ path: 'github.privateKeyPath', message: expect.stringContaining(dossier) }]);
  });

  it('refuse sandbox pour tout backend autre que sdk, du même refus que le démarrage', async () => {
    // `createApp` refuse cette paire : l'accepter ici enregistrerait une config que le prochain démarrage
    // rejette, avec un bandeau « Redémarrer » qui mène droit dans la panne.
    for (const backend of ['claude-code', 'codex', 'opencode'] as const) {
      const issues = expectIssues(await validateMachineConfigInput(rawInput({ sandbox: true, agentBackend: backend }), current));
      expect(issues).toEqual([{ path: 'sandbox', message: SANDBOX_BACKEND_ERROR }]);
      // Sans sandbox, le backend passe.
      expect(expectOk(await validateMachineConfigInput(rawInput({ sandbox: false, agentBackend: backend }), current)).sandbox).toBe(false);
    }
    expect(expectOk(await validateMachineConfigInput(rawInput({ sandbox: true, agentBackend: 'sdk' }), current)).sandbox).toBe(true);
  });

  it('cumule les règles locales', async () => {
    const issues = expectIssues(
      await validateMachineConfigInput(
        rawInput({
          dataDir: join(dir, 'ailleurs'),
          github: { appId: 12, installationId: 34, privateKeyPath: join(dir, 'absente.pem') },
          sandbox: true,
          agentBackend: 'claude-code',
        }),
        current,
      ),
    );
    expect(issues.map((i) => i.path)).toEqual(['dataDir', 'github.privateKeyPath', 'sandbox']);
  });

  it('ne joue pas les règles locales quand le schéma échoue', async () => {
    // dataDir déplacé et clé absente aussi, mais on ne rend que ce que zod a dit : les règles locales
    // supposent des champs déjà typés.
    const issues = expectIssues(
      await validateMachineConfigInput(
        rawInput({
          maxConcurrentJobs: 100,
          dataDir: join(dir, 'ailleurs'),
          github: { appId: 12, installationId: 34, privateKeyPath: join(dir, 'absente.pem') },
        }),
        current,
      ),
    );
    expect(issues.map((i) => i.path)).toEqual(['maxConcurrentJobs']);
  });
});

describe('writeMachineConfig', () => {
  it("écrit une configuration relue à l'identique, en 0600", async () => {
    const config = expectOk(await validateMachineConfigInput(rawInput({ triggerLabel: 'agent', pollIntervalSeconds: 120 }), current));
    await writeMachineConfig(configPath, config);
    expect(await loadMachineConfig(configPath)).toEqual(config);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it('conserve les trois formes du plafond quotidien', async () => {
    const write = async (over?: Record<string, unknown>): Promise<string> => {
      await writeMachineConfig(configPath, expectOk(await validateMachineConfigInput(rawInput(over), current)));
      return readFile(configPath, 'utf8');
    };
    // Absent : le champ ne doit jamais être matérialisé, sinon une config `sdk` muette se verrait graver
    // le plafond de 60 qu'elle n'a jamais saisi.
    expect(await write()).not.toContain('dailyBudgetUsd');
    expect((await loadMachineConfig(configPath)).dailyBudgetUsd).toBeUndefined();
    // Vidé depuis la page : `null` traverse le YAML sans ambiguïté.
    expect(await write({ dailyBudgetUsd: null })).toContain('dailyBudgetUsd: null');
    expect((await loadMachineConfig(configPath)).dailyBudgetUsd).toBeNull();
    expect(await write({ dailyBudgetUsd: 12.5 })).toContain('dailyBudgetUsd: 12.5');
    expect((await loadMachineConfig(configPath)).dailyBudgetUsd).toBe(12.5);
    // Et retour à l'absence : la ligne disparaît du fichier.
    expect(await write()).not.toContain('dailyBudgetUsd');
  });

  it("écrit les chemins tels qu'ils ont été fournis, sans développer ~", async () => {
    await writeMachineConfig(configPath, {
      ...current,
      dataDir: '~/.sisyphe',
      github: { ...current.github, privateKeyPath: '~/.sisyphe/cle.pem' },
    });
    const raw = parse(await readFile(configPath, 'utf8'));
    expect(raw.dataDir).toBe('~/.sisyphe');
    expect(raw.github.privateKeyPath).toBe('~/.sisyphe/cle.pem');
  });

  it('sauvegarde la version précédente en .bak (0600), et rien à la première écriture', async () => {
    const backup = `${configPath}.bak`;
    await writeMachineConfig(configPath, expectOk(await validateMachineConfigInput(rawInput(), current)));
    await expect(stat(backup)).rejects.toThrow();

    // Une config posée à la main peut être en 0644 : la copie ne doit pas hériter de ce mode.
    await chmod(configPath, 0o644);
    await writeMachineConfig(configPath, expectOk(await validateMachineConfigInput(rawInput({ repos: ['a/b'] }), current)));
    expect(parse(await readFile(backup, 'utf8')).repos).toEqual(['ILokYou/ILokYou-iOS']);
    expect((await loadMachineConfig(configPath)).repos).toEqual(['a/b']);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("un échec d'écriture ne fait tourner ni le fichier ni sa sauvegarde", async () => {
    const backup = `${configPath}.bak`;
    await writeMachineConfig(configPath, expectOk(await validateMachineConfigInput(rawInput(), current)));
    await writeMachineConfig(configPath, expectOk(await validateMachineConfigInput(rawInput({ repos: ['a/b'] }), current)));

    // Dossier en lecture seule : le temporaire ne peut plus être créé. Le `.bak`, lui, existe déjà et reste
    // ouvrable en écriture — c'est exactement ce qui le ferait tourner pour rien si on le copiait trop tôt.
    await chmod(dir, 0o500);
    await expect(writeMachineConfig(configPath, expectOk(await validateMachineConfigInput(rawInput({ repos: ['c/d'] }), current)))).rejects.toThrow();
    await chmod(dir, 0o700);

    expect((await loadMachineConfig(configPath)).repos).toEqual(['a/b']);
    expect(parse(await readFile(backup, 'utf8')).repos).toEqual(['ILokYou/ILokYou-iOS']);
  });

  it('ne laisse aucun fichier temporaire après un succès', async () => {
    const config = expectOk(await validateMachineConfigInput(rawInput(), current));
    await writeMachineConfig(configPath, config);
    await writeMachineConfig(configPath, config);
    // Le dossier entier, pas un filtre sur le nom des temporaires : renommer le préfixe ne doit pas
    // transformer cette assertion en tautologie qui passe pour la mauvaise raison.
    expect((await readdir(dir)).sort()).toEqual(['app.pem', 'config.yml', 'config.yml.bak']);
  });

  it('supprime le temporaire quand le remplacement échoue', async () => {
    const config = expectOk(await validateMachineConfigInput(rawInput(), current));
    // Un dossier là où le fichier de config est attendu : le temporaire est bien écrit, c'est seulement
    // ensuite que ça casse. Sans ménage, il resterait dans le dossier de données que l'interface affiche.
    await mkdir(configPath);
    await writeFile(join(configPath, 'occupant'), 'x');
    await expect(writeMachineConfig(configPath, config)).rejects.toThrow();
    expect((await readdir(dir)).sort()).toEqual(['app.pem', 'config.yml']);
  });
});
