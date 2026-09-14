import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { effectiveDailyBudget, loadMachineConfig, MachineConfigError, parseMachineConfig } from './machine.js';

const minimal = `
github:
  appId: 12
  installationId: 34
  privateKeyPath: ~/.sisyphe/app.pem
repos:
  - ILokYou/ILokYou-iOS
`;

describe('parseMachineConfig', () => {
  it('applique les défauts et développe les chemins', () => {
    const c = parseMachineConfig(minimal);
    expect(c.triggerLabel).toBe('sisyphe');
    expect(c.pollIntervalSeconds).toBe(60);
    expect(c.maxConcurrentJobs).toBe(1);
    expect(c.sandbox).toBe(false);
    expect(c.agentBackend).toBe('sdk');
    expect(c.dataDir).toBe(join(homedir(), '.sisyphe'));
    expect(c.github.privateKeyPath).toBe(join(homedir(), '.sisyphe/app.pem'));
  });

  it('conserve la valeur brute du plafond quotidien, et refuse 0', () => {
    // Aucune résolution à la lecture : ce que le fichier dit est ce que la config porte.
    expect(parseMachineConfig(minimal).dailyBudgetUsd).toBeUndefined();
    expect(parseMachineConfig(`${minimal}dailyBudgetUsd: null\n`).dailyBudgetUsd).toBeNull();
    expect(parseMachineConfig(`${minimal}dailyBudgetUsd: 12.5\n`).dailyBudgetUsd).toBe(12.5);
    // Pour supprimer le plafond on écrit `null` : 0 n'est pas une façon valide de le dire.
    expect(() => parseMachineConfig(`${minimal}dailyBudgetUsd: 0\n`)).toThrow(/dailyBudgetUsd/);
  });

  it('un plafond vidé survit à un aller-retour YAML', () => {
    const written = stringify(parseMachineConfig(`${minimal}dailyBudgetUsd: null\n`));
    expect(written).toContain('dailyBudgetUsd: null');
    const again = parseMachineConfig(written);
    expect(again.dailyBudgetUsd).toBeNull();
    expect(effectiveDailyBudget(again)).toBeUndefined();
  });

  it("un plafond absent n'est pas réécrit dans le fichier", () => {
    expect(stringify(parseMachineConfig(minimal))).not.toContain('dailyBudgetUsd');
  });

  it('accepte agentBackend cli, refuse une valeur inconnue', () => {
    expect(parseMachineConfig(`${minimal}agentBackend: cli\n`).agentBackend).toBe('cli');
    expect(() => parseMachineConfig(`${minimal}agentBackend: bedrock\n`)).toThrow(/agentBackend/);
  });

  it('refuse un repo mal formé', () => {
    expect(() => parseMachineConfig(minimal.replace('ILokYou/ILokYou-iOS', 'pasdeslash'))).toThrow(MachineConfigError);
  });

  it('refuse une liste de repos vide', () => {
    expect(() => parseMachineConfig(minimal.replace('  - ILokYou/ILokYou-iOS', '  []'))).toThrow(MachineConfigError);
  });

  it('refuse une clé inconnue', () => {
    expect(() => parseMachineConfig(`${minimal}dataDIr: /x\n`)).toThrow(/dataDIr/);
  });

  it('refuse des repos en double, un owner avec underscore et une concurrence excessive', () => {
    expect(() => parseMachineConfig(minimal.replace('  - ILokYou/ILokYou-iOS', '  - a/b\n  - a/b'))).toThrow(/double/);
    expect(() => parseMachineConfig(minimal.replace('ILokYou/ILokYou-iOS', 'my_org/repo'))).toThrow(/owner\/repo/);
    expect(() => parseMachineConfig(`${minimal}maxConcurrentJobs: 100\n`)).toThrow(/maxConcurrentJobs/);
    expect(() => parseMachineConfig(`${minimal}triggerLabel: "a b"\n`)).toThrow(/triggerLabel/);
  });

  it('refuse un chemin relatif au répertoire courant', () => {
    expect(() => parseMachineConfig(`${minimal}dataDir: data\n`)).toThrow(/dataDir/);
  });
});

describe('effectiveDailyBudget', () => {
  it('résout les quatre formes du plafond quotidien', () => {
    // Un nombre vaut plafond, quel que soit le backend.
    expect(effectiveDailyBudget(parseMachineConfig(`${minimal}dailyBudgetUsd: 12.5\n`))).toBe(12.5);
    expect(effectiveDailyBudget(parseMachineConfig(`${minimal}agentBackend: cli\ndailyBudgetUsd: 12.5\n`))).toBe(12.5);
    // `null` : plafond explicitement vidé, y compris sous `sdk` — ce que l'absence ne peut pas dire.
    expect(effectiveDailyBudget(parseMachineConfig(`${minimal}dailyBudgetUsd: null\n`))).toBeUndefined();
    // Absent : 60 sous `sdk` (le défaut historique), aucun plafond sous `cli`.
    expect(effectiveDailyBudget(parseMachineConfig(minimal))).toBe(60);
    expect(effectiveDailyBudget(parseMachineConfig(`${minimal}agentBackend: cli\n`))).toBeUndefined();
  });
});

describe('loadMachineConfig', () => {
  it('lit un fichier réel', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-machine-'));
    const file = join(dir, 'config.yml');
    await writeFile(file, minimal);
    const c = await loadMachineConfig(file);
    expect(c.repos).toEqual(['ILokYou/ILokYou-iOS']);
    await rm(dir, { recursive: true, force: true });
  });

  it('signale un fichier absent avec la consigne setup', async () => {
    await expect(loadMachineConfig('/nonexistent/sisyphe/config.yml')).rejects.toMatchObject({
      kind: 'missing',
      message: expect.stringContaining('sisyphe setup'),
    });
  });
});
