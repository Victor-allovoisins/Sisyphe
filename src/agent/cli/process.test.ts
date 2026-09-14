import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { callSlug, runCliProcess } from './process.js';

const FAKE_CLAUDE = fileURLToPath(new URL('../../../test/fakes/fake-claude.sh', import.meta.url));

interface Ctx {
  dir: string;
  childPidFile: string;
  opts: Parameters<typeof runCliProcess>[0];
}

/** Prépare un dossier de travail et un lancement du socle piloté par le faux binaire. */
async function ctx(
  o: { lines?: string[]; rawScript?: string; lateLines?: string[]; fake?: Record<string, string> } = {},
): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cli-process-'));
  const childPidFile = join(dir, 'child.pid');
  const scriptFile = join(dir, 'script.jsonl');
  await writeFile(scriptFile, o.rawScript ?? (o.lines === undefined ? '' : o.lines.map((l) => `${l}\n`).join('')));
  const lateFile = join(dir, 'late.jsonl');
  if (o.lateLines) await writeFile(lateFile, o.lateLines.map((l) => `${l}\n`).join(''));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    FAKE_CLAUDE_ARGS_FILE: join(dir, 'args.txt'),
    FAKE_CLAUDE_PROMPT_FILE: join(dir, 'prompt.txt'),
    FAKE_CLAUDE_ENV_FILE: join(dir, 'env.txt'),
    FAKE_CLAUDE_CHILD_PID_FILE: childPidFile,
    FAKE_CLAUDE_SCRIPT: scriptFile,
    ...(o.lateLines ? { FAKE_CLAUDE_LATE_SCRIPT: lateFile } : {}),
    ...(o.fake ?? {}),
  };
  return {
    dir,
    childPidFile,
    opts: {
      bin: FAKE_CLAUDE,
      args: [],
      cwd: dir,
      env,
      stdin: 'fais le job',
      transcriptPath: join(dir, 'transcript.jsonl'),
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      onLine: () => undefined,
    },
  };
}

describe('callSlug', () => {
  it('dérive le suffixe du nom du transcript, avec replis', () => {
    expect(callSlug('/tmp/transcript-implement-2.jsonl')).toBe('implement-2');
    expect(callSlug('/tmp/transcript.jsonl')).toBe('transcript');
    expect(callSlug('/tmp/foo.jsonl')).toBe('foo');
  });
});

describe('runCliProcess', () => {
  it('recoud une ligne coupée entre deux écritures', async () => {
    const whole = JSON.stringify({ type: 'result', n: 1 });
    const cut = Math.floor(whole.length / 2);
    const c = await ctx({ rawScript: whole.slice(0, cut), lateLines: [whole.slice(cut)], fake: { FAKE_CLAUDE_SLEEP: '0.3' } });
    const lines: Record<string, unknown>[] = [];
    const r = await runCliProcess({ ...c.opts, onLine: (l) => lines.push(l) });
    expect(r.timedOut).toBe(false);
    expect(lines).toEqual([{ type: 'result', n: 1 }]);
  });

  it('conserve une ligne non JSON telle quelle sous sisyphe_raw', async () => {
    const c = await ctx({ lines: ['pas du json', JSON.stringify({ type: 'ok' })] });
    const lines: Record<string, unknown>[] = [];
    await runCliProcess({ ...c.opts, onLine: (l) => lines.push(l) });
    const transcript = (await readFile(c.opts.transcriptPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(transcript[0]).toEqual({ type: 'sisyphe_raw', data: 'pas du json' });
    expect(lines).toEqual([{ type: 'ok' }]);
  });

  it('refuse de lancer si le signal est déjà annulé', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    const c = await ctx({ lines: [JSON.stringify({ type: 'ok' })] });
    const r = await runCliProcess({ ...c.opts, signal: controller.signal });
    expect(r.aborted).toBe(true);
    expect(r.exitCode).toBe(-1);
    await expect(readFile(c.opts.env.FAKE_CLAUDE_ARGS_FILE, 'utf8')).rejects.toThrow();
  });

  it('au timeout, tue tout le groupe de processus', async () => {
    const c = await ctx({ fake: { FAKE_CLAUDE_SLEEP: '5' } });
    const r = await runCliProcess({ ...c.opts, timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    const pid = Number((await readFile(c.childPidFile, 'utf8')).trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
