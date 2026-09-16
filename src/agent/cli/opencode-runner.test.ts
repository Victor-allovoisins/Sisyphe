import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildOpenCodeArgs,
  buildOpenCodePermission,
  extractLastJsonObject,
  OpenCodeAgentRunner,
} from './opencode-runner.js';
import type { AgentRunOptions } from '../runner.js';

const FAKE_OPENCODE = fileURLToPath(new URL('../../../test/fakes/fake-opencode.sh', import.meta.url));

// Formes réelles (opencode 1.18.30, `--format json`) : l'identifiant de message vit dans `part.messageID`,
// les tokens dans `part.tokens` avec le cache imbriqué (`cache: { read, write }`), le coût dans `part.cost`.
const textLine = (text: string, sessionID = 'ses-1', messageID?: string) =>
  JSON.stringify({ type: 'text', sessionID, part: { type: 'text', text, ...(messageID ? { messageID } : {}) } });
const usageLine = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'step_finish',
    sessionID: 'ses-1',
    part: {
      type: 'step-finish',
      tokens: { total: 107, input: 100, output: 20, reasoning: 0, cache: { write: 2, read: 5 } },
      cost: 0.03,
      ...over,
    },
  });
const errorLine = (message = 'le modèle a explosé') =>
  JSON.stringify({ type: 'error', sessionID: 'ses-1', error: { message } });

/** Capture réelle d'un run trivial (`opencode-go/deepseek-v4.1-flash`), copiée telle quelle. */
const REAL_SAMPLE = [
  '{"type":"step_start","timestamp":1789395579681,"sessionID":"ses_f5fb654f4ffehHkQ111O67CqgY","part":{"id":"prt_0a049b31e0017fC7bhWNmkY5ou","messageID":"msg_0a049abee001Xkif7xza1JyO7s","sessionID":"ses_f5fb654f4ffehHkQ111O67CqgY","type":"step-start"}}',
  '{"type":"tool_use","timestamp":1789395581203,"sessionID":"ses_f5fb654f4ffehHkQ111O67CqgY","part":{"type":"tool","tool":"bash","callID":"call_00_XupvH2F61oSQOPnqhIGw7035","state":{"status":"completed","input":{"command":"ls -1"},"output":"a\\nb\\n","metadata":{"exit":0},"title":"ls -1","time":{"start":1789395581131,"end":1789395581191}},"id":"prt_0a049b8c3001JnI2h2wa35yIXD","sessionID":"ses_f5fb654f4ffehHkQ111O67CqgY","messageID":"msg_0a049abee001Xkif7xza1JyO7s"}}',
  '{"type":"step_finish","timestamp":1789395581203,"sessionID":"ses_f5fb654f4ffehHkQ111O67CqgY","part":{"id":"prt_0a049b90a001mKCRnH5qFAton0","reason":"tool-calls","messageID":"msg_0a049abee001Xkif7xza1JyO7s","sessionID":"ses_f5fb654f4ffehHkQ111O67CqgY","type":"step-finish","tokens":{"total":11314,"input":11226,"output":39,"reasoning":49,"cache":{"write":0,"read":0}},"cost":0.0017367}}',
  '{"type":"step_start","timestamp":1789395582056,"sessionID":"ses_f5fb654f4ffehHkQ111O67CqgY","part":{"id":"prt_0a049bc66001LdyQ7TsyoUNzVy","messageID":"msg_0a049b910001SpywnzH6bmk910","sessionID":"ses_f5fb654f4ffehHkQ111O67CqgY","type":"step-start"}}',
  '{"type":"text","timestamp":1789395583110,"sessionID":"ses_f5fb654f4ffehHkQ111O67CqgY","part":{"id":"prt_0a049bfa7001YxKASWfOQCEGq4","messageID":"msg_0a049b910001SpywnzH6bmk910","sessionID":"ses_f5fb654f4ffehHkQ111O67CqgY","type":"text","text":"a\\nb\\n\\n{\\"ok\\":true}","time":{"start":1789395582887,"end":1789395583102}}}',
  '{"type":"step_finish","timestamp":1789395583110,"sessionID":"ses_f5fb654f4ffehHkQ111O67CqgY","part":{"id":"prt_0a049c080001q6qWLwLqWXjHBD","reason":"stop","messageID":"msg_0a049b910001SpywnzH6bmk910","sessionID":"ses_f5fb654f4ffehHkQ111O67CqgY","type":"step-finish","tokens":{"total":11416,"input":232,"output":48,"reasoning":0,"cache":{"write":0,"read":11136}},"cost":0.000097008}}',
];

/** Capture réelle d'un échec d'authentification (opencode zen, solde insuffisant). */
const REAL_ERROR =
  '{"type":"error","timestamp":1789395552701,"sessionID":"ses_f5fb6bc6fffediCqltJppwYZht","error":{"name":"APIError","data":{"message":"Insufficient balance. Manage your billing here","statusCode":401,"isRetryable":false}}}';

interface Ctx {
  dir: string;
  argsFile: string;
  promptFile: string;
  envFile: string;
  childPidFile: string;
  opts: AgentRunOptions;
}

/** Prépare un dossier de travail, un script JSONL pour le faux `opencode` et des options complètes. */
async function ctx(o: { lines?: string[]; rawScript?: string; lateLines?: string[]; fake?: Record<string, string>; opts?: Partial<AgentRunOptions> } = {}): Promise<Ctx> {
  const dir = await mkdtemp(join(tmpdir(), 'sisyphe-opencode-'));
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
    FAKE_OPENCODE_ARGS_FILE: argsFile,
    FAKE_OPENCODE_PROMPT_FILE: promptFile,
    FAKE_OPENCODE_ENV_FILE: envFile,
    FAKE_OPENCODE_CHILD_PID_FILE: childPidFile,
    FAKE_OPENCODE_SCRIPT: scriptFile,
    ...(o.lateLines ? { FAKE_OPENCODE_LATE_SCRIPT: lateFile } : {}),
    ...(o.fake ?? {}),
  };
  return {
    dir, argsFile, promptFile, envFile, childPidFile,
    opts: {
      cwd: dir, model: 'openai/gpt-5-codex', phase: 'implement', systemPromptAppend: 'consignes maison', prompt: 'fais le job',
      maxTurns: 7, maxBudgetUsd: 2.5, allowedTools: ['Read', 'Edit'], disallowedTools: [],
      env, timeoutMs: 10_000, signal: new AbortController().signal, transcriptPath: join(dir, 'transcript.jsonl'),
      ...(o.opts ?? {}),
    },
  };
}

const runner = () => new OpenCodeAgentRunner({ bin: FAKE_OPENCODE });

/** Un argument vide est une ligne vide : on ne filtre que le saut de ligne final. */
async function readArgs(file: string): Promise<string[]> {
  const raw = await readFile(file, 'utf8');
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

const valueOf = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

const BASE_PERMISSION = { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', external_directory: 'deny' };

describe('buildOpenCodePermission : allowlist des outils', () => {
  it('triage (sans Edit/Write) : seuls read/glob/grep, edit et bash refusés par *', () => {
    const perm = buildOpenCodePermission({ allowedTools: ['Read'], phase: 'triage' } as AgentRunOptions);
    expect(perm).toEqual(BASE_PERMISSION);
    expect(perm.edit).toBeUndefined();
    expect(perm.bash).toBeUndefined();
  });

  it('triage avec chemins protégés : read reste autorisé sauf les motifs protégés', () => {
    const perm = buildOpenCodePermission({
      allowedTools: ['Read'],
      phase: 'triage',
      pathGuard: { worktreePath: '/wt', protectedPatterns: ['secrets/**'] },
    } as AgentRunOptions);
    expect(perm.read).toEqual({ '*': 'allow', 'secrets/**': 'deny', '**/secrets/**': 'deny' });
    expect(perm.edit).toBeUndefined();
    expect(perm.bash).toBeUndefined();
  });

  it('implémentation (Edit) : edit autorisé puis motifs protégés en deny, bash autorisé', () => {
    const perm = buildOpenCodePermission({
      allowedTools: ['Read', 'Edit'],
      pathGuard: { worktreePath: '/wt', protectedPatterns: ['secrets/**', '.env'] },
    } as AgentRunOptions);
    expect(perm).toEqual({
      ...BASE_PERMISSION,
      read: { '*': 'allow', 'secrets/**': 'deny', '**/secrets/**': 'deny', '.env': 'deny', '**/.env': 'deny' },
      edit: { '*': 'allow', 'secrets/**': 'deny', '**/secrets/**': 'deny', '.env': 'deny', '**/.env': 'deny' },
      bash: 'allow',
    });
  });

  it('implémentation (Write) déclenche aussi edit', () => {
    const perm = buildOpenCodePermission({ allowedTools: ['Write'], pathGuard: { worktreePath: '/wt', protectedPatterns: [] } } as unknown as AgentRunOptions);
    expect(perm.edit).toEqual({ '*': 'allow' });
    expect(perm.bash).toBe('allow');
  });

  it('sans pathGuard : edit autorisé sans motif de refus', () => {
    const perm = buildOpenCodePermission({ allowedTools: ['Edit'] } as AgentRunOptions);
    expect(perm.edit).toEqual({ '*': 'allow' });
  });

  it('webfetch et websearch ne sont jamais autorisés, même demandés', () => {
    const perm = buildOpenCodePermission({ allowedTools: ['Edit', 'WebFetch', 'WebSearch', 'webfetch'] } as AgentRunOptions);
    expect(perm.webfetch).toBeUndefined();
    expect(perm.websearch).toBeUndefined();
    expect(perm['*']).toBe('deny');
  });
});

describe('buildOpenCodeArgs', () => {
  it('run --format json --auto, -m si modèle, --session si reprise', () => {
    const args = buildOpenCodeArgs({ model: 'openai/gpt-5-codex', resumeSessionId: 'ses-precedente' } as AgentRunOptions);
    expect(args.slice(0, 4)).toEqual(['run', '--format', 'json', '--auto']);
    expect(valueOf(args, '-m')).toBe('openai/gpt-5-codex');
    expect(valueOf(args, '--session')).toBe('ses-precedente');
  });

  it('sans modèle ni reprise : -m et --session disparaissent', () => {
    const args = buildOpenCodeArgs({} as AgentRunOptions);
    expect(args).not.toContain('-m');
    expect(args).not.toContain('--session');
  });
});

describe('extractLastJsonObject', () => {
  it('lit un objet JSON nu', () => {
    expect(extractLastJsonObject('{"answer":"ok"}')).toEqual({ answer: 'ok' });
  });

  it('lit un objet dans du texte et un bloc Markdown', () => {
    expect(extractLastJsonObject('Voici le verdict.\n\n```json\n{"answer":"ok"}\n```\n')).toEqual({ answer: 'ok' });
  });

  it('quand plusieurs objets se suivent, garde le dernier', () => {
    expect(extractLastJsonObject('{"a":1} puis {"answer":"ok"}')).toEqual({ answer: 'ok' });
  });

  it('ne se laisse pas piéger par les accolades dans une chaîne', () => {
    expect(extractLastJsonObject('{"note":"a { brace }","answer":"ok"}')).toEqual({ note: 'a { brace }', answer: 'ok' });
  });

  it('lit l’objet externe, pas l’imbriqué', () => {
    expect(extractLastJsonObject('{"answer":{"nested":1}}')).toEqual({ answer: { nested: 1 } });
  });

  it('JSON invalide : null, sans planter', () => {
    expect(extractLastJsonObject('{"answer": ')).toBeNull();
    expect(extractLastJsonObject('{pas du json}')).toBeNull();
  });

  it('aucun objet : null', () => {
    expect(extractLastJsonObject('aucun json ici')).toBeNull();
    expect(extractLastJsonObject('')).toBeNull();
  });
});

describe('OpenCodeAgentRunner : arguments et environnement', () => {
  it('lance run --format json --auto, met l’appendice sur stdin et OPENCODE_PERMISSION dans l’env', async () => {
    const c = await ctx({
      lines: [textLine('{"answer":"ok"}')],
      opts: { phase: 'triage', allowedTools: ['Read'], pathGuard: { worktreePath: '/wt', protectedPatterns: ['secrets/**'] } },
    });
    await runner().run(c.opts);
    const args = await readArgs(c.argsFile);

    expect(args.slice(0, 4)).toEqual(['run', '--format', 'json', '--auto']);
    expect(valueOf(args, '-m')).toBe('openai/gpt-5-codex');
    expect(await readFile(c.promptFile, 'utf8')).toBe('consignes maison\n\nfais le job');

    const childEnv = new Map(
      (await readFile(c.envFile, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as const),
    );
    expect(JSON.parse(childEnv.get('OPENCODE_PERMISSION')!)).toEqual({
      ...BASE_PERMISSION,
      read: { '*': 'allow', 'secrets/**': 'deny', '**/secrets/**': 'deny' },
    });
  });

  it('ajoute le schéma JSON sérialisé après le prompt quand outputSchema est fourni', async () => {
    const schema = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };
    const c = await ctx({ lines: [textLine('{"answer":"ok"}')], opts: { outputSchema: schema } });
    await runner().run(c.opts);
    const stdin = await readFile(c.promptFile, 'utf8');
    const systemIdx = stdin.indexOf('consignes maison');
    const promptIdx = stdin.indexOf('fais le job');
    const schemaIdx = stdin.indexOf('Schéma JSON à respecter :');
    expect(systemIdx).toBeGreaterThanOrEqual(0);
    expect(promptIdx).toBeGreaterThan(systemIdx);
    expect(schemaIdx).toBeGreaterThan(promptIdx);
    expect(stdin).toContain(JSON.stringify(schema, null, 2));
  });

  it('sans modèle : -m disparaît, la CLI choisit son défaut', async () => {
    const c = await ctx({ lines: [textLine('{"answer":"ok"}')], opts: { model: undefined } });
    await runner().run(c.opts);
    expect(await readArgs(c.argsFile)).not.toContain('-m');
  });

  it('reprise : --session <id>', async () => {
    const c = await ctx({ lines: [textLine('{"answer":"ok"}')], opts: { resumeSessionId: 'ses-precedente' } });
    await runner().run(c.opts);
    expect(valueOf(await readArgs(c.argsFile), '--session')).toBe('ses-precedente');
  });

  it('phase implémentation : edit et bash autorisés, motifs protégés refusés', async () => {
    const c = await ctx({
      lines: [textLine('{"answer":"ok"}')],
      opts: { allowedTools: ['Read', 'Edit'], pathGuard: { worktreePath: '/wt', protectedPatterns: ['secrets/**'] } },
    });
    await runner().run(c.opts);
    const perm = JSON.parse(
      (await readFile(c.envFile, 'utf8')).split('\n').find((l) => l.startsWith('OPENCODE_PERMISSION='))!.slice('OPENCODE_PERMISSION='.length),
    );
    expect(perm.bash).toBe('allow');
    expect(perm.edit).toEqual({ '*': 'allow', 'secrets/**': 'deny', '**/secrets/**': 'deny' });
    expect(perm.read).toEqual({ '*': 'allow', 'secrets/**': 'deny', '**/secrets/**': 'deny' });
    expect(perm.webfetch).toBeUndefined();
    expect(perm.websearch).toBeUndefined();
  });

  it('ne transmet que o.env plus OPENCODE_PERMISSION', async () => {
    const c = await ctx({ lines: [textLine('{"answer":"ok"}')] });
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
    expect(childEnv.has('OPENCODE_PERMISSION')).toBe(true);
    expect(childEnv.has('SISYPHE_TEST_SECRET')).toBe(false);
    const unexpected = [...childEnv.keys()].filter(
      (k) => !(k in c.opts.env) && k !== 'OPENCODE_PERMISSION' && !['PWD', 'OLDPWD', 'SHLVL', '_'].includes(k),
    );
    expect(unexpected).toEqual([]);
  });
});

describe('OpenCodeAgentRunner : résultat', () => {
  it('mappe un succès : dernier JSON du texte final, session, usage et coût', async () => {
    const c = await ctx({
      lines: [textLine('Je termine.\n\n```json\n{"answer":"ok"}\n```'), usageLine()],
    });
    const r = await runner().run<{ answer: string }>(c.opts);
    expect(r.stopReason).toBe('completed');
    expect(r.output).toEqual({ answer: 'ok' });
    expect(r.sessionId).toBe('ses-1');
    expect(r.costUsd).toBe(0.03);
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheCreationTokens: 2 });
    const types = (await readFile(c.opts.transcriptPath, 'utf8')).trim().split('\n').map((l) => JSON.parse(l).type);
    expect(types).toEqual(['text', 'step_finish']);
  });

  it('texte sans objet JSON : output nul, stopReason error', async () => {
    const c = await ctx({ lines: [textLine('je n’ai pas rendu de JSON final')] });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('error');
    expect(r.output).toBeNull();
    expect(r.errorMessage).toContain('JSON');
  });

  it('JSON invalide : output nul sans planter', async () => {
    const c = await ctx({ lines: [textLine('{"answer": ')] });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('error');
    expect(r.output).toBeNull();
  });

  it('échec terminal : stopReason error mais l’output déjà extrait reste surfacé', async () => {
    const c = await ctx({ lines: [textLine('{"answer":"ok"}'), errorLine('le modèle a explosé')] });
    const r = await runner().run<{ answer: string }>(c.opts);
    expect(r.stopReason).toBe('error');
    expect(r.output).toEqual({ answer: 'ok' });
    expect(r.errorMessage).toContain('le modèle a explosé');
  });

  it('sortie non nulle : error, l’output extrait reste surfacé', async () => {
    const c = await ctx({ lines: [textLine('{"answer":"ok"}')], fake: { FAKE_OPENCODE_EXIT: '1' } });
    const r = await runner().run<{ answer: string }>(c.opts);
    expect(r.stopReason).toBe('error');
    expect(r.output).toEqual({ answer: 'ok' });
    expect(r.errorMessage).toBeTruthy();
  });

  it('un JSON d’un message assistant antérieur n’est pas repris si le message final n’en contient pas', async () => {
    const c = await ctx({
      lines: [
        textLine('Voici le verdict.\n\n```json\n{"answer":"périmé"}\n```', 'ses-1', 'msg-1'),
        textLine('Je n’ai finalement rien à rendre.', 'ses-1', 'msg-2'),
      ],
    });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('error');
    expect(r.output).toBeNull();
  });

  it('seul le JSON du message assistant final est retenu', async () => {
    const c = await ctx({
      lines: [
        textLine('Réflexion intermédiaire sans JSON.', 'ses-1', 'msg-1'),
        textLine('Je termine.\n\n```json\n{"answer":"ok"}\n```', 'ses-1', 'msg-2'),
      ],
    });
    const r = await runner().run<{ answer: string }>(c.opts);
    expect(r.stopReason).toBe('completed');
    expect(r.output).toEqual({ answer: 'ok' });
  });

  it('les fragments d’un même message sont recollés avant extraction', async () => {
    const c = await ctx({
      lines: [textLine('{"answer":', 'ses-1', 'msg-1'), textLine('"ok"}', 'ses-1', 'msg-1')],
    });
    const r = await runner().run<{ answer: string }>(c.opts);
    expect(r.stopReason).toBe('completed');
    expect(r.output).toEqual({ answer: 'ok' });
  });

  it('une ligne non JSON est conservée telle quelle sous sisyphe_raw', async () => {
    const c = await ctx({ lines: ['pas du json', textLine('{"answer":"ok"}')] });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('completed');
    const first = JSON.parse((await readFile(c.opts.transcriptPath, 'utf8')).split('\n')[0]);
    expect(first).toEqual({ type: 'sisyphe_raw', data: 'pas du json' });
  });

  it('une ligne coupée entre deux écritures est recollée', async () => {
    const whole = textLine('{"answer":"ok"}');
    const cut = Math.floor(whole.length / 2);
    const c = await ctx({ rawScript: whole.slice(0, cut), lateLines: [whole.slice(cut)], fake: { FAKE_OPENCODE_SLEEP: '0.3' } });
    const r = await runner().run<{ answer: string }>(c.opts);
    expect(r.stopReason).toBe('completed');
    expect(r.output).toEqual({ answer: 'ok' });
  });
});

describe('OpenCodeAgentRunner : captures réelles (formes épinglées)', () => {
  it('mappe un run réel : objet JSON final, session, usage (cache imbriqué) et coût cumulé', async () => {
    const c = await ctx({ lines: REAL_SAMPLE });
    const r = await runner().run<{ ok: boolean }>(c.opts);
    expect(r.stopReason).toBe('completed');
    expect(r.output).toEqual({ ok: true });
    expect(r.sessionId).toBe('ses_f5fb654f4ffehHkQ111O67CqgY');
    expect(r.usage).toEqual({ inputTokens: 11458, outputTokens: 87, cacheReadTokens: 11136, cacheCreationTokens: 0 });
    // Le coût réel est par étape (0.0017367 puis 0.000097008), pas un total cumulé : il faut sommer.
    expect(r.costUsd).toBeCloseTo(0.001833708, 9);
    // Un « tour » opencode = un `step_finish` (deux dans l'échantillon réel).
    expect(r.numTurns).toBe(2);
  });

  it('erreur réelle : le message vient de error.data.message', async () => {
    const c = await ctx({ lines: [REAL_ERROR] });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('error');
    expect(r.sessionId).toBe('ses_f5fb6bc6fffediCqltJppwYZht');
    expect(r.errorMessage).toContain('Insufficient balance');
  });

  it('le coût est cumulé entre étapes (les totaux par étape ne sont pas cumulés)', async () => {
    const c = await ctx({ lines: [textLine('{"answer":"ok"}'), usageLine({ cost: 0.0017367 }), usageLine({ cost: 0.000097008 })] });
    const r = await runner().run(c.opts);
    expect(r.costUsd).toBeCloseTo(0.001833708, 9);
  });
});

/** Le pid du `sleep` enfant : présent (le fake a bien démarré) puis disparu (tout le groupe a été tué). */
async function expectGroupKilled(childPidFile: string): Promise<void> {
  const pid = Number((await readFile(childPidFile, 'utf8')).trim());
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  await new Promise((r) => setTimeout(r, 200));
  expect(() => process.kill(pid, 0)).toThrow();
}

describe('OpenCodeAgentRunner : arrêts', () => {
  it('timeout : tue tout le groupe de processus sans attendre la fin du sleep', async () => {
    const c = await ctx({ lines: [textLine('{"answer":"ok"}')], fake: { FAKE_OPENCODE_SLEEP: '5' }, opts: { timeoutMs: 500 } });
    const started = Date.now();
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.sessionId).toBe('ses-1');
    await expectGroupKilled(c.childPidFile);
  });

  it('abort : tue tout le groupe de processus', async () => {
    const controller = new AbortController();
    const c = await ctx({ lines: [textLine('{"answer":"ok"}')], fake: { FAKE_OPENCODE_SLEEP: '5' }, opts: { signal: controller.signal } });
    setTimeout(() => controller.abort('cancelled'), 200);
    const started = Date.now();
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(3000);
    await expectGroupKilled(c.childPidFile);
  });

  it('la tête sort mais un descendant garde stdout : le timeout tue quand même le groupe', async () => {
    const c = await ctx({
      lines: [textLine('{"answer":"ok"}')],
      fake: { FAKE_OPENCODE_ORPHAN_SLEEP: '25' },
      opts: { timeoutMs: 1000 },
    });
    const started = Date.now();
    const r = await runner().run<{ answer: string }>(c.opts);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r.stopReason).toBe('timeout');
    expect(r.output).toEqual({ answer: 'ok' });
    await expectGroupKilled(c.childPidFile);
  });

  it('signal déjà annulé : la CLI n’est jamais lancée', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    const c = await ctx({ lines: [textLine('{"answer":"ok"}')], opts: { signal: controller.signal } });
    const r = await runner().run(c.opts);
    expect(r.stopReason).toBe('aborted');
    await expect(readFile(c.argsFile, 'utf8')).rejects.toThrow();
  });
});

describe('OpenCodeAgentRunner : binaire introuvable', () => {
  it('erreur nommant le binaire et le code, sans recopier la ligne de commande', async () => {
    const c = await ctx({ lines: [textLine('{"answer":"ok"}')] });
    const missing = new OpenCodeAgentRunner({ bin: '/introuvable/opencode-xyz' });
    const r = await missing.run(c.opts);
    expect(r.stopReason).toBe('error');
    expect(r.errorMessage).toContain('opencode-xyz');
    expect(r.errorMessage).toContain('ENOENT');
    expect(r.errorMessage).not.toContain('--format');
  });
});
