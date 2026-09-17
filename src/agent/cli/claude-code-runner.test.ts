import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAgentRunner, buildCliArgs } from './claude-code-runner.js';
import { agentPluginPath } from '../plugin-path.js';
import type { AgentRunOptions } from '../runner.js';

const FAKE_CLAUDE = fileURLToPath(new URL('../../../test/fakes/fake-claude.sh', import.meta.url));
// Le runner refuse de démarrer si le script du hook n'existe pas : on pointe sur un fichier réel
// (la source du hook, restée dans `src/agent/`), jamais exécuté ici puisque le faux `claude` n'appelle aucun hook.
const HOOK_SCRIPT = fileURLToPath(new URL('../path-guard-cli.ts', import.meta.url));
const BASH_HOOK_SCRIPT = fileURLToPath(new URL('../bash-guard-cli.ts', import.meta.url));

const initLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', cwd: '/wt' });
const assistantLine = JSON.stringify({
  type: 'assistant', parent_tool_use_id: null,
  message: { id: 'm1', usage: { input_tokens: 11, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } },
});
const resultLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, num_turns: 4, total_cost_usd: 0.42, session_id: 'sess-1',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 2 },
    structured_output: { answer: 'ok' }, result: 'terminé', ...over,
  });

interface Ctx {
  dir: string;
  argsFile: string;
  promptFile: string;
  envFile: string;
  childPidFile: string;
  opts: AgentRunOptions;
}

/** Prépare un dossier de travail, un script JSONL pour le faux `claude` et des options complètes. */
async function ctx(o: { lines?: string[]; rawScript?: string; lateLines?: string[]; fake?: Record<string, string>; opts?: Partial<AgentRunOptions> } = {}): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), 'sisyphe-cli-'));
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
    FAKE_CLAUDE_ARGS_FILE: argsFile,
    FAKE_CLAUDE_PROMPT_FILE: promptFile,
    FAKE_CLAUDE_ENV_FILE: envFile,
    FAKE_CLAUDE_CHILD_PID_FILE: childPidFile,
    FAKE_CLAUDE_SCRIPT: scriptFile,
    ...(o.lateLines ? { FAKE_CLAUDE_LATE_SCRIPT: lateFile } : {}),
    ...(o.fake ?? {}),
  };
  return {
    dir, argsFile, promptFile, envFile, childPidFile,
    opts: {
      cwd: dir, model: 'claude-sonnet-5', systemPromptAppend: 'consignes maison', prompt: 'fais le job',
      maxTurns: 7, maxBudgetUsd: 2.5, allowedTools: ['Read', 'Edit'], disallowedTools: ['WebFetch'],
      env, timeoutMs: 10_000, signal: new AbortController().signal, transcriptPath: join(dir, 'transcript.jsonl'),
      ...(o.opts ?? {}),
    },
  };
}

const runner = () => new ClaudeCodeAgentRunner({ claudeBin: FAKE_CLAUDE, hookScript: HOOK_SCRIPT, bashHookScript: BASH_HOOK_SCRIPT });

/** Un argument vide est une ligne vide : on ne filtre que le saut de ligne final. */
async function readArgs(file: string): Promise<string[]> {
  const raw = await readFile(file, 'utf8');
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

const valueOf = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];
const valuesOf = (args: string[], flag: string, n: number): string[] => args.slice(args.indexOf(flag) + 1, args.indexOf(flag) + 1 + n);

const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

/** Options minimales pour les tests qui appellent `buildCliArgs` sans lancer de processus. */
const argOptions = (): AgentRunOptions => ({
  cwd: '/jobs/job-1', systemPromptAppend: 'append', prompt: 'p', maxTurns: 3, maxBudgetUsd: 1,
  allowedTools: ['Bash'], disallowedTools: [], env: {}, timeoutMs: 1000,
  signal: new AbortController().signal, transcriptPath: '/t.jsonl',
});

describe('ClaudeCodeAgentRunner : arguments', () => {
  it('passe les garde-fous, la liste blanche, le schéma, le prompt sur stdin et le system prompt par fichier', async () => {
    const c = await ctx({
      lines: [initLine, resultLine()],
      opts: {
        outputSchema: schema,
        resumeSessionId: 'sess-precedente',
        pathGuard: { worktreePath: '/wt', protectedPatterns: ['secrets/**'] },
      },
    });
    await runner().run(c.opts);
    const args = await readArgs(c.argsFile);

    expect(args).toContain('-p');
    expect(args).toContain('--verbose');
    expect(valueOf(args, '--output-format')).toBe('stream-json');
    expect(valueOf(args, '--permission-mode')).toBe('dontAsk');
    expect(valueOf(args, '--permission-prompts')).toBe('none');
    expect(valueOf(args, '--setting-sources')).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(valuesOf(args, '--tools', 2)).toEqual(['Read', 'Edit']);
    expect(valuesOf(args, '--allowedTools', 2)).toEqual(['Read', 'Edit']);
    expect(valuesOf(args, '--disallowedTools', 1)).toEqual(['WebFetch']);
    expect(valueOf(args, '--model')).toBe('claude-sonnet-5');
    expect(valueOf(args, '--max-turns')).toBe('7');
    expect(valueOf(args, '--max-budget-usd')).toBe('2.5');
    expect(valueOf(args, '--json-schema')).toBe(JSON.stringify(schema));
    expect(valueOf(args, '--resume')).toBe('sess-precedente');

    const appendFilePath = valueOf(args, '--append-system-prompt-file')!;
    expect(await readFile(appendFilePath, 'utf8')).toBe('consignes maison');
    expect(await readFile(c.promptFile, 'utf8')).toBe('fais le job');
  });

  it('sans modèle : --model disparaît, la CLI choisit son défaut', async () => {
    const c = await ctx({ lines: [initLine, resultLine()], opts: { model: undefined } });
    await runner().run(c.opts);
    const args = await readArgs(c.argsFile);
    expect(args).not.toContain('--model');
  });

  it('sans pathGuard, sans schéma et sans resume : les drapeaux correspondants disparaissent', async () => {
    const c = await ctx({ lines: [initLine, resultLine()] });
    await runner().run(c.opts);
    const args = await readArgs(c.argsFile);
    expect(args).not.toContain('--settings');
    expect(args).not.toContain('--json-schema');
    expect(args).not.toContain('--resume');
  });

  it('écrit un fichier de settings avec le seul hook PreToolUse de garde des chemins', async () => {
    const c = await ctx({
      lines: [initLine, resultLine()],
      opts: { pathGuard: { worktreePath: '/wt', protectedPatterns: ['secrets/**'] } },
    });
    await runner().run(c.opts);
    const args = await readArgs(c.argsFile);
    const settingsPath = valueOf(args, '--settings')!;
    expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({
      hooks: {
        PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: `"${process.execPath}" "${HOOK_SCRIPT}"`, timeout: 15 }] }],
      },
    });
  });

  it('avec bashGuard : le hook Bash s’ajoute au fichier de settings', async () => {
    const c = await ctx({
      lines: [initLine, resultLine()],
      opts: { pathGuard: { worktreePath: '/wt', protectedPatterns: [] }, bashGuard: true },
    });
    await runner().run(c.opts);
    const args = await readArgs(c.argsFile);
    expect(JSON.parse(await readFile(valueOf(args, '--settings')!, 'utf8'))).toEqual({
      hooks: {
        PreToolUse: [
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: `"${process.execPath}" "${HOOK_SCRIPT}"`, timeout: 15 }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: `"${process.execPath}" "${BASH_HOOK_SCRIPT}"`, timeout: 15 }] },
        ],
      },
    });
  });

  // Sans ce cas, `bashGuard` seul n'écrirait aucun fichier de settings : `--settings` disparaîtrait et
  // l'agent tournerait sans garde Bash du tout, alors qu'on l'a justement demandée.
  it('bashGuard sans pathGuard : --settings est quand même passé, avec le hook Bash', async () => {
    const c = await ctx({ lines: [initLine, resultLine()], opts: { bashGuard: true } });
    await runner().run(c.opts);
    const args = await readArgs(c.argsFile);
    const settings = JSON.parse(await readFile(valueOf(args, '--settings')!, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string }> };
    };
    expect(settings.hooks.PreToolUse.map((e) => e.matcher)).toEqual(['Edit|Write', 'Bash']);
  });

  it('sans bashGuard : aucun hook Bash dans les settings', async () => {
    const c = await ctx({ lines: [initLine, resultLine()], opts: { pathGuard: { worktreePath: '/wt', protectedPatterns: [] } } });
    await runner().run(c.opts);
    const args = await readArgs(c.argsFile);
    const settings = JSON.parse(await readFile(valueOf(args, '--settings')!, 'utf8')) as {
      hooks: { PreToolUse: Array<{ matcher: string }> };
    };
    expect(settings.hooks.PreToolUse.map((e) => e.matcher)).toEqual(['Edit|Write']);
  });

  it('avec des skills : --plugin-dir pointe sur le plugin livré avec Sisyphe ; sans, le drapeau disparaît', () => {
    const files = { appendPath: '/tmp/append.md' };
    const withSkills = buildCliArgs({ ...argOptions(), skills: ['sisyphe:sisyphe-jira'] }, files);
    expect(valueOf(withSkills, '--plugin-dir')).toBe(agentPluginPath());
    expect(buildCliArgs(argOptions(), files)).not.toContain('--plugin-dir');
    expect(buildCliArgs({ ...argOptions(), skills: [] }, files)).not.toContain('--plugin-dir');
  });

  /**
   * Sans `Skill` dans `--tools`, le skill se charge et reste malgré tout impossible à invoquer, sans le
   * moindre refus : un test par backend est le seul filet contre cet échec silencieux.
   */
  it("l'outil Skill s'ajoute à --tools, jamais à --allowedTools, et seulement si des skills sont demandés", () => {
    const files = { appendPath: '/tmp/append.md' };
    const withSkills = buildCliArgs({ ...argOptions(), skills: ['sisyphe:sisyphe-jira'] }, files);
    expect(valuesOf(withSkills, '--tools', 2)).toEqual(['Bash', 'Skill']);
    expect(valuesOf(withSkills, '--allowedTools', 1)).toEqual(['Bash']);
    // Une seule occurrence en tout : `Skill` est dans --tools et nulle part ailleurs.
    expect(withSkills.filter((a) => a === 'Skill')).toHaveLength(1);

    for (const skills of [undefined, []]) {
      const args = buildCliArgs({ ...argOptions(), skills }, files);
      expect(valuesOf(args, '--tools', 1)).toEqual(['Bash']);
      expect(args).not.toContain('Skill');
    }
  });
});

describe('ClaudeCodeAgentRunner : résultat', () => {
  it('mappe un succès et écrit le transcript', async () => {
    const c = await ctx({ lines: [initLine, assistantLine, resultLine()] });
    const r = await runner().run<{ answer: string }>(c.opts);
    expect(r.stopReason).toBe('completed');
    expect(r.output).toEqual({ answer: 'ok' });
    expect(r.sessionId).toBe('sess-1');
    expect(r.costUsd).toBe(0.42);
    expect(r.numTurns).toBe(4);
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 2 });
    const lines = (await readFile(c.opts.transcriptPath, 'utf8')).trim().split('\n');
    expect(lines.map((l) => JSON.parse(l).type)).toEqual(['system', 'assistant', 'result']);
  });

  it('une ligne non JSON est conservée telle quelle sous sisyphe_raw', async () => {
    const c = await ctx({ lines: ['pas du json', resultLine()] });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('completed');
    const first = JSON.parse((await readFile(c.opts.transcriptPath, 'utf8')).split('\n')[0]);
    expect(first).toEqual({ type: 'sisyphe_raw', data: 'pas du json' });
  });

  it('une ligne JSON qui n’est pas un objet ne fait pas planter le flux', async () => {
    const c = await ctx({ lines: ['null', '3', '"une chaîne"', resultLine()] });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('completed');
    const lines = (await readFile(c.opts.transcriptPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.slice(0, 3)).toEqual([
      { type: 'sisyphe_raw', data: 'null' },
      { type: 'sisyphe_raw', data: '3' },
      { type: 'sisyphe_raw', data: '"une chaîne"' },
    ]);
  });

  it('une ligne coupée entre deux écritures est recollée', async () => {
    const whole = resultLine();
    const cut = Math.floor(whole.length / 2);
    const c = await ctx({ rawScript: whole.slice(0, cut), lateLines: [whole.slice(cut)], fake: { FAKE_CLAUDE_SLEEP: '0.3' } });
    const r = await runner().run<{ answer: string }>(c.opts);
    expect(r.stopReason).toBe('completed');
    expect(r.output).toEqual({ answer: 'ok' });
  });

  it('les fichiers par appel sont nommés d’après le transcript, pas d’après un compteur d’instance', async () => {
    const c = await ctx({ lines: [resultLine()], opts: { pathGuard: { worktreePath: '/wt', protectedPatterns: [] } } });
    const transcriptPath = join(c.dir, 'transcript-implement-2.jsonl');
    await runner().run({ ...c.opts, transcriptPath });
    const args = await readArgs(c.argsFile);
    expect(basename(valueOf(args, '--append-system-prompt-file')!)).toBe('system-append-implement-2.md');
    expect(basename(valueOf(args, '--settings')!)).toBe('cli-settings-implement-2.json');
  });

  it('result error_max_turns : stopReason max_turns', async () => {
    const c = await ctx({ lines: [initLine, resultLine({ subtype: 'error_max_turns', is_error: true, errors: ['trop de tours'], structured_output: undefined })] });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('max_turns');
    expect(r.errorMessage).toContain('trop de tours');
    expect(r.output).toBeNull();
  });

  it('sortie non nulle sans result : erreur avec la fin de stderr, usage reconstitué depuis les messages assistant', async () => {
    const c = await ctx({ lines: [initLine, assistantLine], fake: { FAKE_CLAUDE_EXIT: '1', FAKE_CLAUDE_STDERR: 'boom : la CLI a explosé' } });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('error');
    expect(r.errorMessage).toContain('boom : la CLI a explosé');
    expect(r.usage).toEqual({ inputTokens: 11, outputTokens: 3, cacheReadTokens: 2, cacheCreationTokens: 1 });
    expect(r.costUsd).toBe(0);
    const types = (await readFile(c.opts.transcriptPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l).type);
    expect(types).toContain('stderr');
  });
});

/** Le pid du `sleep` enfant : présent (le fake a bien démarré) puis disparu (tout le groupe a été tué). */
async function expectGroupKilled(childPidFile: string): Promise<void> {
  const pid = Number((await readFile(childPidFile, 'utf8')).trim());
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  await new Promise((r) => setTimeout(r, 200));
  expect(() => process.kill(pid, 0)).toThrow();
}

describe('ClaudeCodeAgentRunner : arrêts', () => {
  it('timeout : tue tout le groupe de processus sans attendre la fin du sleep', async () => {
    const c = await ctx({ lines: [initLine], fake: { FAKE_CLAUDE_SLEEP: '5' }, opts: { timeoutMs: 500 } });
    const started = Date.now();
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.sessionId).toBe('sess-1');
    await expectGroupKilled(c.childPidFile);
  });

  it('abort : tue tout le groupe de processus', async () => {
    const controller = new AbortController();
    const c = await ctx({ lines: [initLine], fake: { FAKE_CLAUDE_SLEEP: '5' }, opts: { signal: controller.signal } });
    setTimeout(() => controller.abort('cancelled'), 200);
    const started = Date.now();
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(3000);
    await expectGroupKilled(c.childPidFile);
  });

  it('la tête sort mais un descendant garde stdout : le timeout tue quand même le groupe', async () => {
    const c = await ctx({ lines: [initLine, resultLine()], fake: { FAKE_CLAUDE_ORPHAN_SLEEP: '25' }, opts: { timeoutMs: 1000 } });
    const started = Date.now();
    const r = await runner().run<{ answer: string }>(c.opts);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r.output).toEqual({ answer: 'ok' }); // le result est arrivé : seul le traînard a été tué
    await expectGroupKilled(c.childPidFile);
  });

  it('signal déjà annulé : la CLI n’est jamais lancée', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    const c = await ctx({ lines: [resultLine()], opts: { signal: controller.signal } });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('aborted');
    await expect(readFile(c.argsFile, 'utf8')).rejects.toThrow();
  });
});

describe('ClaudeCodeAgentRunner : refus de démarrer', () => {
  it('hookScript absent avec pathGuard : run() rejette et ne lance rien', async () => {
    const c = await ctx({ lines: [resultLine()], opts: { pathGuard: { worktreePath: '/wt', protectedPatterns: [] } } });
    const broken = new ClaudeCodeAgentRunner({ claudeBin: FAKE_CLAUDE, hookScript: '/introuvable/path-guard-cli.js', bashHookScript: BASH_HOOK_SCRIPT });
    await expect(broken.run(c.opts)).rejects.toThrow(/Garde-fou introuvable/);
    await expect(readFile(c.argsFile, 'utf8')).rejects.toThrow();
  });

  it('script du garde Bash absent avec bashGuard : run() rejette plutôt que de tourner sans garde', async () => {
    const c = await ctx({ lines: [resultLine()], opts: { bashGuard: true } });
    const broken = new ClaudeCodeAgentRunner({ claudeBin: FAKE_CLAUDE, hookScript: HOOK_SCRIPT, bashHookScript: '/introuvable/bash-guard-cli.js' });
    await expect(broken.run(c.opts)).rejects.toThrow(/Garde-fou introuvable/);
    await expect(readFile(c.argsFile, 'utf8')).rejects.toThrow();
  });

  // Le fichier de settings référence toujours le garde de chemins, même quand seul `bashGuard` est demandé :
  // s'il manque, Claude Code ignorerait un hook cassé en silence.
  it('bashGuard seul avec un garde de chemins introuvable : run() rejette aussi', async () => {
    const c = await ctx({ lines: [resultLine()], opts: { bashGuard: true } });
    const broken = new ClaudeCodeAgentRunner({ claudeBin: FAKE_CLAUDE, hookScript: '/introuvable/path-guard-cli.js', bashHookScript: BASH_HOOK_SCRIPT });
    await expect(broken.run(c.opts)).rejects.toThrow(/Garde-fou introuvable/);
    await expect(readFile(c.argsFile, 'utf8')).rejects.toThrow();
  });

  it('binaire introuvable : erreur nommant le binaire et le code, sans recopier la ligne de commande', async () => {
    const c = await ctx({ lines: [resultLine()] });
    const missing = new ClaudeCodeAgentRunner({ claudeBin: '/introuvable/claude-xyz', hookScript: HOOK_SCRIPT });
    const r = await missing.run(c.opts);
    expect(r.stopReason).toBe('error');
    expect(r.errorMessage).toContain('claude-xyz');
    expect(r.errorMessage).toContain('ENOENT');
    expect(r.errorMessage).not.toContain('--output-format');
  });
});

describe('ClaudeCodeAgentRunner : environnement', () => {
  it('ne transmet que o.env plus les variables du garde-fou', async () => {
    const c = await ctx({
      lines: [resultLine()],
      opts: { pathGuard: { worktreePath: '/wt', protectedPatterns: ['secrets/**'] } },
    });
    process.env.SISYPHE_TEST_SECRET = 'ne-doit-pas-fuiter';
    try {
      await runner().run(c.opts);
    } finally {
      delete process.env.SISYPHE_TEST_SECRET;
    }
    const childEnv = new Map(
      (await readFile(c.envFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
    );
    for (const [k, v] of Object.entries(c.opts.env)) expect(childEnv.get(k)).toBe(v);
    expect(childEnv.get('SISYPHE_GUARD_WORKTREE')).toBe('/wt');
    expect(childEnv.get('SISYPHE_GUARD_PROTECTED')).toBe(JSON.stringify(['secrets/**']));
    expect(childEnv.has('SISYPHE_TEST_SECRET')).toBe(false);
    // `sh` ajoute ses propres variables (PWD, SHLVL…) : tout le reste vient de o.env.
    const unexpected = [...childEnv.keys()].filter(
      (k) => !(k in c.opts.env) && !k.startsWith('SISYPHE_GUARD_') && !['PWD', 'OLDPWD', 'SHLVL', '_'].includes(k),
    );
    expect(unexpected).toEqual([]);
  });
});
