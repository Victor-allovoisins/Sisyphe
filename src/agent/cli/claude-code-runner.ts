import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zeroUsage } from '../../store/types.js';
import { agentPluginPath } from '../plugin-path.js';
import type { AgentResult, AgentRunOptions, AgentRunner } from '../runner.js';
import { summarizeResult } from '../sdk-runner.js';
import { callSlug, runCliProcess } from './process.js';

/**
 * Backend agent « claude-code » : lance la CLI Claude Code installée sur la machine (`claude -p`) au
 * lieu du Agent SDK, pour utiliser l'abonnement claude.ai plutôt qu'une clé API. Mêmes garde-fous que
 * le backend SDK, exprimés en arguments de ligne de commande :
 * - `--setting-sources ""` + `--strict-mcp-config` : aucun réglage user/project/local, aucun serveur MCP
 *   (ni hooks perso, ni CLAUDE.md du repo — le CLAUDE.md est injecté par Sisyphe dans le system prompt) ;
 * - `--tools` (liste blanche stricte) doublé de `--allowedTools` (auto-approbation) et `--disallowedTools` ;
 * - `--permission-mode dontAsk --permission-prompts none` : rien ne peut demander une validation humaine ;
 * - `--settings` : les seuls hooks PreToolUse autorisés sont les garde-fous de Sisyphe (chemins, et Bash
 *   pour la phase `jira`).
 * Le cycle de vie du sous-processus (groupe détaché, timeout, kill) est dans `runCliProcess`.
 *
 * La parité avec le backend SDK n'est pas totale : il n'y a pas d'équivalent en ligne de commande de
 * `managedSettings.strictPluginOnlyCustomization`, et `--setting-sources ""` ne couvre que les réglages
 * user/project/local — des managed settings (MDM) resteraient chargés et pourraient ajouter des hooks.
 * Le garde-fou de chemins reste donc, ici, la seule barrière côté hooks que Sisyphe contrôle.
 */
export interface CliRunnerConfig {
  /** Binaire à lancer. Défaut `claude`, résolu sur le PATH de `o.env` (pas celui du daemon). */
  claudeBin?: string;
  /** Script Node du hook de garde. Défaut : `path-guard-cli.js` dans `dist/agent/` (un niveau au-dessus). */
  hookScript?: string;
  /** Script Node du garde-fou Bash. Défaut : `bash-guard-cli.js`, à côté du précédent. */
  bashHookScript?: string;
}

const HOOK_TIMEOUT_SECONDS = 15;

/**
 * Contenu de `--settings`. La commande cite le chemin et utilise le node courant plutôt que `node` :
 * sous launchd le PATH est minimal, et un hook qui ne démarre pas sort en 1, ce que Claude Code traite
 * comme une erreur NON bloquante — le garde-fou disparaîtrait en silence.
 */
export function buildCliSettings(hookScript: string, nodeBin: string = process.execPath, bashHookScript?: string): Record<string, unknown> {
  const preToolUse: unknown[] = [
    { matcher: 'Edit|Write', hooks: [{ type: 'command', command: `"${nodeBin}" "${hookScript}"`, timeout: HOOK_TIMEOUT_SECONDS }] },
  ];
  if (bashHookScript) {
    preToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `"${nodeBin}" "${bashHookScript}"`, timeout: HOOK_TIMEOUT_SECONDS }] });
  }
  return { hooks: { PreToolUse: preToolUse } };
}

export function buildCliArgs(o: AgentRunOptions, files: { appendPath: string; settingsPath?: string }): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    // Chaîne vide = aucune source de réglages chargée ; --strict-mcp-config coupe en plus les serveurs MCP,
    // que --setting-sources ne couvre pas (aucun --mcp-config n'est passé, donc zéro serveur).
    '--setting-sources', '',
    '--strict-mcp-config',
  ];
  if (files.settingsPath) args.push('--settings', files.settingsPath);
  // `--tools ""` est la façon documentée de n'autoriser aucun outil : une liste vide ne doit pas
  // faire disparaître le drapeau, ce serait « tous les outils ».
  args.push('--tools', ...(o.allowedTools.length ? o.allowedTools : ['']));
  if (o.allowedTools.length) args.push('--allowedTools', ...o.allowedTools);
  if (o.disallowedTools.length) args.push('--disallowedTools', ...o.disallowedTools);
  // Absent = la CLI choisit son modèle par défaut.
  if (o.model !== undefined) args.push('--model', o.model);
  args.push('--max-turns', String(o.maxTurns));
  args.push('--max-budget-usd', String(o.maxBudgetUsd));
  // La CLI n'a pas d'équivalent de l'option `skills` du SDK (vérifié : ni --skills, ni --allowed-skills).
  // Elle n'en a pas besoin ici : `--setting-sources ''` coupe toute autre source, donc seuls les skills de
  // ce plugin existent pour l'agent.
  if (o.skills?.length) args.push('--plugin-dir', agentPluginPath());
  args.push('--append-system-prompt-file', files.appendPath);
  if (o.outputSchema) args.push('--json-schema', JSON.stringify(o.outputSchema));
  if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);
  return args;
}

/** Le `result` de la CLI a la forme d'un `SDKResultMessage` ; on garantit juste `usage` avant de le passer à summarizeResult. */
function asResultMessage(raw: Record<string, unknown>): SDKResultMessage {
  const usage = (raw.usage ?? {}) as Record<string, unknown>;
  return { ...raw, usage: { input_tokens: 0, output_tokens: 0, ...usage } } as unknown as SDKResultMessage;
}

export class ClaudeCodeAgentRunner implements AgentRunner {
  private readonly claudeBin: string;
  private readonly hookScript: string;
  private readonly bashHookScript: string;

  constructor(cfg: CliRunnerConfig = {}) {
    this.claudeBin = cfg.claudeBin ?? 'claude';
    this.hookScript = cfg.hookScript ?? fileURLToPath(new URL('../path-guard-cli.js', import.meta.url));
    this.bashHookScript = cfg.bashHookScript ?? fileURLToPath(new URL('../bash-guard-cli.js', import.meta.url));
  }

  async run<T>(o: AgentRunOptions): Promise<AgentResult<T>> {
    const started = Date.now();
    if (o.signal.aborted) {
      return summarizeResult<T>({ result: null, sessionId: null, error: null, timedOut: false, aborted: true, floor: zeroUsage(), durationMs: 0, transcriptPath: o.transcriptPath });
    }

    // Un hook qui ne démarre pas sort en 1, ce que Claude Code traite comme une erreur NON bloquante :
    // un dist incomplet donnerait un agent silencieusement non gardé. Mieux vaut ne pas lancer du tout.
    // Le fichier de settings référence toujours le garde de chemins, donc il est vérifié dès qu'un garde
    // est demandé — pas seulement quand c'est celui-là.
    const guarded = Boolean(o.pathGuard || o.bashGuard);
    for (const script of [...(guarded ? [this.hookScript] : []), ...(o.bashGuard ? [this.bashHookScript] : [])]) {
      try {
        await stat(script);
      } catch {
        throw new Error(`Garde-fou introuvable (${script}) : run refusé plutôt que non gardé.`);
      }
    }

    const slug = callSlug(o.transcriptPath);
    const dir = dirname(o.transcriptPath);
    const appendPath = join(dir, `system-append-${slug}.md`);
    await writeFile(appendPath, o.systemPromptAppend);
    let settingsPath: string | undefined;
    // `bashGuard` sans `pathGuard` doit écrire le fichier quand même, sinon `--settings` disparaît et
    // avec lui le garde Bash. L'entrée Edit|Write reste présente : privée de SISYPHE_GUARD_WORKTREE,
    // elle refuse toute écriture — ce qui est le bon sens pour une phase qui n'écrit pas de fichier.
    if (guarded) {
      settingsPath = join(dir, `cli-settings-${slug}.json`);
      const settings = buildCliSettings(this.hookScript, process.execPath, o.bashGuard ? this.bashHookScript : undefined);
      await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    }

    // o.env est déjà l'environnement épuré de l'agent (HOME et PATH compris : `claude` en a besoin
    // pour lire ~/.claude). On n'étend pas process.env, on ajoute seulement les variables du garde-fou.
    const env: Record<string, string> = { ...o.env };
    if (o.pathGuard) {
      env.SISYPHE_GUARD_WORKTREE = o.pathGuard.worktreePath;
      env.SISYPHE_GUARD_PROTECTED = JSON.stringify(o.pathGuard.protectedPatterns);
    }

    let result: SDKResultMessage | null = null;
    let sessionId: string | null = null;
    // Plancher d'usage reconstitué depuis les messages assistant (dédoublonnés par id), si le result manque.
    const floor = zeroUsage();
    const seen = new Set<string>();
    const outcome = await runCliProcess({
      bin: this.claudeBin,
      args: buildCliArgs(o, { appendPath, settingsPath }),
      cwd: o.cwd,
      env,
      stdin: o.prompt,
      transcriptPath: o.transcriptPath,
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      onLine: (parsed) => {
        const m = parsed as { type?: string; subtype?: string; session_id?: string; parent_tool_use_id?: unknown; message?: { id?: string; usage?: Record<string, number> } };
        if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') sessionId = m.session_id;
        if (m.type === 'assistant' && !m.parent_tool_use_id && m.message?.id && !seen.has(m.message.id)) {
          seen.add(m.message.id);
          const u = m.message.usage ?? {};
          floor.inputTokens += u.input_tokens ?? 0;
          floor.outputTokens += u.output_tokens ?? 0;
          floor.cacheReadTokens += u.cache_read_input_tokens ?? 0;
          floor.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
        }
        if (m.type === 'result') {
          result = asResultMessage(parsed);
          if (typeof m.session_id === 'string') sessionId = m.session_id;
        }
      },
    });

    const aborted = o.signal.aborted;
    const error =
      result || outcome.timedOut || aborted
        ? null
        : new Error(`claude s'est arrêté sans result (code ${outcome.exitCode})${outcome.stderrTail ? ` : ${outcome.stderrTail}` : outcome.failure ? ` : ${outcome.failure}` : ''}`);

    return summarizeResult<T>({ result, sessionId, error, timedOut: outcome.timedOut, aborted, floor, durationMs: Date.now() - started, transcriptPath: o.transcriptPath });
  }
}
