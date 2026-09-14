import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CodexAgentRunner } from './codex-runner.js';
import type { AgentRunOptions } from '../runner.js';

const FAKE_CODEX = fileURLToPath(new URL('../../../test/fakes/fake-codex.sh', import.meta.url));

const threadStarted = (id = 'thread-1') => JSON.stringify({ type: 'thread.started', thread_id: id });
const turnStarted = JSON.stringify({ type: 'turn.started' });
const turnCompleted = (usage: Record<string, number> = {}) =>
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 100, cached_input_tokens: 5, output_tokens: 20, reasoning_output_tokens: 3, ...usage },
  });
const agentMessage = (text = 'fini') => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });

interface Ctx {
  dir: string;
  argsFile: string;
  promptFile: string;
  envFile: string;
  childPidFile: string;
  opts: AgentRunOptions;
}

/** Prépare un dossier de travail, un script JSONL pour le faux `codex` et des options complètes. */
async function ctx(o: { lines?: string[]; rawScript?: string; lateLines?: string[]; fake?: Record<string, string>; opts?: Partial<AgentRunOptions> } = {}): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), 'sisyphe-codex-'));
  const argsFile = join(dir, 'args.txt');
  const promptFile = join(dir, 'prompt.txt');
  const envFile = join(dir, 'env.txt');
  const childPidFile = join(dir, 'child.pid');
  const scriptFile = join(dir, 'script.jsonl');
  await writeFile(scriptFile, o.rawScript ?? (o.lines === undefined ? '' : o.lines.map((l) => `${l}\n`).join('')));
  const lateFile = join(dir, 'late.jsonl');
  if (o.lateLines) await writeFile(lateFile, o.lateLines.map((l) => `${l}\n`).join(''));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    FAKE_CODEX_ARGS_FILE: argsFile,
    FAKE_CODEX_PROMPT_FILE: promptFile,
    FAKE_CODEX_ENV_FILE: envFile,
    FAKE_CODEX_CHILD_PID_FILE: childPidFile,
    FAKE_CODEX_SCRIPT: scriptFile,
    ...(o.lateLines ? { FAKE_CODEX_LATE_SCRIPT: lateFile } : {}),
    ...(o.fake ?? {}),
  };
  return {
    dir, argsFile, promptFile, envFile, childPidFile,
    opts: {
      cwd: dir, model: 'gpt-5-codex', phase: 'implement', systemPromptAppend: 'consignes maison', prompt: 'fais le job',
      maxTurns: 7, maxBudgetUsd: 2.5, allowedTools: ['Read', 'Edit'], disallowedTools: [],
      env, timeoutMs: 10_000, signal: new AbortController().signal, transcriptPath: join(dir, 'transcript.jsonl'),
      ...(o.opts ?? {}),
    },
  };
}

const runner = () => new CodexAgentRunner({ bin: FAKE_CODEX });

/** Un argument vide est une ligne vide : on ne filtre que le saut de ligne final. */
async function readArgs(file: string): Promise<string[]> {
  const raw = await readFile(file, 'utf8');
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

const valueOf = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

describe('CodexAgentRunner : arguments', () => {
  it('passe le mode sandbox, la coupure web/MCP, le schéma, le fichier de résultat, le prompt sur stdin', async () => {
    const c = await ctx({
      lines: [threadStarted(), turnCompleted()],
      fake: { FAKE_CODEX_RESULT: JSON.stringify({ answer: 'ok' }) },
      opts: { phase: 'triage', outputSchema: schema },
    });
    await runner().run(c.opts);
    const args = await readArgs(c.argsFile);

    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(valueOf(args, '--cd')).toBe(c.dir);
    expect(valueOf(args, '-m')).toBe('gpt-5-codex');
    expect(valueOf(args, '--sandbox')).toBe('read-only');
    expect(args).toContain('--ignore-user-config');
    expect(args).toContain('tools.web_search=false');
    const schemaPath = valueOf(args, '--output-schema')!;
    expect(JSON.parse(await readFile(schemaPath, 'utf8'))).toEqual(schema);
    expect(basename(valueOf(args, '-o')!)).toBe('result-transcript.json');
    expect(await readFile(c.promptFile, 'utf8')).toContain('fais le job');
  });

  it('concatène l’appendice système au prompt sur stdin (codex n’a pas de system prompt dédié)', async () => {
    const c = await ctx({ lines: [threadStarted(), turnCompleted()], fake: { FAKE_CODEX_RESULT: '{}' } });
    await runner().run(c.opts);
    expect(await readFile(c.promptFile, 'utf8')).toBe('consignes maison\n\nfais le job');
  });

  it('phase implement : sandbox workspace-write', async () => {
    const c = await ctx({ lines: [threadStarted(), turnCompleted()], fake: { FAKE_CODEX_RESULT: '{}' }, opts: { phase: 'implement' } });
    await runner().run(c.opts);
    expect(valueOf(await readArgs(c.argsFile), '--sandbox')).toBe('workspace-write');
  });

  it('phase absente : sandbox read-only (mode sûr par défaut)', async () => {
    const c = await ctx({ lines: [threadStarted(), turnCompleted()], fake: { FAKE_CODEX_RESULT: '{}' }, opts: { phase: undefined } });
    await runner().run(c.opts);
    expect(valueOf(await readArgs(c.argsFile), '--sandbox')).toBe('read-only');
  });

  it('sans modèle : -m disparaît, la CLI choisit son défaut', async () => {
    const c = await ctx({ lines: [threadStarted(), turnCompleted()], fake: { FAKE_CODEX_RESULT: '{}' }, opts: { model: undefined } });
    await runner().run(c.opts);
    const args = await readArgs(c.argsFile);
    expect(args).not.toContain('-m');
  });

  it('sans schéma : --output-schema disparaît, -o reste', async () => {
    const c = await ctx({ lines: [threadStarted(), turnCompleted()], fake: { FAKE_CODEX_RESULT: '{}' }, opts: { outputSchema: undefined } });
    await runner().run(c.opts);
    const args = await readArgs(c.argsFile);
    expect(args).not.toContain('--output-schema');
    expect(args).toContain('-o');
  });

  it('reprise : exec resume <id> en tête', async () => {
    const c = await ctx({ lines: [threadStarted(), turnCompleted()], fake: { FAKE_CODEX_RESULT: '{}' }, opts: { resumeSessionId: 'thread-precedent' } });
    await runner().run(c.opts);
    const args = await readArgs(c.argsFile);
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-precedent']);
  });

  it('les fichiers par appel sont nommés d’après le transcript, pas d’après un compteur d’instance', async () => {
    const c = await ctx({ lines: [threadStarted(), turnCompleted()], fake: { FAKE_CODEX_RESULT: '{}' }, opts: { outputSchema: schema } });
    const transcriptPath = join(c.dir, 'transcript-implement-2.jsonl');
    await runner().run({ ...c.opts, transcriptPath });
    const args = await readArgs(c.argsFile);
    expect(basename(valueOf(args, '-o')!)).toBe('result-implement-2.json');
    expect(basename(valueOf(args, '--output-schema')!)).toBe('schema-implement-2.json');
  });
});

describe('CodexAgentRunner : résultat', () => {
  it('mappe un succès depuis le fichier -o, la session et l’usage', async () => {
    const c = await ctx({ lines: [threadStarted(), turnStarted, agentMessage(), turnCompleted()], fake: { FAKE_CODEX_RESULT: JSON.stringify({ answer: 'ok' }) } });
    const r = await runner().run<{ answer: string }>(c.opts);
    expect(r.stopReason).toBe('completed');
    expect(r.output).toEqual({ answer: 'ok' });
    expect(r.sessionId).toBe('thread-1');
    expect(r.costUsd).toBe(0);
    expect(r.numTurns).toBe(1);
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 0 });
    const lines = (await readFile(c.opts.transcriptPath, 'utf8')).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
  });

  it('résultat absent : output nul et erreur mentionnant le code de sortie', async () => {
    const c = await ctx({ lines: [threadStarted(), turnCompleted()] });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('error');
    expect(r.output).toBeNull();
    expect(r.errorMessage).toContain('résultat');
  });

  it('une ligne non JSON est conservée telle quelle sous sisyphe_raw', async () => {
    const c = await ctx({ lines: ['pas du json', threadStarted(), turnCompleted()], fake: { FAKE_CODEX_RESULT: '{}' } });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('completed');
    const first = JSON.parse((await readFile(c.opts.transcriptPath, 'utf8')).split('\n')[0]);
    expect(first).toEqual({ type: 'sisyphe_raw', data: 'pas du json' });
  });

  it('turn.failed : stopReason error, message remonté', async () => {
    const c = await ctx({
      lines: [threadStarted(), JSON.stringify({ type: 'turn.failed', error: { message: 'le modèle a explosé' } })],
      fake: { FAKE_CODEX_RESULT: '{}' },
    });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('error');
    expect(r.errorMessage).toContain('le modèle a explosé');
  });

  it('un événement error non terminal n’échoue pas un run réussi', async () => {
    const c = await ctx({
      lines: [threadStarted(), JSON.stringify({ type: 'error', message: 'transitoire' }), turnCompleted()],
      fake: { FAKE_CODEX_RESULT: JSON.stringify({ answer: 'ok' }) },
    });
    const r = await runner().run<{ answer: string }>(c.opts);
    expect(r.stopReason).toBe('completed');
    expect(r.output).toEqual({ answer: 'ok' });
    expect(r.errorMessage).toBeUndefined();
  });

  it('sortie non nulle avec résultat écrit : error, le code de sortie prime', async () => {
    const c = await ctx({ lines: [threadStarted(), turnCompleted()], fake: { FAKE_CODEX_RESULT: '{"answer":"ok"}', FAKE_CODEX_EXIT: '1' } });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('error');
    expect(r.errorMessage).toBeTruthy();
  });

  it('un résultat résiduel d’un run précédent est supprimé avant lancement', async () => {
    const c = await ctx({ lines: [threadStarted(), turnCompleted()] });
    await writeFile(join(c.dir, 'result-transcript.json'), '{"answer":"périmé"}');
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('error');
    expect(r.output).toBeNull();
  });

  it('une ligne coupée entre deux écritures est recollée', async () => {
    const whole = turnCompleted();
    const cut = Math.floor(whole.length / 2);
    const c = await ctx({ rawScript: whole.slice(0, cut), lateLines: [whole.slice(cut)], fake: { FAKE_CODEX_RESULT: '{}', FAKE_CODEX_SLEEP: '0.3' } });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('completed');
    expect(r.usage.inputTokens).toBe(100);
  });
});

/** Le pid du `sleep` enfant : présent (le fake a bien démarré) puis disparu (tout le groupe a été tué). */
async function expectGroupKilled(childPidFile: string): Promise<void> {
  const pid = Number((await readFile(childPidFile, 'utf8')).trim());
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  await new Promise((r) => setTimeout(r, 200));
  expect(() => process.kill(pid, 0)).toThrow();
}

describe('CodexAgentRunner : arrêts', () => {
  it('timeout : tue tout le groupe de processus sans attendre la fin du sleep', async () => {
    const c = await ctx({ lines: [threadStarted()], fake: { FAKE_CODEX_SLEEP: '5' }, opts: { timeoutMs: 500 } });
    const started = Date.now();
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.sessionId).toBe('thread-1');
    await expectGroupKilled(c.childPidFile);
  });

  it('abort : tue tout le groupe de processus', async () => {
    const controller = new AbortController();
    const c = await ctx({ lines: [threadStarted()], fake: { FAKE_CODEX_SLEEP: '5' }, opts: { signal: controller.signal } });
    setTimeout(() => controller.abort('cancelled'), 200);
    const started = Date.now();
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(3000);
    await expectGroupKilled(c.childPidFile);
  });

  it('la tête sort mais un descendant garde stdout : le timeout tue quand même le groupe', async () => {
    const c = await ctx({
      lines: [threadStarted(), turnCompleted()],
      fake: { FAKE_CODEX_RESULT: JSON.stringify({ answer: 'ok' }), FAKE_CODEX_ORPHAN_SLEEP: '25' },
      opts: { timeoutMs: 1000 },
    });
    const started = Date.now();
    const r = await runner().run<{ answer: string }>(c.opts);
    expect(Date.now() - started).toBeLessThan(4000);
    // Le run a été tué : stopReason honnête, mais le résultat déjà écrit reste exploitable.
    expect(r.stopReason).toBe('timeout');
    expect(r.output).toEqual({ answer: 'ok' });
    await expectGroupKilled(c.childPidFile);
  });

  it('signal déjà annulé : la CLI n’est jamais lancée', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    const c = await ctx({ lines: [threadStarted()], fake: { FAKE_CODEX_RESULT: '{}' }, opts: { signal: controller.signal } });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('aborted');
    await expect(readFile(c.argsFile, 'utf8')).rejects.toThrow();
  });
});

describe('CodexAgentRunner : binaire introuvable', () => {
  it('erreur nommant le binaire et le code, sans recopier la ligne de commande', async () => {
    const c = await ctx({ lines: [threadStarted()] });
    const missing = new CodexAgentRunner({ bin: '/introuvable/codex-xyz' });
    const r = await missing.run(c.opts);
    expect(r.stopReason).toBe('error');
    expect(r.errorMessage).toContain('codex-xyz');
    expect(r.errorMessage).toContain('ENOENT');
    expect(r.errorMessage).not.toContain('--json');
  });
});
