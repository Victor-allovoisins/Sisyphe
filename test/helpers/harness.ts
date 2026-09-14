import { execa } from 'execa';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { parseMachineConfig, type AgentBackend } from '../../src/config/machine.js';
import { dataPaths, ensureDataDirs } from '../../src/config/paths.js';
import { Git } from '../../src/git/git.js';
import { parseRepo } from '../../src/github/source.js';
import type { PipelineDeps } from '../../src/jobs/pipeline.js';
import { ActionStore } from '../../src/store/actions.js';
import { openDatabase } from '../../src/store/db.js';
import { JobStore } from '../../src/store/jobs.js';
import { PhaseStore } from '../../src/store/phases.js';
import { FakeIssueSource } from '../fakes/fake-issue-source.js';
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
  verdict: 'ready', confidence: 0.9, summary: 'Écrire hello dans src/feature.txt', change_type: 'feat',
  plan: ['créer src/feature.txt'], files_likely_touched: ['src/feature.txt'], questions: [], reasons: [],
};

export const report = (summary: string) => ({
  summary, changes: [{ file: 'src/feature.txt', what: 'création' }], decisions: [], tests_run: ['sh test.sh : ok'], risks: [], follow_ups: [], confidence: 0.9,
});

export const writeFeature = (content: string): NonNullable<ScriptedStep['sideEffect']> => async (opts) =>
  writeFiles(opts.cwd, { 'src/feature.txt': content });

export interface HarnessOptions {
  steps: ScriptedStep[];
  withConfig?: boolean;
  /** `null` : aucune ligne `dailyBudgetUsd` dans la config, pour tester la résolution du plafond. */
  dailyBudgetUsd?: number | null;
  agentBackend?: AgentBackend;
  issues?: Array<{ number: number; title: string; author?: string; labeledBy?: string }>;
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
  const budgetLine = o.dailyBudgetUsd === null ? '' : `dailyBudgetUsd: ${o.dailyBudgetUsd ?? 60}\n`;
  const machine = parseMachineConfig(
    `github:\n  appId: 1\n  installationId: 1\n  privateKeyPath: /dev/null\nrepos:\n  - ${REPO}\ndataDir: ${paths.root}\nagentBackend: ${o.agentBackend ?? 'sdk'}\n${budgetLine}`,
  );
  const deps: PipelineDeps = {
    store, phases, actions, source, agent, git: new Git(paths), paths, machine,
    log: pino({ level: 'silent' }), env: { PATH: process.env.PATH ?? '' }, scan: async () => [],
  };
  return { root, paths, remotePath, headSha, store, phases, actions, source, agent, deps };
}
