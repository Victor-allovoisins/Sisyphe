import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffMachineConfig } from './diff.js';
import { MachineConfigSchema, type MachineConfig } from './machine.js';

// Pur : aucune lecture de fichier, `homedir()` ne sert qu'à fabriquer la forme développée d'un chemin.
const base: MachineConfig = MachineConfigSchema.parse({
  github: { appId: 1, installationId: 2, privateKeyPath: '~/.sisyphe/app.pem' },
  repos: ['acme/demo'],
  dataDir: '~/.sisyphe',
});

describe('diffMachineConfig', () => {
  it('configurations identiques : deux listes vides', () => {
    expect(diffMachineConfig(base, structuredClone(base))).toEqual({ hot: [], restart: [] });
  });

  it('un chemin écrit en ~ et le même développé ne sont pas une modification', () => {
    const expanded: MachineConfig = {
      ...base,
      dataDir: join(homedir(), '.sisyphe'),
      github: { ...base.github, privateKeyPath: join(homedir(), '.sisyphe', 'app.pem') },
    };
    expect(diffMachineConfig(base, expanded)).toEqual({ hot: [], restart: [] });
  });

  it('range chaque champ modifié dans sa famille, dans l’ordre des listes du daemon', () => {
    const next: MachineConfig = { ...base, triggerLabel: 'robot', pollIntervalSeconds: 120, repos: ['acme/demo', 'acme/other'], dailyBudgetUsd: 5 };
    expect(diffMachineConfig(base, next)).toEqual({ hot: ['dailyBudgetUsd', 'pollIntervalSeconds'], restart: ['repos', 'triggerLabel'] });
  });

  it('budget : `null` et champ absent sont deux valeurs distinctes', () => {
    expect(diffMachineConfig({ ...base, dailyBudgetUsd: undefined }, { ...base, dailyBudgetUsd: null }).hot).toEqual(['dailyBudgetUsd']);
  });
});
