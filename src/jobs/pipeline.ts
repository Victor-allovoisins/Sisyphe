import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { implementPrompt, retryPrompt, systemAppend, triagePrompt } from '../agent/prompts.js';
import { readRepoContext } from '../agent/repo-context.js';
import type { AgentResult, AgentRunner } from '../agent/runner.js';
import {
  ImplementationReportSchema, TriageVerdictSchema, fallbackReport, reportJsonSchema, triageJsonSchema,
  type ImplementationReport, type TriageVerdict,
} from '../agent/schemas.js';
import { phaseModel, type MachineConfig } from '../config/machine.js';
import { jobDir as jobDirFor, repoCachePath, type DataPaths } from '../config/paths.js';
import { REPO_CONFIG_FILENAME, RepoConfigError, parseRepoConfig, type RepoConfig } from '../config/repo.js';
import {
  renderBlockedComment, renderCancelledComment, renderConfigProblemComment, renderFailedComment,
  renderNoChangesComment, renderProtectedPathsComment, renderSecretsComment, renderTakeoverComment,
} from '../deliver/comments.js';
import { deliver } from '../deliver/deliver.js';
import type { Git } from '../git/git.js';
import { issueRefOf, type IssueSource } from '../github/source.js';
import type { ActionStore } from '../store/actions.js';
import type { JobPatch, JobStore } from '../store/jobs.js';
import type { PhaseFinish, PhaseStore } from '../store/phases.js';
import { isTerminal, type Job, type JobFlags, type JobState, type PhaseName } from '../store/types.js';
import { minutes } from '../util/time.js';
import { agentEnv, repoEnv, runRepoCommand } from '../verify/commands.js';
import { runVerification, type ScanFn, type VerifyResult } from '../verify/verify.js';
import { branchName } from './slug.js';

export interface PipelineDeps {
  store: JobStore;
  phases: PhaseStore;
  /** Journal des commandes (UI, CLI) : écrit par le daemon, lu par l'UI. */
  actions: ActionStore;
  source: IssueSource;
  agent: AgentRunner;
  git: Git;
  paths: DataPaths;
  machine: MachineConfig;
  log: Logger;
  env: NodeJS.ProcessEnv;
  scan?: ScanFn;
}

export const TRIAGE_TOOLS = ['Read', 'Glob', 'Grep'];
export const TRIAGE_DENY = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch'];
export const IMPLEMENT_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];
// Les deux syntaxes de préfixe documentées pour les règles Bash, plus la forme exacte : à confirmer en Task 25 par un push tenté par l'agent.
export const IMPLEMENT_DENY = [
  'Bash(git push:*)', 'Bash(git push *)', 'Bash(git push)',
  'Bash(git remote:*)', 'Bash(git remote *)', 'Bash(git remote)',
  'WebFetch', 'WebSearch',
];
const TRIAGE_MAX_TURNS = 40;
const IMPLEMENT_MAX_TURNS = 200;

/**
 * Raisons d'abort. Seul `CANCELLED` termine le job : un arrêt du daemon (`SHUTDOWN`) comme toute
 * autre raison — y compris l'`AbortError` par défaut — laisse le job en place pour la réconciliation.
 */
export const SHUTDOWN = 'shutdown';
export const CANCELLED = 'cancelled';

export async function runJob(jobId: string, deps: PipelineDeps, signal: AbortSignal): Promise<Job> {
  const { store, phases, source } = deps;
  const initial = store.get(jobId);
  if (!initial) throw new Error(`Job inconnu : ${jobId}`);
  let job = initial;
  const log = deps.log.child({ jobId, repo: job.repo, issue: job.issueNumber });
  const issueRef = issueRefOf(job);
  const trigger = deps.machine.triggerLabel;
  const dir = jobDirFor(deps.paths, job.id);
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const finish = (state: JobState, patch: JobPatch = {}) => {
    const current = store.get(job.id) ?? job;
    return store.transition(job.id, state, { ...patch, durationMs: (current.durationMs ?? 0) + elapsed() });
  };
  const record = (res: AgentResult<unknown>) => {
    job = store.update(job.id, {
      costUsd: job.costUsd + res.costUsd,
      inputTokens: job.inputTokens + res.usage.inputTokens,
      outputTokens: job.outputTokens + res.usage.outputTokens,
      cacheReadTokens: job.cacheReadTokens + res.usage.cacheReadTokens,
    });
  };

  /** Ouvre une phase, exécute, et la ferme quoi qu'il arrive : une phase orpheline échapperait au budget quotidien. */
  const runPhase = async <T>(
    name: PhaseName,
    attempt: number,
    model: string | null,
    fn: () => Promise<T>,
    close: (out: T) => PhaseFinish,
  ): Promise<T> => {
    const phase = phases.start({ jobId: job.id, name, attempt, model });
    let closed = false;
    try {
      const out = await fn();
      phases.finish(phase.id, close(out));
      closed = true;
      return out;
    } finally {
      if (!closed) phases.finish(phase.id, { outcome: 'failure', stopReason: 'exception' });
    }
  };

  let worktreePath: string | null = null;
  let branch: string | null = null;
  /**
   * Le nettoyage ne fait jamais échouer un job : un worktree résiduel se répare, un job perdu non.
   * Idempotent — `removeWorktree` ignore les codes de sortie de git et supprime le dossier en `force`.
   */
  const cleanup = async () => {
    if (!worktreePath) return;
    await deps.git.removeWorktree(job.repo, worktreePath, branch ?? undefined).catch((err) => log.warn({ err }, 'worktree non supprimé'));
  };

  try {
    signal.throwIfAborted();
    // Synchrone, avant tout await : le daemon s'appuie dessus pour ne pas redémarrer le même job.
    job = store.transition(job.id, 'triaging');
    await mkdir(dir, { recursive: true });
    await source.setStatus(issueRef, 'in-progress');
    await source.comment(issueRef, renderTakeoverComment(job.id));
    const issue = await source.getIssue(issueRef);

    // Git et configuration du repo : on ne rafraîchit que les branches de base, jamais celles des jobs.
    const fetchUrl = await source.getAuthenticatedRemoteUrl(issueRef.repo);
    const publicUrl = `https://github.com/${job.repo}.git`;
    const defaultBranch = await source.getDefaultBranch(issueRef.repo);
    await deps.git.ensureMirror(job.repo, fetchUrl, publicUrl, [defaultBranch]);
    const configText = await deps.git.readFileAtRef(job.repo, defaultBranch, REPO_CONFIG_FILENAME);
    let config: RepoConfig;
    try {
      if (configText === null) throw new RepoConfigError('missing', `${REPO_CONFIG_FILENAME} absent sur la branche ${defaultBranch}`);
      config = parseRepoConfig(configText);
    } catch (err) {
      if (!(err instanceof RepoConfigError)) throw err;
      await source.comment(issueRef, renderConfigProblemComment(err.kind, err.message, trigger));
      await source.setStatus(issueRef, 'blocked');
      return finish('blocked', { error: err.message });
    }

    if (config.baseBranch !== defaultBranch) await deps.git.ensureMirror(job.repo, fetchUrl, publicUrl, [config.baseBranch]);
    branch = branchName(config.branchPrefix, job.issueNumber, job.issueTitle);
    const wt = await deps.git.createWorktree(job.repo, job.issueNumber, branch, config.baseBranch);
    // Constante : les closures ci-dessous (agent, vérification, livraison) ne conservent pas le rétrécissement d'un `let`.
    const wtPath = wt.worktreePath;
    worktreePath = wtPath;
    job = store.update(job.id, { branch, baseSha: wt.baseSha, worktreePath: wtPath });
    const envExtra = { cacheDir: repoCachePath(deps.paths, job.repo), issueNumber: job.issueNumber, branch };
    const env = repoEnv(deps.env, envExtra);
    const agentEnvVars = agentEnv(deps.env, envExtra, deps.machine.agentBackend);
    await mkdir(env.SISYPHE_CACHE_DIR, { recursive: true });
    if (config.commands.setup) {
      const r = await runRepoCommand(config.commands.setup, {
        cwd: wtPath, env, timeoutMs: minutes(config.timeouts.verifyMinutes), logFile: join(dir, 'setup.log'), signal,
      });
      if (r.cancelled) signal.throwIfAborted();
      if (r.exitCode !== 0) throw new Error(`commands.setup a échoué (code ${r.exitCode}) : ${r.output.slice(-300)}`);
    }

    // Le SDK ne charge rien depuis le repo cible : Sisyphe lit lui-même son CLAUDE.md et l'injecte.
    const repoContext = await readRepoContext(wtPath);
    const appendix = systemAppend(config, repoContext);

    // Triage
    signal.throwIfAborted();
    const tres = await runPhase(
      'triage',
      1,
      config.models.triage,
      () =>
        deps.agent.run<TriageVerdict>({
          cwd: wtPath, model: phaseModel(deps.machine, 'triage', config.models.triage), phase: 'triage', systemPromptAppend: appendix,
          prompt: triagePrompt(issue, config), outputSchema: triageJsonSchema,
          maxTurns: TRIAGE_MAX_TURNS, maxBudgetUsd: config.budget.triageUsd,
          allowedTools: TRIAGE_TOOLS, disallowedTools: TRIAGE_DENY,
          pathGuard: { worktreePath: wtPath, protectedPatterns: config.protectedPaths },
          env: agentEnvVars,
          timeoutMs: minutes(config.timeouts.triageMinutes), signal, transcriptPath: join(dir, 'transcript-triage-1.jsonl'),
        }),
      (res) => ({
        sessionId: res.sessionId, costUsd: res.costUsd, usage: res.usage, numTurns: res.numTurns,
        stopReason: res.stopReason, outcome: TriageVerdictSchema.safeParse(res.output).success ? 'success' : 'failure',
      }),
    );
    record(tres);
    const tparsed = TriageVerdictSchema.safeParse(tres.output);
    signal.throwIfAborted();
    const verdict: TriageVerdict = tparsed.success
      ? tparsed.data
      : {
          verdict: 'needs_clarification', confidence: 0, summary: "Le triage n'a pas produit de verdict exploitable.",
          change_type: 'chore', plan: [], files_likely_touched: [], questions: [], reasons: [`Arrêt du triage : ${tres.stopReason}`],
        };
    job = store.update(job.id, { verdict });
    if (verdict.verdict !== 'ready') {
      await source.comment(issueRef, renderBlockedComment(verdict, trigger));
      await source.setStatus(issueRef, 'blocked');
      await cleanup();
      return finish('blocked', { error: `triage : ${verdict.verdict}` });
    }

    // Implémentation et vérification
    job = store.transition(job.id, 'implementing');
    let sessionId: string | undefined;
    let report: ImplementationReport = fallbackReport('aucune tentative');
    let verify: VerifyResult | null = null;
    let flags: JobFlags = job.flags;
    for (let attempt = 1; attempt <= config.limits.maxAttempts; attempt++) {
      signal.throwIfAborted();
      job = store.update(job.id, { attempt });
      const prompt = verify?.failedStep ? retryPrompt(verify.failedStep, verify.failureTail) : implementPrompt(issue, verdict, config);
      const resume = sessionId;
      const ires = await runPhase(
        'implement',
        attempt,
        config.models.implement,
        () =>
          deps.agent.run<ImplementationReport>({
            cwd: wtPath, model: phaseModel(deps.machine, 'implement', config.models.implement), phase: 'implement', systemPromptAppend: appendix,
            prompt, outputSchema: reportJsonSchema,
            maxTurns: IMPLEMENT_MAX_TURNS, maxBudgetUsd: config.budget.implementUsd, resumeSessionId: resume,
            allowedTools: IMPLEMENT_TOOLS, disallowedTools: IMPLEMENT_DENY,
            pathGuard: { worktreePath: wtPath, protectedPatterns: config.protectedPaths },
            env: agentEnvVars,
            timeoutMs: minutes(config.timeouts.implementMinutes), signal, transcriptPath: join(dir, `transcript-implement-${attempt}.jsonl`),
          }),
        (res) => ({
          sessionId: res.sessionId, costUsd: res.costUsd, usage: res.usage, numTurns: res.numTurns,
          stopReason: res.stopReason, outcome: ImplementationReportSchema.safeParse(res.output).success ? 'success' : 'failure',
        }),
      );
      record(ires);
      sessionId = ires.sessionId ?? sessionId;
      const rparsed = ImplementationReportSchema.safeParse(ires.output);
      signal.throwIfAborted();
      report = rparsed.success
        ? rparsed.data
        : fallbackReport(ires.stopReason === 'completed' ? 'rapport non conforme au schéma' : `arrêt anticipé (${ires.stopReason})`);
      if (ires.stopReason !== 'completed') flags = { ...flags, earlyStop: ires.errorMessage ? `${ires.stopReason} : ${ires.errorMessage}` : ires.stopReason };

      job = store.transition(job.id, 'verifying', { report, flags });
      verify = await runPhase(
        'verify',
        attempt,
        null,
        () => runVerification({ worktreePath: wtPath, baseSha: wt.baseSha, config, jobDir: dir, env, git: deps.git, signal, scan: deps.scan }),
        (v) => ({ outcome: v.ok ? 'success' : 'failure', stopReason: v.failedStep }),
      );
      flags = { ...flags, protectedPathsTouched: verify.flags.protectedPathsTouched, largeDiff: verify.flags.largeDiff, secretsFound: verify.flags.secretsFound };
      job = store.update(job.id, { flags });

      if (verify.noChanges) {
        await source.comment(issueRef, renderNoChangesComment(report.summary, trigger));
        await source.setStatus(issueRef, 'blocked');
        await cleanup();
        return finish('blocked', { error: 'aucun changement produit' });
      }
      if (verify.flags.secretsFound.length > 0) {
        await source.comment(issueRef, renderSecretsComment(verify.flags.secretsFound, trigger));
        await source.setStatus(issueRef, 'failed');
        await cleanup();
        return finish('failed', { error: 'secrets détectés dans le diff' });
      }
      if (verify.flags.protectedPathsTouched.length > 0) {
        await source.comment(issueRef, renderProtectedPathsComment(verify.flags.protectedPathsTouched, trigger));
        await source.setStatus(issueRef, 'failed');
        await cleanup();
        return finish('failed', { error: 'chemins protégés modifiés dans le diff' });
      }
      if (verify.ok) break;
      log.warn({ attempt, step: verify.failedStep }, 'vérification échouée');
      if (attempt < config.limits.maxAttempts) {
        job = store.transition(job.id, 'implementing');
        continue;
      }
      flags = { ...flags, verificationFailed: true };
      job = store.update(job.id, { flags });
    }
    // La boucle tourne au moins une fois (maxAttempts ≥ 1) : l'invariant est explicite plutôt que masqué par un `!`.
    if (!verify) throw new Error('Aucune vérification exécutée : limits.maxAttempts invalide');
    const verified = verify;

    // Livraison
    job = store.transition(job.id, 'delivering');
    const delivered = await runPhase(
      'deliver',
      job.attempt,
      null,
      async () => {
        const prTemplate = await readPrTemplate(deps.git, job.repo, config.baseBranch);
        // Le token d'installation vit une heure : on le ré-obtient juste avant le push, un job peut durer plus longtemps.
        const pushUrl = await source.getAuthenticatedRemoteUrl(issueRef.repo);
        // durationMs ici = durée de ce seul run (depuis startedAt, ligne ~71) ; job.durationMs, lui, cumule
        // les runs précédents d'un job requeué (voir finish() ci-dessus) — deux grandeurs distinctes.
        return deliver({
          job, issue, config, report, verify: verified, phases: phases.listForJob(job.id),
          source, git: deps.git, worktreePath: wtPath, pushUrl, prTemplate, durationMs: elapsed(),
        });
      },
      () => ({ outcome: 'success' }),
    );
    // La PR existe : on la persiste avant tout nettoyage, pour qu'un incident ensuite n'en perde pas la trace.
    job = store.update(job.id, { prNumber: delivered.prNumber, prUrl: delivered.prUrl, prState: 'open' });
    if (delivered.warnings.length) log.warn({ warnings: delivered.warnings }, 'livraison : mises à jour de l’issue partielles');
    const final: JobState = job.flags.verificationFailed ? 'failed' : 'done';
    // Même en échec : le post-mortem se fait sur `jobs/<id>/` (transcripts, logs, diff) et sur la PR, pas sur le clone.
    await cleanup();
    log.info({ state: final, pr: delivered.prUrl, costUsd: job.costUsd }, 'job terminé');
    return finish(final);
  } catch (err) {
    const current = store.get(job.id) ?? job;
    if (isTerminal(current.state)) return current;
    if (signal.aborted) {
      if (signal.reason === CANCELLED) {
        log.info({ err }, 'job annulé');
        await cleanup();
        await source.comment(issueRef, renderCancelledComment(job.id)).catch(() => undefined);
        await source.setStatus(issueRef, null).catch(() => undefined);
        return finish('cancelled', { error: 'annulé' });
      }
      log.info({ reason: signal.reason, err }, 'arrêt du daemon ou abort inconnu : job laissé pour la réconciliation');
      return current;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'job en échec');
    await source.comment(issueRef, renderFailedComment(job.id, message.slice(0, 500), trigger)).catch(() => undefined);
    await source.setStatus(issueRef, 'failed').catch(() => undefined);
    // Après le commentaire et le statut : le nettoyage lance deux sous-processus git et un rm -rf sans
    // délai de garde, et un blocage là ne doit pas retarder ce que l'opérateur voit.
    await cleanup();
    return finish('failed', { error: message });
  }
}

/** Template de PR lu sur la branche de base du miroir, jamais dans le worktree que l'agent a modifié : contenu du repo, de confiance. */
async function readPrTemplate(git: Git, repo: string, baseBranch: string): Promise<string | null> {
  for (const p of ['.github/PULL_REQUEST_TEMPLATE.md', '.github/pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md']) {
    const text = await git.readFileAtRef(repo, baseBranch, p);
    if (text !== null) return text;
  }
  return null;
}
