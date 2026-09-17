import { describe, expect, it } from 'vitest';
import { EXAMPLE_REPO_CONFIG, RepoConfigError, parseRepoConfig } from './repo.js';

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

  it('accepte l’exemple fourni aux utilisateurs', () => {
    expect(() => parseRepoConfig(EXAMPLE_REPO_CONFIG)).not.toThrow();
  });

  it('refuse une commande non textuelle (en YAML nu, true est un booléen)', () => {
    expect(() => parseRepoConfig('baseBranch: main\ncommands:\n  build: true\n')).toThrow(/commands\.build/);
  });

  it('refuse une clé inconnue plutôt que de l’ignorer', () => {
    expect(() => parseRepoConfig(`${minimal}protectedPath: ["**/*.xcconfig"]\n`)).toThrow(/protectedPath/);
    expect(() => parseRepoConfig('baseBranch: main\ncommands:\n  buidl: make\n  build: make\n')).toThrow(/buidl/);
  });

  it('refuse un glob vide, un label vide et un préfixe de branche invalide pour git', () => {
    expect(() => parseRepoConfig(`${minimal}protectedPaths: [""]\n`)).toThrow(/protectedPaths/);
    expect(() => parseRepoConfig(`${minimal}pr:\n  labels: [""]\n`)).toThrow(/pr\.labels/);
    for (const bad of ['../', 'feature/.', 'a//b/', 'feature.lock/', '-']) {
      expect(() => parseRepoConfig(`${minimal}branchPrefix: "${bad}"\n`), bad).toThrow(/branchPrefix/);
    }
    expect(parseRepoConfig(`${minimal}branchPrefix: "sisyphe/fix-"\n`).branchPrefix).toBe('sisyphe/fix-');
  });

  it('traite une section vide comme absente', () => {
    const c = parseRepoConfig(`${minimal}models:\nbudget:\nprotectedPaths:\ninstructions:\n`);
    expect(c.models.triage).toBe('claude-sonnet-5');
    expect(c.budget.implementUsd).toBe(8);
    expect(c.protectedPaths).toEqual([]);
    expect(c.instructions).toBe('');
  });

  it('refuse un document qui n’est pas un objet', () => {
    expect(() => parseRepoConfig('- a\n- b\n')).toThrow(/racine/);
  });

  it('verify.alwaysRun vaut [] par défaut et accepte les étapes connues', () => {
    const base = 'baseBranch: main\ncommands:\n  build: "true"\n';
    expect(parseRepoConfig(base).verify.alwaysRun).toEqual([]);
    expect(parseRepoConfig(`${base}verify:\n  alwaysRun: [build, lint]\n`).verify.alwaysRun).toEqual(['build', 'lint']);
    expect(() => parseRepoConfig(`${base}verify:\n  alwaysRun: [setup]\n`)).toThrow();
    expect(() => parseRepoConfig(`${base}verify:\n  alwaysRun: [nawak]\n`)).toThrow();
  });
});
