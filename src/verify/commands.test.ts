import { execa } from 'execa';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentEnv, repoEnv, runRepoCommand } from './commands.js';

const base = { PATH: process.env.PATH ?? '' };
const env = repoEnv(base, { cacheDir: '/c', issueNumber: 42, branch: 'feature/x' });
const noSurvivor = async (marker: string) => {
  const r = await execa('pgrep', ['-f', marker], { reject: false });
  expect(r.exitCode, `processus survivants : ${r.stdout}`).toBe(1);
};

const hasPerl = (await execa('perl', ['-e', '1'], { reject: false })).exitCode === 0;

describe('runRepoCommand', () => {
  afterEach(async () => {
    await execa('pkill', ['-f', 'setpgrp\\(0,0\\); sleep 30'], { reject: false });
  });

  it('capture sortie, code et durée, et écrit le log dans un dossier créé au besoin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cmd-'));
    const logFile = join(dir, 'logs', 'build.log');
    const r = await runRepoCommand('echo hello; echo err >&2; exit 3', { cwd: dir, env, timeoutMs: 5000, logFile });
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('hello');
    expect(r.output).toContain('err');
    expect(r.timedOut).toBe(false);
    expect(r.truncated).toBe(false);
    const log = await readFile(logFile, 'utf8');
    expect(log).toContain('$ echo hello');
    expect(log.endsWith('[exit 3]\n')).toBe(true);
  });

  it('expose les variables SISYPHE_* et CI, et retire les secrets du daemon', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cmd-'));
    const leaky = repoEnv({ ...base, SSH_AUTH_SOCK: '/tmp/agent.sock', GITHUB_TOKEN: 'ghp_x', ANTHROPIC_API_KEY: 'sk-x' }, { cacheDir: '/c', issueNumber: 42, branch: 'feature/x' });
    const r = await runRepoCommand('echo "$SISYPHE_ISSUE_NUMBER:$SISYPHE_BRANCH:$SISYPHE_CACHE_DIR:$CI:${SSH_AUTH_SOCK:-none}:${GITHUB_TOKEN:-none}:${ANTHROPIC_API_KEY:-none}"', { cwd: dir, env: leaky, timeoutMs: 5000 });
    expect(r.output.trim()).toBe('42:feature/x:/c:true:none:none:none');
    expect(agentEnv({ ...base, ANTHROPIC_API_KEY: 'sk-x', SSH_AUTH_SOCK: '/s' }, { cacheDir: '/c', issueNumber: 1, branch: 'b' })).toMatchObject({ ANTHROPIC_API_KEY: 'sk-x' });
    expect(agentEnv({ ...base, SSH_AUTH_SOCK: '/s' }, { cacheDir: '/c', issueNumber: 1, branch: 'b' })).not.toHaveProperty('SSH_AUTH_SOCK');
    // Backend cli : une clé API présente dans l'environnement du daemon ne doit pas basculer la CLI
    // (abonnement claude.ai) sur une facturation API à l'insu de l'utilisateur.
    expect(agentEnv({ ...base, ANTHROPIC_API_KEY: 'sk-x' }, { cacheDir: '/c', issueNumber: 1, branch: 'b' }, 'cli')).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('repoEnv et agentEnv neutralisent credential helper et prompts git', () => {
    const expected = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Sisyphe',
      GIT_AUTHOR_EMAIL: 'sisyphe[bot]@users.noreply.github.com',
      GIT_COMMITTER_NAME: 'Sisyphe',
      GIT_COMMITTER_EMAIL: 'sisyphe[bot]@users.noreply.github.com',
    };
    expect(repoEnv(base, { cacheDir: '/c', issueNumber: 1, branch: 'b' })).toMatchObject(expected);
    expect(agentEnv(base, { cacheDir: '/c', issueNumber: 1, branch: 'b' })).toMatchObject(expected);
  });

  it('empêche effectivement git d’utiliser le credential.helper global (store)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cred-'));
    await execa('git', ['init', '-q', 'repo'], { cwd: dir });
    const repoPath = join(dir, 'repo');
    const fakeGlobal = join(dir, 'fake-global.gitconfig');
    await writeFile(fakeGlobal, '[credential]\n\thelper = store\n');
    const hermeticBase = { PATH: base.PATH, GIT_CONFIG_GLOBAL: fakeGlobal, GIT_CONFIG_SYSTEM: '/dev/null' };

    // Contrôle : sans repoEnv, le helper global est bien vu — sinon l'assertion suivante ne prouverait rien.
    const control = await execa('git', ['config', '--get-all', 'credential.helper'], { cwd: repoPath, env: hermeticBase, reject: false });
    expect(control.stdout.trim()).toBe('store');

    // Avec repoEnv : GIT_CONFIG_COUNT/KEY_0/VALUE_0 vide réinitialise la liste des helpers (le dernier gagne),
    // donc la valeur *effective* (--get, singulier) est vide — --get-all continuerait, lui, à lister l'historique.
    const withOverride = repoEnv(hermeticBase, { cacheDir: '/c', issueNumber: 1, branch: 'b' });
    const r = await execa('git', ['config', '--get', 'credential.helper'], { cwd: repoPath, env: withOverride, reject: false });
    expect(r.stdout.trim()).toBe('');
  });

  it('tue tout le groupe au timeout, sans survivant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cmd-'));
    const started = Date.now();
    const r = await runRepoCommand('sleep 31 & sleep 31', { cwd: dir, env, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    await noSurvivor('sleep 31');
  });

  it('s’interrompt sur abort', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cmd-'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r = await runRepoCommand('sleep 32', { cwd: dir, env, timeoutMs: 10_000, signal: controller.signal });
    expect(r.cancelled).toBe(true);
    await noSurvivor('sleep 32');
  });

  it('borne la sortie en gardant la fin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cmd-'));
    const r = await runRepoCommand('yes 0123456789 | head -c 6000000; echo FIN', { cwd: dir, env, timeoutMs: 20_000 });
    expect(r.exitCode).toBe(0);
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThanOrEqual(4 * 1024 * 1024 + 4);
    expect(r.output.trimEnd().endsWith('FIN')).toBe(true);
  });

  it.skipIf(!hasPerl)('ne reste pas bloqué par un petit-fils échappé du groupe qui garde stdout ouvert', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cmd-'));
    const started = Date.now();
    const r = await runRepoCommand("perl -e 'setpgrp(0,0); sleep 30' & sleep 30", { cwd: dir, env, timeoutMs: 300, killGraceMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  // La tête sort tout de suite : le timeout doit quand même agir, sinon on attendrait la fin du
  // petit-fils (la promesse du sous-processus n'est réglée qu'une fois tous les flux fermés).
  it.skipIf(!hasPerl)('ne reste pas bloqué quand la tête sort avant un petit-fils qui garde stdout ouvert', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cmd-'));
    const started = Date.now();
    const r = await runRepoCommand("perl -e 'setpgrp(0,0); sleep 30' & exit 0", { cwd: dir, env, timeoutMs: 300, killGraceMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
