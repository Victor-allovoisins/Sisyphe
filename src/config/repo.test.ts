import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RepoConfigError, loadRepoConfig, parseRepoConfig } from './repo.js';

const minimal = `
baseBranch: develop
commands:
  build: xcodebuild build
`;

describe('parseRepoConfig', () => {
  it('applique les défauts sur une config minimale', () => {
    const c = parseRepoConfig(minimal);
    expect(c.baseBranch).toBe('develop');
    expect(c.branchPrefix).toBe('feature/');
    expect(c.commands.build).toBe('xcodebuild build');
    expect(c.commands.test).toBeUndefined();
    expect(c.protectedPaths).toEqual([]);
    expect(c.models).toEqual({ triage: 'claude-sonnet-5', implement: 'claude-opus-5' });
    expect(c.budget).toEqual({ triageUsd: 1, implementUsd: 8 });
    expect(c.limits).toEqual({ maxAttempts: 3, maxDiffLines: 800, maxFilesEstimate: 15 });
    expect(c.timeouts).toEqual({ triageMinutes: 10, implementMinutes: 60, verifyMinutes: 30 });
    expect(c.pr).toEqual({ labels: ['sisyphe'], reviewers: [], draft: false });
    expect(c.instructions).toBe('');
  });

  it('conserve les valeurs explicites', () => {
    const c = parseRepoConfig(`${minimal}
protectedPaths: ["**/*.xcconfig"]
models:
  implement: claude-fable-5-1
limits:
  maxAttempts: 1
`);
    expect(c.protectedPaths).toEqual(['**/*.xcconfig']);
    expect(c.models.implement).toBe('claude-fable-5-1');
    expect(c.models.triage).toBe('claude-sonnet-5');
    expect(c.limits.maxAttempts).toBe(1);
    expect(c.limits.maxDiffLines).toBe(800);
  });

  it('signale les champs requis manquants avec leur chemin', () => {
    expect(() => parseRepoConfig('commands:\n  test: x\n')).toThrow(RepoConfigError);
    try {
      parseRepoConfig('commands:\n  test: x\n');
    } catch (err) {
      const e = err as RepoConfigError;
      expect(e.kind).toBe('invalid');
      expect(e.message).toContain('baseBranch');
      expect(e.message).toContain('commands.build');
    }
  });

  it('signale un YAML illisible', () => {
    expect(() => parseRepoConfig('baseBranch: [')).toThrow(/YAML/);
  });
});

describe('loadRepoConfig', () => {
  it('lit sisyphe.yml dans le dossier', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cfg-'));
    await writeFile(join(dir, 'sisyphe.yml'), minimal);
    const c = await loadRepoConfig(dir);
    expect(c.baseBranch).toBe('develop');
  });

  it('distingue le fichier absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cfg-'));
    await expect(loadRepoConfig(dir)).rejects.toMatchObject({ kind: 'missing' });
  });
});
