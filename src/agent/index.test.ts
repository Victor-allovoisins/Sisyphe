import { describe, expect, it } from 'vitest';
import { ClaudeCodeAgentRunner } from './cli/claude-code-runner.js';
import { CodexAgentRunner } from './cli/codex-runner.js';
import { OpenCodeAgentRunner } from './cli/opencode-runner.js';
import { createAgentRunner } from './index.js';
import { SdkAgentRunner } from './sdk-runner.js';

describe('createAgentRunner', () => {
  it('mappe chaque backend sur son runner', () => {
    expect(createAgentRunner('sdk', { sandbox: false })).toBeInstanceOf(SdkAgentRunner);
    expect(createAgentRunner('claude-code', { sandbox: false })).toBeInstanceOf(ClaudeCodeAgentRunner);
    expect(createAgentRunner('codex', { sandbox: false })).toBeInstanceOf(CodexAgentRunner);
    expect(createAgentRunner('opencode', { sandbox: false })).toBeInstanceOf(OpenCodeAgentRunner);
  });

  it('ne transmet sandbox qu’au runner SDK', () => {
    const sdk = createAgentRunner('sdk', { sandbox: true }) as unknown as { cfg: { sandbox: boolean } };
    expect(sdk.cfg.sandbox).toBe(true);
  });
});
