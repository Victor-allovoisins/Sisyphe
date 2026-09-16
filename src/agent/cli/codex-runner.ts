import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { zeroUsage, type AgentUsage } from '../../store/types.js';
import type { AgentResult, AgentRunOptions, AgentRunner, AgentStopReason } from '../runner.js';
import { callSlug, runCliProcess } from './process.js';

/**
 * Backend agent « codex » : lance la CLI OpenAI Codex (`codex exec`) au lieu du SDK, pour utiliser
 * l'abonnement ChatGPT plutôt qu'une clé API. La sortie structurée passe par `--output-schema <fichier>`
 * puis est relue depuis le fichier `-o` (`--output-last-message`), jamais devinée dans le flux.
 * - `phase: 'triage'` → `--sandbox read-only` (défaut) ; `phase: 'implement'` → `workspace-write` ;
 * - `--ignore-user-config` + `-c` coupent les réglages user et la recherche web / les serveurs MCP ;
 * - le cycle de vie du sous-processus (groupe détaché, timeout, kill, transcript) est dans `runCliProcess`.
 *
 * Parité avec le backend SDK volontairement partielle : codex n'a pas de liste d'outils ni de hook
 * PreToolUse. Le garde-fou est le bac à sable workspace (`workspace-write`) complété par le contrôle
 * a posteriori des chemins protégés (pipeline). `maxTurns`/`maxBudgetUsd` sont ignorés, le coût
 * reporté est nul (abonnement).
 */
export interface CodexRunnerConfig {
  /** Binaire à lancer. Défaut `codex`, résolu sur le PATH de `o.env` (pas celui du daemon). */
  bin?: string;
}

/**
 * Clés de configuration de la coupure réseau, passées en `-c key=value` (épinglées sur codex 0.154).
 * `web_search="disabled"` est la clé canonique actuelle (mode `disabled`/`cached`/`live`) ;
 * `tools.web_search=false` est le toggle historique mais toujours reconnu (`[tools]` dans le schéma),
 * conservé en défense en profondeur contre un `config.toml` de projet qui le rallumerait.
 * `mcp_servers={}` désactive tous les serveurs MCP (« present but empty → all disabled »).
 * `--ignore-user-config` ne couvre que le config utilisateur : ces `-c` neutralisent le config projet.
 */
export const CODEX_CUTOFF_CONFIG = ['web_search="disabled"', 'tools.web_search=false', 'mcp_servers={}'] as const;

export function buildCodexArgs(o: AgentRunOptions, files: { resultPath: string; schemaPath?: string }): string[] {
  const args = ['exec'];
  if (o.resumeSessionId) args.push('resume', o.resumeSessionId);
  args.push('--json', '--cd', o.cwd);
  // Absent = la CLI choisit son modèle par défaut.
  if (o.model !== undefined) args.push('-m', o.model);
  args.push('--sandbox', o.phase === 'implement' ? 'workspace-write' : 'read-only');
  if (files.schemaPath) args.push('--output-schema', files.schemaPath);
  args.push('-o', files.resultPath, '--ignore-user-config');
  for (const override of CODEX_CUTOFF_CONFIG) args.push('-c', override);
  return args;
}

/** Message d'erreur d'un événement `turn.failed`/`error`, quelle que soit la forme du champ. */
function eventErrorText(e: Record<string, unknown>): string | null {
  const err = e.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  if (typeof e.message === 'string') return e.message;
  return null;
}

/**
 * `codex exec` n'a pas de drapeau de system prompt : l'appendice de Sisyphe (règles absolues, chemins
 * protégés, instructions du repo, CLAUDE.md) est donc concaténé au prompt, séparé par une ligne vide.
 * Sans lui, les consignes que `implementPrompt` croit « dans tes instructions système » n'existent pas.
 */
export function buildCodexStdin(o: AgentRunOptions): string {
  return [o.systemPromptAppend, o.prompt].filter((part) => part !== '').join('\n\n');
}

export class CodexAgentRunner implements AgentRunner {
  private readonly bin: string;

  constructor(cfg: CodexRunnerConfig = {}) {
    this.bin = cfg.bin ?? 'codex';
  }

  async run<T>(o: AgentRunOptions): Promise<AgentResult<T>> {
    const started = Date.now();
    if (o.signal.aborted) {
      return {
        output: null, sessionId: null, costUsd: 0, usage: zeroUsage(), numTurns: 0,
        durationMs: 0, stopReason: 'aborted', transcriptPath: o.transcriptPath,
      };
    }

    const slug = callSlug(o.transcriptPath);
    const dir = dirname(o.transcriptPath);
    let schemaPath: string | undefined;
    if (o.outputSchema) {
      schemaPath = join(dir, `schema-${slug}.json`);
      await writeFile(schemaPath, `${JSON.stringify(o.outputSchema, null, 2)}\n`);
    }
    const resultPath = join(dir, `result-${slug}.json`);
    // Un fichier résiduel d'un run échoué sur le même chemin serait relu comme un succès : on part propre.
    await rm(resultPath, { force: true });

    let sessionId: string | null = null;
    let numTurns = 0;
    let turnFailed: string | null = null;
    const streamErrors: string[] = [];
    const usage: AgentUsage = zeroUsage();

    const outcome = await runCliProcess({
      bin: this.bin,
      args: buildCodexArgs(o, { resultPath, schemaPath }),
      cwd: o.cwd,
      // o.env est déjà l'environnement épuré de l'agent (HOME et PATH compris : `codex` en a besoin
      // pour lire ~/.codex). On n'étend pas process.env.
      env: { ...o.env },
      stdin: buildCodexStdin(o),
      transcriptPath: o.transcriptPath,
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      onLine: (parsed) => {
        const e = parsed as { type?: string; thread_id?: string; usage?: Record<string, number> };
        // `thread.started`/`turn.started`, `error` (message racine) et `turn.failed` (error.message) sont
        // épinglés sur une capture réelle, de même que l'invocation « prompt sur stdin sans argument
        // positionnel » (`Reading prompt from stdin...`, revérifiée le 2026-09-16). `turn.completed.usage`
        // et `item.completed` restent issus du schéma codex-rs : le succès n'est pas encore validé contre
        // la vraie CLI (quota ChatGPT épuisé jusqu'au 2026-09-19). La validation manuelle d'un vrai run
        // réussi est décrite dans docs/playground.md.
        if (e.type === 'thread.started' && typeof e.thread_id === 'string') sessionId = e.thread_id;
        if (e.type === 'turn.completed') {
          numTurns += 1;
          usage.inputTokens += e.usage?.input_tokens ?? 0;
          usage.cacheReadTokens += e.usage?.cached_input_tokens ?? 0;
          usage.outputTokens += e.usage?.output_tokens ?? 0;
        }
        // Seul `turn.failed` est terminal : `error` peut être non terminal, on en garde le texte sans échouer.
        if (e.type === 'turn.failed' && turnFailed === null) {
          turnFailed = eventErrorText(parsed as Record<string, unknown>) ?? 'codex turn.failed';
        } else if (e.type === 'error') {
          const text = eventErrorText(parsed as Record<string, unknown>);
          if (text) streamErrors.push(text);
        }
      },
    });

    // Le résultat est un fichier, pas une ligne du flux : on le lit même après un timeout, car la tête
    // a pu l'écrire avant qu'un descendant ne garde stdout ouvert (l'exécution reste par ailleurs bornée).
    const aborted = o.signal.aborted;
    let output: T | null = null;
    let readOk = false;
    let readError: string | null = null;
    if (!aborted) {
      try {
        output = JSON.parse(await readFile(resultPath, 'utf8')) as T;
        readOk = true;
      } catch {
        readError = `codex n'a écrit aucun résultat lisible (${resultPath})`;
      }
    }

    // `completed` exige une sortie propre (code 0) ET un résultat effectivement relu. Un timeout prime
    // sur un résultat déjà écrit : le run a été tué, même si la sortie structurée est exploitable.
    let stopReason: AgentStopReason;
    if (aborted) stopReason = 'aborted';
    else if (outcome.timedOut) stopReason = 'timeout';
    else if (readOk && turnFailed === null && outcome.exitCode === 0) stopReason = 'completed';
    else stopReason = 'error';

    const parts: string[] = [];
    if (turnFailed) parts.push(turnFailed);
    if (stopReason !== 'completed') {
      parts.push(...streamErrors);
      if (readError) parts.push(readError);
      if (outcome.failure) parts.push(outcome.failure);
      if (outcome.stderrTail) parts.push(outcome.stderrTail);
      if (o.signal.aborted || outcome.timedOut) parts.push('run interrompu avant le résultat');
      else if (parts.length === 0) parts.push(`codex s'est arrêté sans résultat (code ${outcome.exitCode})`);
    }

    return {
      output: readOk && turnFailed === null ? output : null,
      sessionId,
      costUsd: 0,
      usage,
      numTurns,
      durationMs: Date.now() - started,
      stopReason,
      errorMessage: stopReason === 'completed' ? undefined : parts.filter(Boolean).join(' ; ') || undefined,
      transcriptPath: o.transcriptPath,
    };
  }
}
