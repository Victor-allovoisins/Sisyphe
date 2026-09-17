import { execa } from 'execa';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { TEST_ENV, createRemoteRepo, writeFiles } from '../../test/helpers/git-fixture.js';
import { dataPaths, type DataPaths } from '../config/paths.js';
import { parseRepoConfig } from '../config/repo.js';
import { Git } from '../git/git.js';
import { repoEnv } from './commands.js';
import { runVerification, type ScanFn, type VerifyInput } from './verify.js';

const config = parseRepoConfig(`
baseBranch: main
commands:
  build: sh build.sh
  test: sh test.sh
protectedPaths: ["secrets/**"]
limits:
  maxDiffLines: 3
`);

// Un dépôt qui déclare les quatre étapes, chacune laissant sa trace : c'est cette trace, et non le
// statut rendu, qui prouve qu'une étape hors périmètre ne lance aucune commande.
const cfgTracee = parseRepoConfig(`
baseBranch: main
commands:
  setup: sh trace.sh setup
  build: sh trace.sh build
  test: sh trace.sh test
  lint: sh trace.sh lint
`);
const cfgTraceeEchec = parseRepoConfig(`
baseBranch: main
commands:
  setup: sh trace.sh setup
  build: sh echec.sh build
  test: sh trace.sh test
  lint: sh trace.sh lint
`);

describe('runVerification', () => {
  let root: string;
  let paths: DataPaths;
  let git: Git;
  let worktreePath: string;
  let baseSha: string;
  let jobDir: string;
  const env = repoEnv({ PATH: process.env.PATH ?? '' }, { cacheDir: '/tmp', issueNumber: 1, branch: 'b' });
  const repo = 'acme/demo';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sisyphe-verify-'));
    paths = dataPaths(join(root, 'data'));
    const { remotePath } = await createRemoteRepo(root, {
      'build.sh': 'test -f src/feature.txt || { echo "feature manquante" >&2; exit 1; }',
      'test.sh': 'grep -q hello src/feature.txt',
      'trace.sh': 'echo "$1" >> trace.txt',
      'echec.sh': 'echo "$1" >> trace.txt; exit 1',
    });
    git = new Git(paths);
    await git.ensureMirror(repo, remotePath, remotePath, ['main']);
    ({ worktreePath, baseSha } = await git.createWorktree(repo, 1, 'feature/issue-1-x', 'main'));
    jobDir = join(root, 'job');
    await writeFiles(jobDir, { '.keep': '' });
  });

  const run = (over: { scan?: ScanFn; cfg?: typeof config; signal?: AbortSignal; requested?: VerifyInput['requested']; attempt?: number; filesLikelyTouched?: string[] } = {}) =>
    runVerification({
      worktreePath, baseSha, config: over.cfg ?? config, jobDir, env, git, scan: over.scan ?? (async () => []), signal: over.signal,
      requested: over.requested ?? { steps: ['build', 'test', 'lint'], why: 'périmètre complet' },
      attempt: over.attempt ?? 1,
      filesLikelyTouched: over.filesLikelyTouched ?? [],
    });

  /** Ce que les commandes ont réellement lancé, dans l'ordre. */
  const trace = () => readFile(join(worktreePath, 'trace.txt'), 'utf8').catch(() => '');

  it('signale l’absence de changement', async () => {
    const r = await run();
    expect(r.noChanges).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.treeSha).toBeNull();
  });

  it('passe quand build et test sont verts et renvoie l’arbre vérifié', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n' });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.steps.map((s) => [s.name, s.status])).toEqual([['build', 'ok'], ['test', 'ok']]);
    expect(r.files).toEqual(['src/feature.txt']);
    expect(r.flags).toEqual({ protectedPathsTouched: [], largeDiff: false, secretsFound: [] });
    expect(r.driftedFiles).toEqual([]);
  });

  it('signale les fichiers suivis modifiés par la vérification, sans les inclure dans l’arbre livré', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n', 'build.sh': 'echo bumped > lock.txt; echo out > build-output.log; test -f src/feature.txt', 'lock.txt': 'v1\n' });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.driftedFiles).toEqual(['lock.txt']);
    const delivered = (await execa('git', ['show', `${r.treeSha}:lock.txt`], { cwd: worktreePath, env: TEST_ENV })).stdout;
    expect(delivered).toBe('v1');
  });

  it('échoue au build avec la fin de la sortie et marque le test non exécuté', async () => {
    await writeFiles(worktreePath, { 'src/other.txt': 'x\n' });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe('build');
    expect(r.failureTail).toContain('feature manquante');
    expect(r.steps.map((s) => [s.name, s.status])).toEqual([['build', 'failed'], ['test', 'skipped']]);
  });

  it('échoue au test, avec un message même sans sortie', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'bye\n' });
    const r = await run();
    expect(r.failedStep).toBe('test');
    expect(r.failureTail).toContain('sans aucune sortie');
  });

  it('pose les flags chemins protégés et gros diff', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n', 'secrets/key.txt': '1\n2\n3\n4\n' });
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r.flags.protectedPathsTouched).toEqual(['secrets/key.txt']);
    expect(r.flags.largeDiff).toBe(true);
  });

  it('s’arrête avant les commandes si un secret est détecté, avec un délai passé au scan', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n' });
    let seenTimeout = 0;
    const r = await run({ scan: async (_p, _r, opts) => { seenTimeout = opts.timeoutMs; return [{ file: 'src/feature.txt', ruleId: 'aws-access-token', line: 5 }]; } });
    expect(r.ok).toBe(false);
    expect(r.failedStep).toBe('secrets');
    expect(r.steps).toEqual([]);
    expect(r.flags.secretsFound).toEqual(['src/feature.txt (aws-access-token)']);
    expect(seenTimeout).toBeGreaterThan(1000);
  });

  it('épuise le budget : étape en timeout, suivantes non exécutées', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n', 'build.sh': 'sleep 5' });
    const cfg = parseRepoConfig(`baseBranch: main\ncommands:\n  build: sh build.sh\n  test: sh test.sh\ntimeouts:\n  verifyMinutes: 0.005\n`);
    const r = await run({ cfg });
    expect(r.failedStep).toBe('build');
    expect(r.steps.map((s) => [s.name, s.status])).toEqual([['build', 'timeout'], ['test', 'skipped']]);
    expect(r.failureTail).toContain('délai');
  });

  it('propage l’annulation', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n', 'build.sh': 'sleep 5' });
    const controller = new AbortController();
    setTimeout(() => controller.abort('cancelled'), 200);
    await expect(run({ signal: controller.signal })).rejects.toBe('cancelled');
  });
  it('ne lance que les étapes retenues et marque les autres hors périmètre', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n' });
    const r = await run({ cfg: cfgTracee, requested: { steps: ['build'], why: 'changement de libellé' }, filesLikelyTouched: ['src/feature.txt'] });
    expect(r.ok).toBe(true);
    expect(r.steps.filter((s) => s.status === 'ok').map((s) => s.name)).toEqual(['setup', 'build']);
    const horsPerimetre = r.steps.filter((s) => s.status === 'out-of-scope');
    expect(horsPerimetre.map((s) => s.name)).toEqual(['test', 'lint']);
    expect(horsPerimetre[0].reason).toBe('changement de libellé');
    expect(horsPerimetre.map((s) => [s.exitCode, s.durationMs, s.logFile])).toEqual([[0, 0, ''], [0, 0, '']]);
    expect(r.scope).toMatchObject({ widened: false, steps: ['setup', 'build'] });
    // La preuve : test et lint n'ont pas écrit leur trace, donc aucune commande n'a été lancée pour elles.
    expect(await trace()).toBe('setup\nbuild\n');
  });

  it('élargit et le dit quand le diff sort de la prévision du triage', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n' });
    const r = await run({ cfg: cfgTracee, requested: { steps: ['build'], why: 'changement de libellé' }, filesLikelyTouched: [] });
    expect(r.steps.every((s) => s.status !== 'out-of-scope')).toBe(true);
    expect(r.scope.widened).toBe(true);
    expect(r.scope.reason).toContain('src/feature.txt');
    expect(await trace()).toBe('setup\nbuild\ntest\nlint\n');
  });

  it('dit encore ce qui était hors périmètre quand une étape retenue échoue', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n' });
    const r = await run({ cfg: cfgTraceeEchec, requested: { steps: ['build'], why: 'changement de libellé' }, filesLikelyTouched: ['src/feature.txt'] });
    expect(r.failedStep).toBe('build');
    expect(r.steps.map((s) => [s.name, s.status])).toEqual([['setup', 'ok'], ['build', 'failed'], ['test', 'out-of-scope'], ['lint', 'out-of-scope']]);
    expect(await trace()).toBe('setup\nbuild\n');
  });

  it('le plancher du dépôt est retenu même quand le triage ne le demande pas', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n' });
    const cfg = parseRepoConfig(`baseBranch: main\ncommands:\n  build: sh trace.sh build\n  test: sh trace.sh test\n  lint: sh trace.sh lint\nverify:\n  alwaysRun: ["lint"]\n`);
    const r = await run({ cfg, requested: { steps: ['build'], why: 'changement de libellé' }, filesLikelyTouched: ['src/feature.txt'] });
    expect(r.steps.map((s) => [s.name, s.status])).toEqual([['build', 'ok'], ['test', 'out-of-scope'], ['lint', 'ok']]);
    expect(await trace()).toBe('build\nlint\n');
  });

  it('une reprise revérifie tout : le périmètre annoncé au triage n’est plus crédible', async () => {
    await writeFiles(worktreePath, { 'src/feature.txt': 'hello\n' });
    const r = await run({ cfg: cfgTracee, requested: { steps: ['build'], why: 'changement de libellé' }, filesLikelyTouched: ['src/feature.txt'], attempt: 2 });
    expect(r.scope.widened).toBe(true);
    expect(await trace()).toBe('setup\nbuild\ntest\nlint\n');
  });

  it('le périmètre est rendu même quand la vérification s’arrête avant de le calculer', async () => {
    const r = await run();
    expect(r.noChanges).toBe(true);
    expect(r.scope).toEqual({ steps: [], reason: expect.stringContaining('non calculé'), widened: false });
  });
});
