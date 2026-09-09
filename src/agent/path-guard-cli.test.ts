import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCliSettings } from './cli-runner.js';
import { guardFromHookInput } from './path-guard-cli.js';

const BUILT_SCRIPT = fileURLToPath(new URL('../../dist/agent/path-guard-cli.js', import.meta.url));

const SCRIPT = fileURLToPath(new URL('./path-guard-cli.ts', import.meta.url));
const wt = '/tmp/worktree';
const env = { SISYPHE_GUARD_WORKTREE: wt, SISYPHE_GUARD_PROTECTED: JSON.stringify(['secrets/**']) };
const hookInput = (filePath: unknown) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: filePath } });

const denial = (out: string | null) => JSON.parse(out ?? 'null')?.hookSpecificOutput;

describe('guardFromHookInput', () => {
  it('laisse passer une écriture dans le worktree', () => {
    expect(guardFromHookInput(hookInput(`${wt}/src/a.ts`), env)).toBeNull();
  });

  it('refuse hors du worktree, dans .git et sur un chemin protégé', () => {
    for (const p of ['/etc/passwd', `${wt}/.git/config`, `${wt}/secrets/key.pem`]) {
      expect(denial(guardFromHookInput(hookInput(p), env))).toMatchObject({
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      });
    }
  });

  it('ferme par défaut : stdin illisible, chemin absent, environnement absent ou invalide', () => {
    const reasons = [
      guardFromHookInput('pas du json', env),
      guardFromHookInput(hookInput(undefined), env),
      guardFromHookInput(hookInput(`${wt}/src/a.ts`), {}),
      guardFromHookInput(hookInput(`${wt}/src/a.ts`), { ...env, SISYPHE_GUARD_PROTECTED: '"pas un tableau"' }),
    ];
    for (const r of reasons) {
      expect(denial(r)?.permissionDecision).toBe('deny');
      expect(denial(r)?.permissionDecisionReason).toBeTruthy();
    }
  });
});

describe('script path-guard-cli', () => {
  it('lit stdin, écrit le refus sur stdout et sort en 0', async () => {
    const r = await execa(process.execPath, ['--import', 'tsx', SCRIPT], {
      input: hookInput(`${wt}/secrets/key.pem`),
      env,
      reject: false,
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('ne dit rien quand l’écriture est autorisée', async () => {
    const r = await execa(process.execPath, ['--import', 'tsx', SCRIPT], {
      input: hookInput(`${wt}/src/a.ts`),
      env,
      reject: false,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });
});

// Le hook réel n'est pas lancé par node directement mais par un shell, avec la commande exacte que
// `buildCliSettings` écrit dans le fichier de settings : c'est cette chaîne-là qui doit fonctionner.
describe('commande du hook telle qu’écrite dans les settings', () => {
  it.skipIf(!existsSync(BUILT_SCRIPT))('refuse une écriture protégée depuis le script buildé', async () => {
    const settings = buildCliSettings(BUILT_SCRIPT) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    const command = settings.hooks.PreToolUse[0].hooks[0].command;
    const r = await execa('sh', ['-c', command], { input: hookInput(`${wt}/secrets/key.pem`), env, reject: false });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
