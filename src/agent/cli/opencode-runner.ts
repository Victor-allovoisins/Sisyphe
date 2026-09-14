import { zeroUsage, type AgentUsage } from '../../store/types.js';
import type { AgentResult, AgentRunOptions, AgentRunner, AgentStopReason } from '../runner.js';
import { runCliProcess } from './process.js';

/**
 * Backend agent « opencode » : lance la CLI opencode (`opencode run`) au lieu du SDK, pour utiliser
 * l'authentification attendue par `opencode auth login` (multi-fournisseur, cf. §6 du design).
 * - `--format json` : flux d'événements JSON brut (le format texte est le défaut) ;
 * - `--auto` : auto-approbation des permissions non explicitement refusées ;
 * - `OPENCODE_PERMISSION` : allowlist d'outils exprimée en JSON dans l'environnement (§4 du design).
 *
 * Parité avec le backend SDK volontairement partielle. opencode n'exprime pas la liste des outils
 * avec les mêmes noms que le SDK : `allowedTools` ne sert qu'à décider si on est en phase
 * d'implémentation (`Edit`/`Write`). Le garde-fou de chemins passe par les permissions `edit`/`read`
 * par motif, complété par le contrôle a posteriori des chemins protégés (pipeline). `maxTurns` et
 * `maxBudgetUsd` sont ignorés, le coût reporté est best-effort (souvent nul).
 *
 * Sortie structurée : opencode n'a pas de drapeau de schéma. La consigne « termine par un objet JSON
 * conforme au schéma » fait partie du prompt, et le runner extrait le dernier objet JSON du dernier
 * texte assistant (`extractLastJsonObject`). Illisible → `output: null`, le pipeline retombe sur ses
 * valeurs de repli.
 */
export interface OpenCodeRunnerConfig {
  /** Binaire à lancer. Défaut `opencode`, résolu sur le PATH de `o.env` (pas celui du daemon). */
  bin?: string;
}

/**
 * Types d'événements considérés comme un échec terminal. Les noms exacts de champs et de types du
 * flux `--format json` d'opencode sont **provisoires** : ils seront épinglés sur une capture réelle
 * en Task 11 (cf. §4 du design). On reste donc volontairement tolérant : tout type contenant
 * `error`/`failed` (ou `session.error`, `run.failed`) est traité comme terminal.
 */
function isTerminalError(type: string): boolean {
  return type === 'error' || type === 'session.error' || type === 'run.failed' || type.includes('error') || type.endsWith('failed');
}

/**
 * Permission `OPENCODE_PERMISSION` : `*: deny` puis autorisations ciblées. En triage, seuls la
 * lecture et la recherche sont ouvertes. En implémentation (`allowedTools` contient `Edit` ou
 * `Write`), `edit` s'ouvre par `*: allow` puis chaque motif protégé est refusé sous ses deux formes
 * (le motif tel quel et le motif préfixé d'un double-étoile-slash) — la dernière règle qui matche
 * gagne, donc les refus priment. `bash` est
 * alors autorisé ; `webfetch`/`websearch` ne le sont jamais (couverts par `*: deny`).
 */
export function buildOpenCodePermission(o: AgentRunOptions): Record<string, unknown> {
  const permission: Record<string, unknown> = {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    external_directory: 'deny',
  };
  if (o.allowedTools.includes('Edit') || o.allowedTools.includes('Write')) {
    const edit: Record<string, unknown> = { '*': 'allow' };
    for (const pattern of o.pathGuard?.protectedPatterns ?? []) {
      edit[pattern] = 'deny';
      edit[`**/${pattern}`] = 'deny';
    }
    permission.edit = edit;
    permission.bash = 'allow';
  }
  return permission;
}

/** Commande : `run --format json --auto`, `-m` seulement si modèle, `--session` seulement si reprise. */
export function buildOpenCodeArgs(o: AgentRunOptions): string[] {
  const args = ['run', '--format', 'json', '--auto'];
  if (o.model !== undefined) args.push('-m', o.model);
  if (o.resumeSessionId) args.push('--session', o.resumeSessionId);
  return args;
}

/**
 * `opencode run` n'a pas de drapeau de system prompt : l'appendice de Sisyphe (règles absolues,
 * chemins protégés, instructions du repo, CLAUDE.md) est concaténé au prompt sur stdin, séparé par
 * une ligne vide — même raisonnement que pour codex.
 */
export function buildOpenCodeStdin(o: AgentRunOptions): string {
  return [o.systemPromptAppend, o.prompt].filter((part) => part !== '').join('\n\n');
}

/**
 * Extrait le dernier objet JSON d'un texte (le message final de l'assistant peut mêler prose et bloc
 * Markdown). Parcourt le texte en gardant l'état « dans une chaîne » pour ignorer les accolades
 * littérales, et ne retient que les objets JSON de premier niveau réellement parsables : le dernier
 * gagne. `null` si aucun objet exploitable.
 */
export function extractLastJsonObject(text: string): unknown | null {
  let last: unknown | null = null;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) last = parsed;
        } catch {
          /* pas un objet JSON : on continue, un autre candidat suivra peut-être */
        }
        start = -1;
      }
    }
  }
  return last;
}

/** Identifiant de session porté par un événement, quelle que soit la casse du champ. */
function eventSessionId(e: Record<string, unknown>): string | null {
  for (const key of ['sessionID', 'session_id', 'sessionId']) {
    const v = e[key];
    if (typeof v === 'string') return v;
  }
  return null;
}

/**
 * Clé de frontière de message assistant, provisoire comme le reste du schéma d'événements
 * (épinglé en Task 11). L'identifiant de **message** prime : il regroupe les multiples parties
 * (texte, appels d'outils, streaming) d'un même message. Faute d'identifiant de message, on retombe
 * sur l'identifiant de **partie**, mais seulement pour un événement porteur de texte — un événement
 * technique (`step_finish`…) sans identifiant de message ne doit pas couper le message en cours.
 * `null` = aucun identifiant exploitable : le flux entier est alors traité comme un seul segment.
 */
function messageBoundaryKey(e: Record<string, unknown>, hasText: boolean): string | null {
  for (const key of ['messageID', 'message_id', 'messageId']) {
    const v = e[key];
    if (typeof v === 'string') return `msg:${v}`;
  }
  if (!hasText) return null;
  const part = e.part;
  const partId = part && typeof part === 'object' ? (part as Record<string, unknown>).id : undefined;
  const id = partId ?? e.partID ?? e.part_id;
  return typeof id === 'string' ? `part:${id}` : null;
}

/** Texte assistant d'un événement, si l'événement est bien une partie de texte (jamais un outil). */
function eventText(e: Record<string, unknown>): string | null {
  const part = e.part;
  if (part && typeof part === 'object') {
    const p = part as Record<string, unknown>;
    if (typeof p.text === 'string' && (p.type === 'text' || p.type === undefined)) return p.text;
  }
  const type = typeof e.type === 'string' ? e.type : '';
  if (typeof e.text === 'string' && (type === 'text' || type === 'message' || type === 'assistant' || type === 'agent_message')) {
    return e.text;
  }
  return null;
}

const asNumber = (v: unknown): number => (typeof v === 'number' ? v : 0);

/** Cumule l'usage d'un événement (objet `usage` ou `part.tokens`), best-effort. */
function applyUsage(target: AgentUsage, e: Record<string, unknown>): void {
  const part = e.part as Record<string, unknown> | undefined;
  const raw = (e.usage && typeof e.usage === 'object' ? e.usage : part?.tokens && typeof part.tokens === 'object' ? part.tokens : null) as
    | Record<string, unknown>
    | null;
  if (!raw) return;
  target.inputTokens += asNumber(raw.input_tokens ?? raw.input);
  target.outputTokens += asNumber(raw.output_tokens ?? raw.output);
  target.cacheReadTokens += asNumber(raw.cache_read_input_tokens ?? raw.cached_input_tokens ?? raw.cache_read);
  target.cacheCreationTokens += asNumber(raw.cache_creation_input_tokens ?? raw.cache_write);
}

/** Coût d'un événement, best-effort (les champs sont typiquement des totaux cumulés). */
function eventCost(e: Record<string, unknown>): number | null {
  const part = e.part as Record<string, unknown> | undefined;
  for (const v of [e.cost, e.cost_usd, e.total_cost_usd, part?.cost]) {
    if (typeof v === 'number') return v;
  }
  return null;
}

/** Message d'erreur d'un événement, quelle que soit la forme du champ. */
function eventErrorText(e: Record<string, unknown>): string | null {
  const err = e.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  if (typeof e.message === 'string') return e.message;
  return null;
}

export class OpenCodeAgentRunner implements AgentRunner {
  private readonly bin: string;

  constructor(cfg: OpenCodeRunnerConfig = {}) {
    this.bin = cfg.bin ?? 'opencode';
  }

  async run<T>(o: AgentRunOptions): Promise<AgentResult<T>> {
    const started = Date.now();
    if (o.signal.aborted) {
      return {
        output: null, sessionId: null, costUsd: 0, usage: zeroUsage(), numTurns: 0,
        durationMs: 0, stopReason: 'aborted', transcriptPath: o.transcriptPath,
      };
    }

    let sessionId: string | null = null;
    // Texte du **dernier** message assistant uniquement. Un JSON émis dans un message antérieur (par
    // exemple avant un appel d'outil) ne doit jamais être repris comme verdict final : le pipeline le
    // revaliderait par zod et accepterait un verdict périmé. On segmente donc par message : un nouvel
    // identifiant de message repart d'un texte vide. Sans aucun identifiant, tout le flux ne forme
    // qu'un seul segment (repli tolérant tant que le schéma d'événements n'est pas épinglé).
    let finalAssistantText = '';
    let currentMessageKey: string | null = null;
    let costUsd = 0;
    let terminalFailure: string | null = null;
    const usage: AgentUsage = zeroUsage();

    const outcome = await runCliProcess({
      bin: this.bin,
      args: buildOpenCodeArgs(o),
      cwd: o.cwd,
      // o.env est déjà l'environnement épuré de l'agent (HOME et PATH compris : opencode y lit sa
      // session et `opencode auth`). On n'étend pas process.env, on ajoute la permission d'outils.
      env: { ...o.env, OPENCODE_PERMISSION: JSON.stringify(buildOpenCodePermission(o)) },
      stdin: buildOpenCodeStdin(o),
      transcriptPath: o.transcriptPath,
      timeoutMs: o.timeoutMs,
      signal: o.signal,
      onLine: (parsed) => {
        const sid = eventSessionId(parsed);
        if (sid) sessionId = sid;
        const text = eventText(parsed);
        const key = messageBoundaryKey(parsed, text !== null);
        if (key !== null && key !== currentMessageKey) {
          currentMessageKey = key;
          finalAssistantText = '';
        }
        if (text) finalAssistantText += text;
        applyUsage(usage, parsed);
        const cost = eventCost(parsed);
        if (cost !== null) costUsd = cost;
        const type = typeof parsed.type === 'string' ? parsed.type : '';
        if (terminalFailure === null && isTerminalError(type)) {
          terminalFailure = eventErrorText(parsed) ?? `opencode ${type}`;
        }
      },
    });

    // opencode n'a pas de schéma : on extrait le dernier objet JSON du texte assistant accumulé.
    // `output` est surfacé dès qu'il est extrait, même si le run n'est pas `completed`.
    const aborted = o.signal.aborted;
    const extracted = finalAssistantText === '' ? null : extractLastJsonObject(finalAssistantText);
    const output = extracted === null ? null : (extracted as T);

    // `completed` exige un code de sortie 0, un output extrait ET aucun échec terminal. Un timeout
    // ou un abort prime, l'output extrait restant par ailleurs exploitable.
    let stopReason: AgentStopReason;
    if (aborted) stopReason = 'aborted';
    else if (outcome.timedOut) stopReason = 'timeout';
    else if (output !== null && terminalFailure === null && outcome.exitCode === 0) stopReason = 'completed';
    else stopReason = 'error';

    const parts: string[] = [];
    if (terminalFailure) parts.push(terminalFailure);
    if (stopReason !== 'completed') {
      if (output === null) parts.push('opencode n’a rendu aucun objet JSON exploitable');
      if (outcome.failure) parts.push(outcome.failure);
      if (outcome.stderrTail) parts.push(outcome.stderrTail);
      if (aborted || outcome.timedOut) parts.push('run interrompu avant la sortie');
      else if (parts.length === 0) parts.push(`opencode s’est arrêté sans sortie exploitable (code ${outcome.exitCode})`);
    }

    return {
      output,
      sessionId,
      costUsd,
      usage,
      numTurns: 0,
      durationMs: Date.now() - started,
      stopReason,
      errorMessage: stopReason === 'completed' ? undefined : parts.filter(Boolean).join(' ; ') || undefined,
      transcriptPath: o.transcriptPath,
    };
  }
}
