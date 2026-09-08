import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoEnv, runRepoCommand } from './commands.js';

describe('runRepoCommand', () => {
  it('capture sortie, code et durée, et écrit le log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cmd-'));
    const logFile = join(dir, 'build.log');
    const r = await runRepoCommand('echo hello; echo err >&2; exit 3', { cwd: dir, env: repoEnv({}, { cacheDir: dir, issueNumber: 1, branch: 'b' }), timeoutMs: 5000, logFile });
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('hello');
    expect(r.output).toContain('err');
    expect(r.timedOut).toBe(false);
    expect(await readFile(logFile, 'utf8')).toContain('[exit 3]');
  });

  it('expose les variables SISYPHE_*', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cmd-'));
    const r = await runRepoCommand('echo $SISYPHE_ISSUE_NUMBER:$SISYPHE_BRANCH:$SISYPHE_CACHE_DIR', { cwd: dir, env: repoEnv({ PATH: process.env.PATH ?? '' }, { cacheDir: '/c', issueNumber: 42, branch: 'feature/x' }), timeoutMs: 5000 });
    expect(r.output.trim()).toBe('42:feature/x:/c');
  });

  it('tue le groupe de processus au timeout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cmd-'));
    const started = Date.now();
    const r = await runRepoCommand('sleep 30 & sleep 30', { cwd: dir, env: repoEnv({ PATH: process.env.PATH ?? '' }, { cacheDir: dir, issueNumber: 1, branch: 'b' }), timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('s’interrompt sur abort', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cmd-'));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r = await runRepoCommand('sleep 30', { cwd: dir, env: repoEnv({ PATH: process.env.PATH ?? '' }, { cacheDir: dir, issueNumber: 1, branch: 'b' }), timeoutMs: 10_000, signal: controller.signal });
    expect(r.cancelled).toBe(true);
  });
});
