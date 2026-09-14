import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMachineConfig, MachineConfigError, parseMachineConfig } from './machine.js';

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
    expect(c.dailyBudgetUsd).toBe(60);
    expect(c.sandbox).toBe(false);
    expect(c.agentBackend).toBe('sdk');
    expect(c.dataDir).toBe(join(homedir(), '.sisyphe'));
    expect(c.github.privateKeyPath).toBe(join(homedir(), '.sisyphe/app.pem'));
  });

  it('résout le plafond quotidien selon le backend, et refuse une valeur nulle', () => {
    // Champ absent : `sdk` garde son plafond historique, `cli` n'en a aucun.
    expect(parseMachineConfig(minimal).dailyBudgetUsd).toBe(60);
    expect(parseMachineConfig(`${minimal}agentBackend: cli\n`).dailyBudgetUsd).toBeUndefined();
    // Valeur présente : conservée telle quelle, quel que soit le backend.
    expect(parseMachineConfig(`${minimal}dailyBudgetUsd: 12.5\n`).dailyBudgetUsd).toBe(12.5);
    expect(parseMachineConfig(`${minimal}agentBackend: cli\ndailyBudgetUsd: 12.5\n`).dailyBudgetUsd).toBe(12.5);
    // Pour supprimer le plafond, on retire le champ : 0 n'est pas une façon valide de le dire.
    expect(() => parseMachineConfig(`${minimal}dailyBudgetUsd: 0\n`)).toThrow(/dailyBudgetUsd/);
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
