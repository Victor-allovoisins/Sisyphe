import { describe, expect, it } from 'vitest';
import { decidePath, pathGuardHook } from './hooks.js';

const wt = '/data/work/acme__demo/issue-7';

describe('decidePath', () => {
  it('autorise dans le worktree, refuse en dehors', () => {
    expect(decidePath(wt, `${wt}/Sources/A.swift`, [])).toEqual({ allowed: true });
    expect(decidePath(wt, 'Sources/A.swift', [])).toEqual({ allowed: true });
    expect(decidePath(wt, `${wt}/../autre/x`, []).allowed).toBe(false);
    expect(decidePath(wt, '/etc/hosts', []).allowed).toBe(false);
    expect(decidePath(wt, undefined, []).allowed).toBe(true);
  });
  it('refuse les chemins protégés', () => {
    const d = decidePath(wt, `${wt}/App/Config.xcconfig`, ['**/*.xcconfig']);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.reason).toContain('protégé');
  });
});

describe('pathGuardHook', () => {
  it('renvoie un deny structuré', async () => {
    const hook = pathGuardHook(wt, ['fastlane/**']);
    const out = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `${wt}/fastlane/Fastfile` }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: wt } as never, 't', { signal: new AbortController().signal });
    expect(out).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
    const ok = await hook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: `${wt}/A.swift` }, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: wt } as never, 't', { signal: new AbortController().signal });
    expect(ok).toEqual({});
  });
});
