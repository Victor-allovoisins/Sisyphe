import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MachineConfigError, parseMachineConfig } from './machine.js';

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
    expect(c.dataDir).toBe(join(homedir(), '.sisyphe'));
    expect(c.github.privateKeyPath).toBe(join(homedir(), '.sisyphe/app.pem'));
  });

  it('refuse un repo mal formé', () => {
    expect(() => parseMachineConfig(minimal.replace('ILokYou/ILokYou-iOS', 'pasdeslash'))).toThrow(MachineConfigError);
  });

  it('refuse une liste de repos vide', () => {
    expect(() => parseMachineConfig(minimal.replace('  - ILokYou/ILokYou-iOS', '  []'))).toThrow(MachineConfigError);
  });
});
