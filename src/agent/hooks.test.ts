import { describe, expect, it } from 'vitest';
import { decidePath, pathGuardHook } from './hooks.js';

const wt = '/data/work/acme__demo/issue-7';
const hookInput = (tool_name: string, tool_input: unknown) =>
  ({ hook_event_name: 'PreToolUse' as const, tool_name, tool_input, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: wt });

describe('decidePath', () => {
  it('autorise dans le worktree, refuse en dehors et sans chemin', () => {
    expect(decidePath(wt, `${wt}/Sources/A.swift`, [])).toEqual({ allowed: true });
    expect(decidePath(wt, 'Sources/A.swift', [])).toEqual({ allowed: true });
    expect(decidePath(wt, './Sources/A.swift', [])).toEqual({ allowed: true });
    expect(decidePath(wt, `${wt}/../autre/x`, []).allowed).toBe(false);
    expect(decidePath(wt, '/etc/hosts', []).allowed).toBe(false);
    expect(decidePath(wt, `${wt}0/x`, []).allowed).toBe(false); // frère par préfixe
    expect(decidePath(wt, undefined, []).allowed).toBe(false);
  });
  it('tolère un nom de fichier commençant par .. et refuse .git', () => {
    expect(decidePath(wt, '..config', [])).toEqual({ allowed: true });
    expect(decidePath(wt, '.git', []).allowed).toBe(false);
    expect(decidePath(wt, '.git/config', []).allowed).toBe(false);
    expect(decidePath(wt, '.GIT/config', []).allowed).toBe(false);
    expect(decidePath(wt, '.gitignore', [])).toEqual({ allowed: true });
  });
  it('refuse les chemins protégés', () => {
    const d = decidePath(wt, `${wt}/App/Config.xcconfig`, ['**/*.xcconfig']);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toContain('protégé');
  });
  it('refuse un worktree vide', () => {
    expect(() => decidePath('', 'x', [])).toThrow(/vide/);
    expect(() => pathGuardHook('', [])).toThrow(/vide/);
  });
});

describe('pathGuardHook', () => {
  it('renvoie un deny structuré, {} sinon, et ignore les autres événements', async () => {
    const hook = pathGuardHook(wt, ['fastlane/**']);
    const signal = new AbortController().signal;
    expect(await hook(hookInput('Write', { file_path: `${wt}/fastlane/Fastfile` }), 't', { signal })).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
    expect(await hook(hookInput('Edit', { file_path: `${wt}/A.swift` }), 't', { signal })).toEqual({});
    expect(await hook(hookInput('Write', {}), 't', { signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await hook({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {}, tool_response: {}, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: wt } as never, 't', { signal })).toEqual({});
  });
});
