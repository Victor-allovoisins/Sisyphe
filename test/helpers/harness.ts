import { execa } from 'execa';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { parseMachineConfig } from '../../src/config/machine.js';
import { dataPaths, ensureDataDirs } from '../../src/config/paths.js';
import { Git } from '../../src/git/git.js';
import { parseRepo } from '../../src/github/source.js';
import type { PipelineDeps } from '../../src/jobs/pipeline.js';
import { ActionStore } from '../../src/store/actions.js';
import { openDatabase } from '../../src/store/db.js';
import { JobStore } from '../../src/store/jobs.js';
import { PhaseStore } from '../../src/store/phases.js';
import { FakeIssueSource } from '../fakes/fake-issue-source.js';
import type { Issue } from '../../src/github/source.js';
import { ScriptedAgentRunner, type ScriptedStep } from '../fakes/scripted-agent-runner.js';
import { TEST_ENV, createRemoteRepo, writeFiles } from './git-fixture.js';

export const REPO = 'acme/demo';
export const repoRef = parseRepo(REPO);

export const SISYPHE_YML = `baseBranch: main
commands:
  build: sh build.sh
  test: sh test.sh
protectedPaths:
  - "secrets/**"
limits:
  maxAttempts: 2
`;

export const readyVerdict = {
  verdict: 'ready', confidence: 0.9, summary: 'Écrire hello dans src/feature.txt', note: '', change_type: 'feat',
  plan: ['créer src/feature.txt'], files_likely_touched: ['src/feature.txt'], questions: [], reasons: [],
  verification: { steps: ['build', 'test', 'lint'], why: 'périmètre complet' },
};

export const report = (summary: string) => ({
  summary, changes: [{ file: 'src/feature.txt', what: 'création' }], decisions: [], tests_run: ['sh test.sh : ok'], risks: [], follow_ups: [], confidence: 0.9,
});

export const writeFeature = (content: string): NonNullable<ScriptedStep['sideEffect']> => async (opts) =>
  writeFiles(opts.cwd, { 'src/feature.txt': content });

/** Champs de `config.yml` que les tests font varier ; le reste du fichier est figé. */
export interface ConfigFields {
  github: { appId: number; installationId: number; privateKeyPath: string };
  repos: string[];
  dataDir: string;
  /** Un nombre, `null` pour « aucun plafond », `'absent'` pour ne pas écrire la ligne. */
  dailyBudgetUsd: number | null | 'absent';
  pollIntervalSeconds?: number;
  maxConcurrentJobs?: number;
  triggerLabel?: string;
  sandbox?: boolean;
  agentBackend?: 'sdk' | 'cli' | 'claude-code' | 'codex' | 'opencode';
  agentModels?: { triage?: string; implement?: string };
}

/** `config.yml` complet : les champs omis par un test gardent leur valeur, sinon le schéma remettrait ses défauts. */
function renderConfig(f: ConfigFields): string {
  const lines = [
    'github:',
    `  appId: ${f.github.appId}`,
    `  installationId: ${f.github.installationId}`,
    `  privateKeyPath: ${f.github.privateKeyPath}`,
    'repos:',
    ...f.repos.map((r) => `  - ${r}`),
    `dataDir: ${f.dataDir}`,
  ];
  if (f.dailyBudgetUsd !== 'absent') lines.push(`dailyBudgetUsd: ${f.dailyBudgetUsd}`);
  if (f.pollIntervalSeconds !== undefined) lines.push(`pollIntervalSeconds: ${f.pollIntervalSeconds}`);
  if (f.maxConcurrentJobs !== undefined) lines.push(`maxConcurrentJobs: ${f.maxConcurrentJobs}`);
  if (f.triggerLabel !== undefined) lines.push(`triggerLabel: ${f.triggerLabel}`);
  if (f.sandbox !== undefined) lines.push(`sandbox: ${f.sandbox}`);
  if (f.agentBackend !== undefined) lines.push(`agentBackend: ${f.agentBackend}`);
  if (f.agentModels !== undefined) {
    lines.push('agentModels:');
    if (f.agentModels.triage !== undefined) lines.push(`  triage: ${f.agentModels.triage}`);
    if (f.agentModels.implement !== undefined) lines.push(`  implement: ${f.agentModels.implement}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface HarnessOptions {
  steps: ScriptedStep[];
  withConfig?: boolean;
  /** Ce qu'écrit `config.yml` : un nombre, `null` pour « aucun plafond », `'absent'` pour ne pas écrire la ligne. */
  dailyBudgetUsd?: number | null | 'absent';
  /** Backend de la config machine ; absent, le schéma retombe sur `sdk`. Ne change pas l'agent du harness, toujours scripté. */
  agentBackend?: 'sdk' | 'cli' | 'claude-code' | 'codex' | 'opencode';
  /** Surcharge machine des modèles par phase (codex/opencode). */
  agentModels?: { triage?: string; implement?: string };
  issues?: Array<{ number: number; title: string; author?: string; labeledBy?: string; tracker?: Issue['tracker'] }>;
  /** Fichiers ajoutés au repo distant ; peuvent remplacer ceux du fixture, `sisyphe.yml` compris. */
  files?: Record<string, string>;
  /** Branche par défaut du repo distant et de la forge. */
  defaultBranch?: string;
  /** Branches créées sur le distant à partir de la branche par défaut, pour tester une base différente. */
  extraBranches?: string[];
}

export async function makeHarness(o: HarnessOptions) {
  const root = await mkdtemp(join(tmpdir(), 'sisyphe-it-'));
  const paths = dataPaths(join(root, 'data'));
  await ensureDataDirs(paths);
  const defaultBranch = o.defaultBranch ?? 'main';
  const files: Record<string, string> = { 'build.sh': 'test -f src/feature.txt', 'test.sh': 'grep -q hello src/feature.txt' };
  if (o.withConfig !== false) files['sisyphe.yml'] = SISYPHE_YML;
  Object.assign(files, o.files ?? {});
  const { remotePath, headSha } = await createRemoteRepo(root, files, defaultBranch);
  for (const b of o.extraBranches ?? []) await execa('git', ['branch', b, defaultBranch], { cwd: remotePath, env: TEST_ENV });

  const db = openDatabase(':memory:');
  const store = new JobStore(db);
  const phases = new PhaseStore(db);
  const actions = new ActionStore(db);
  const source = new FakeIssueSource('sisyphe');
  source.remoteUrl = remotePath;
  source.defaultBranch = defaultBranch;
  source.permissions.alice = 'write';
  for (const issue of o.issues ?? [{ number: 7, title: 'Ajouter feature hello' }]) {
    source.addIssue(repoRef, { ...issue, body: 'On veut hello.', author: issue.author ?? 'alice' });
  }
  const agent = new ScriptedAgentRunner(o.steps);
  // Le fichier est écrit sur disque et non seulement analysé : `reload` relit celui-ci, jamais celui de la machine.
  // `??` serait faux ici : `null` est une valeur demandée (aucun plafond), pas une absence d'option.
  let fields: ConfigFields = {
    github: { appId: 1, installationId: 1, privateKeyPath: '/dev/null' },
    repos: [REPO],
    dataDir: paths.root,
    dailyBudgetUsd: o.dailyBudgetUsd === undefined ? 60 : o.dailyBudgetUsd,
    ...(o.agentBackend === undefined ? {} : { agentBackend: o.agentBackend }),
    ...(o.agentModels === undefined ? {} : { agentModels: o.agentModels }),
  };
  const configPath = join(root, 'config.yml');
  const machine = parseMachineConfig(renderConfig(fields));
  /** Réécrit `config.yml` en cumulant les modifications : deux appels successifs ne s'annulent pas. */
  const writeConfig = (over: Partial<ConfigFields> = {}) => {
    fields = { ...fields, ...over };
    return writeFile(configPath, renderConfig(fields), 'utf8');
  };
  await writeConfig();
  const deps: PipelineDeps = {
    store, phases, actions, source, forge: source, agent, git: new Git(paths), paths, machine,
    log: pino({ level: 'silent' }), env: { PATH: process.env.PATH ?? '' }, scan: async () => [],
  };
  return { root, paths, configPath, writeConfig, remotePath, headSha, store, phases, actions, source, agent, deps };
}
