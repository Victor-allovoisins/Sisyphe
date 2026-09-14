import type { AgentBackend } from '../config/machine.js';
import { ClaudeCodeAgentRunner } from './cli/claude-code-runner.js';
import { CodexAgentRunner } from './cli/codex-runner.js';
import { OpenCodeAgentRunner } from './cli/opencode-runner.js';
import type { AgentRunner } from './runner.js';
import { SdkAgentRunner } from './sdk-runner.js';

/**
 * Construit le runner du backend choisi. `sandbox` ne concerne que le SDK : les CLI `claude-code`,
 * `codex` et `opencode` tournent dans leur mode sûr propre, et `app.ts` refuse déjà `sandbox: true`
 * avec un autre backend.
 *
 * Le `switch` est exhaustif : un nouveau backend sans branche est une erreur de compilation
 * (`never`), jamais un repli silencieux vers un runner par défaut.
 */
export function createAgentRunner(backend: AgentBackend, opts: { sandbox: boolean }): AgentRunner {
  switch (backend) {
    case 'sdk':
      return new SdkAgentRunner({ sandbox: opts.sandbox });
    case 'claude-code':
      return new ClaudeCodeAgentRunner({});
    case 'codex':
      return new CodexAgentRunner({});
    case 'opencode':
      return new OpenCodeAgentRunner({});
    default: {
      const exhaustive: never = backend;
      throw new Error(`Backend agent inconnu : ${exhaustive as string}`);
    }
  }
}
