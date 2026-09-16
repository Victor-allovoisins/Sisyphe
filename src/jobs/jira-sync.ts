import { jiraSyncPrompt, type JiraOutcome } from '../agent/prompts.js';
import { JIRA_SKILL } from '../agent/plugin-path.js';
import type { AgentResult, AgentRunner } from '../agent/runner.js';
import { JiraSyncReportSchema, jiraSyncJsonSchema, type JiraSyncReport } from '../agent/schemas.js';
import { summarizeResult } from '../agent/sdk-runner.js';
import { zeroUsage, type Job, type JobState } from '../store/types.js';
import { fmtDuration } from '../util/time.js';

export type { JiraOutcome };

const JIRA_MAX_TURNS = 20;
const JIRA_MAX_BUDGET_USD = 1;

export function jiraOutcomeOf(job: Job, state: JobState, targetHint: string, key = ''): JiraOutcome {
  const flags: string[] = [];
  if (job.flags.secretsFound.length) flags.push('secrets détectés dans le diff');
  if (job.flags.protectedPathsTouched.length) flags.push('chemins protégés modifiés');
  if (job.flags.largeDiff) flags.push('diff volumineux');
  if (job.flags.earlyStop) flags.push(`agent arrêté avant la fin (${job.flags.earlyStop})`);
  return {
    key, state, verificationFailed: job.flags.verificationFailed, prUrl: job.prUrl,
    attempts: job.attempt, costUsd: job.costUsd, duration: fmtDuration(job.durationMs),
    targetHint, reason: job.error, flags,
  };
}

export interface JiraSyncDeps {
  agent: AgentRunner;
  env: Record<string, string>;
  transcriptPath: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  model?: string;
}

const EMPTY: JiraSyncReport = { status: '', comment: '', handedBack: false, note: 'aucun rapport produit' };

/**
 * Un tour d'agent, un seul outil. Ne lève jamais : le filet du pipeline s'appuie sur ce qu'elle rend, et
 * une exception ici priverait le job de sa clôture Jira au lieu de la dégrader. Le `try` couvre tout le
 * corps, pas seulement le run : `deps.cwd` peut ne pas exister sur les sorties les plus précoces du
 * pipeline, et le backend CLI y écrit son fichier de system prompt avant même de lancer l'agent.
 *
 * Rend aussi le résultat brut : son coût doit être imputé au job comme celui des autres phases, sans quoi
 * la phase échapperait au plafond quotidien.
 *
 * `job` reste dans la signature bien que tout ce qui compte soit déjà dans `outcome` : c'est par lui que
 * passerait un besoin futur (rapport, verdict) plutôt que par un élargissement de `JiraOutcome`.
 */
export async function runJiraPhase(
  deps: JiraSyncDeps,
  job: Job,
  outcome: JiraOutcome,
): Promise<{ report: JiraSyncReport; result: AgentResult<JiraSyncReport> }> {
  const started = Date.now();
  try {
    const res = await deps.agent.run<JiraSyncReport>({
      cwd: deps.cwd,
      model: deps.model,
      phase: 'implement',
      systemPromptAppend: "Tu clos un ticket Jira pour Sisyphe. Ta seule commande disponible est `sisyphe jira`. Tu n'as ni dépôt, ni réseau, ni personne à interroger.",
      prompt: jiraSyncPrompt(outcome),
      outputSchema: jiraSyncJsonSchema,
      maxTurns: JIRA_MAX_TURNS,
      maxBudgetUsd: JIRA_MAX_BUDGET_USD,
      allowedTools: ['Bash'],
      disallowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
      bashGuard: true,
      skills: [JIRA_SKILL],
      env: deps.env,
      timeoutMs: deps.timeoutMs,
      signal: deps.signal,
      transcriptPath: deps.transcriptPath,
    });
    const parsed = JiraSyncReportSchema.safeParse(res.output);
    return { report: parsed.success ? parsed.data : { ...EMPTY }, result: res };
  } catch (err) {
    // Même mise en forme que les runners : `stopReason` distingue un abort d'une vraie erreur, et le
    // coût reste à zéro puisque aucun result n'a été reçu.
    const result = summarizeResult<JiraSyncReport>({
      result: null, sessionId: null, error: err, timedOut: false, aborted: deps.signal.aborted,
      floor: zeroUsage(), durationMs: Date.now() - started, transcriptPath: deps.transcriptPath,
    });
    return { report: { ...EMPTY }, result };
  }
}
