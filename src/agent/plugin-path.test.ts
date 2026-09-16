import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentPluginPath, JIRA_SKILL } from './plugin-path.js';

describe('agentPluginPath', () => {
  it('pointe sur un plugin réellement présent dans le paquet', async () => {
    const path = agentPluginPath();
    await expect(access(join(path, '.claude-plugin', 'plugin.json'))).resolves.toBeUndefined();
    await expect(access(join(path, 'skills', 'sisyphe-jira', 'SKILL.md'))).resolves.toBeUndefined();
  });

  it('nomme le skill sous sa forme qualifiée par le plugin', () => {
    expect(JIRA_SKILL).toBe('sisyphe:sisyphe-jira');
  });
});
