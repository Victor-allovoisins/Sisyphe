import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { pathGuardHook } from '../agent/hooks.js';
import { implementPrompt, retryPrompt, systemAppend, triagePrompt } from '../agent/prompts.js';
import { readRepoContext } from '../agent/repo-context.js';
import type { AgentResult, AgentRunner } from '../agent/runner.js';
import {
  ImplementationReportSchema, TriageVerdictSchema, fallbackReport, reportJsonSchema, triageJsonSchema,
  type ImplementationReport, type TriageVerdict,
} from '../agent/schemas.js';
import type { MachineConfig } from '../config/machine.js';
import { jobDir as jobDirFor, repoCachePath, type DataPaths } from '../config/paths.js';
import { REPO_CONFIG_FILENAME, RepoConfigError, parseRepoConfig, type RepoConfig } from '../config/repo.js';
import {
  renderBlockedComment, renderCancelledComment, renderConfigProblemComment, renderFailedComment,
  renderNoChangesComment, renderSecretsComment, renderTakeoverComment,
} from '../deliver/comments.js';
import { deliver } from '../deliver/deliver.js';
import type { Git } from '../git/git.js';
import { issueRefOf, type IssueSource } from '../github/source.js';
import type { JobPatch, JobStore } from '../store/jobs.js';
import type { PhaseStore } from '../store/phases.js';
import { isTerminal, type Job, type JobFlags, type JobState } from '../store/types.js';
import { minutes } from '../util/time.js';
import { agentEnv, repoEnv, runRepoCommand } from '../verify/commands.js';
import { runVerification, type ScanFn, type VerifyResult } from '../verify/verify.js';
import { branchName } from './slug.js';

export interface PipelineDeps {
  store: JobStore;
  phases: PhaseStore;
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

/** Raisons d'abort : un arrêt du daemon laisse le job en place, une annulation le termine. */
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
  const finish = (state: JobState, patch: JobPatch = {}) => store.transition(job.id, state, { ...patch, durationMs: elapsed() });
  const record = (res: AgentResult<unknown>) => {
    job = store.update(job.id, {
      costUsd: job.costUsd + res.costUsd,
      inputTokens: job.inputTokens + res.usage.inputTokens,
      outputTokens: job.outputTokens + res.usage.outputTokens,
      cacheReadTokens: job.cacheReadTokens + res.usage.cacheReadTokens,
    });
  };

  let worktreePath: string | null = null;
  let branch: string | null = null;

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
    worktreePath = wt.worktreePath;
    job = store.update(job.id, { branch, baseSha: wt.baseSha, worktreePath });
    const envExtra = { cacheDir: repoCachePath(deps.paths, job.repo), issueNumber: job.issueNumber, branch };
    const env = repoEnv(deps.env, envExtra);
    const agentEnvVars = agentEnv(deps.env, envExtra);
    await mkdir(env.SISYPHE_CACHE_DIR, { recursive: true });
    if (config.commands.setup) {
      const r = await runRepoCommand(config.commands.setup, {
        cwd: worktreePath, env, timeoutMs: minutes(config.timeouts.verifyMinutes), logFile: join(dir, 'setup.log'), signal,
      });
      if (r.cancelled) signal.throwIfAborted();
      if (r.exitCode !== 0) throw new Error(`commands.setup a échoué (code ${r.exitCode}) : ${r.output.slice(-300)}`);
    }

    // Le SDK ne charge rien depuis le repo cible : Sisyphe lit lui-même son CLAUDE.md et l'injecte.
    const repoContext = await readRepoContext(worktreePath);
    const appendix = systemAppend(config, repoContext);

    // Triage
    signal.throwIfAborted();
    const tphase = phases.start({ jobId: job.id, name: 'triage', attempt: 1, model: config.models.triage });
    const tres = await deps.agent.run<TriageVerdict>({
      cwd: worktreePath, model: config.models.triage, systemPromptAppend: appendix,
      prompt: triagePrompt(issue, config), outputSchema: triageJsonSchema,
      maxTurns: TRIAGE_MAX_TURNS, maxBudgetUsd: config.budget.triageUsd,
      allowedTools: TRIAGE_TOOLS, disallowedTools: TRIAGE_DENY, env: agentEnvVars,
      timeoutMs: minutes(config.timeouts.triageMinutes), signal, transcriptPath: join(dir, 'transcript-triage-1.jsonl'),
    });
    record(tres);
    const tparsed = TriageVerdictSchema.safeParse(tres.output);
    phases.finish(tphase.id, {
      sessionId: tres.sessionId, costUsd: tres.costUsd, usage: tres.usage, numTurns: tres.numTurns,
      stopReason: tres.stopReason, outcome: tparsed.success ? 'success' : 'failure',
    });
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
      await deps.git.removeWorktree(job.repo, worktreePath, branch);
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
      const iphase = phases.start({ jobId: job.id, name: 'implement', attempt, model: config.models.implement });
      const ires = await deps.agent.run<ImplementationReport>({
        cwd: worktreePath, model: config.models.implement, systemPromptAppend: appendix,
        prompt, outputSchema: reportJsonSchema,
        maxTurns: IMPLEMENT_MAX_TURNS, maxBudgetUsd: config.budget.implementUsd, resumeSessionId: sessionId,
        allowedTools: IMPLEMENT_TOOLS, disallowedTools: IMPLEMENT_DENY,
        hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [pathGuardHook(worktreePath, config.protectedPaths)] }] },
        env: agentEnvVars,
        timeoutMs: minutes(config.timeouts.implementMinutes), signal, transcriptPath: join(dir, `transcript-implement-${attempt}.jsonl`),
      });
      record(ires);
      sessionId = ires.sessionId ?? sessionId;
      const rparsed = ImplementationReportSchema.safeParse(ires.output);
      phases.finish(iphase.id, {
        sessionId: ires.sessionId, costUsd: ires.costUsd, usage: ires.usage, numTurns: ires.numTurns,
        stopReason: ires.stopReason, outcome: rparsed.success ? 'success' : 'failure',
      });
      signal.throwIfAborted();
      report = rparsed.success
        ? rparsed.data
        : fallbackReport(ires.stopReason === 'completed' ? 'rapport non conforme au schéma' : `arrêt anticipé (${ires.stopReason})`);
      if (ires.stopReason !== 'completed') flags = { ...flags, earlyStop: ires.errorMessage ? `${ires.stopReason} : ${ires.errorMessage}` : ires.stopReason };

      job = store.transition(job.id, 'verifying', { report, flags });
      const vphase = phases.start({ jobId: job.id, name: 'verify', attempt });
      verify = await runVerification({ worktreePath, baseSha: wt.baseSha, config, jobDir: dir, env, git: deps.git, signal, scan: deps.scan });
      phases.finish(vphase.id, { outcome: verify.ok ? 'success' : 'failure', stopReason: verify.failedStep });
      flags = { ...flags, protectedPathsTouched: verify.flags.protectedPathsTouched, largeDiff: verify.flags.largeDiff, secretsFound: verify.flags.secretsFound };
      job = store.update(job.id, { flags });

      if (verify.noChanges) {
        await source.comment(issueRef, renderNoChangesComment(report.summary, trigger));
        await source.setStatus(issueRef, 'blocked');
        await deps.git.removeWorktree(job.repo, worktreePath, branch);
        return finish('blocked', { error: 'aucun changement produit' });
      }
      if (verify.flags.secretsFound.length > 0) {
        await source.comment(issueRef, renderSecretsComment(verify.flags.secretsFound, trigger));
        await source.setStatus(issueRef, 'failed');
        return finish('failed', { error: 'secrets détectés dans le diff' });
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

    // Livraison
    job = store.transition(job.id, 'delivering');
    const dphase = phases.start({ jobId: job.id, name: 'deliver', attempt: job.attempt });
    const prTemplate = await readPrTemplate(deps.git, job.repo, config.baseBranch);
    // Le token d'installation vit une heure : on le ré-obtient juste avant le push, un job peut durer plus longtemps.
    const pushUrl = await source.getAuthenticatedRemoteUrl(issueRef.repo);
    const delivered = await deliver({
      job, issue, config, report, verify: verify!, phases: phases.listForJob(job.id),
      source, git: deps.git, worktreePath, pushUrl, prTemplate, durationMs: elapsed(),
    });
    phases.finish(dphase.id, { outcome: 'success' });
    if (delivered.warnings.length) log.warn({ warnings: delivered.warnings }, 'livraison : mises à jour de l’issue partielles');
    const final: JobState = job.flags.verificationFailed ? 'failed' : 'done';
    if (final === 'done') await deps.git.removeWorktree(job.repo, worktreePath, branch);
    log.info({ state: final, pr: delivered.prUrl, costUsd: job.costUsd }, 'job terminé');
    return finish(final, { prNumber: delivered.prNumber, prUrl: delivered.prUrl, prState: 'open' });
  } catch (err) {
    const current = store.get(job.id) ?? job;
    if (isTerminal(current.state)) return current;
    if (signal.aborted) {
      if (signal.reason === SHUTDOWN) {
        log.info('arrêt du daemon : job laissé pour la réconciliation');
        return current;
      }
      log.info('job annulé');
      if (worktreePath) await deps.git.removeWorktree(job.repo, worktreePath, branch ?? undefined).catch(() => undefined);
      await source.comment(issueRef, renderCancelledComment(job.id)).catch(() => undefined);
      await source.setStatus(issueRef, null).catch(() => undefined);
      return finish('cancelled', { error: 'annulé' });
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'job en échec');
    await source.comment(issueRef, renderFailedComment(job.id, message.slice(0, 500), trigger)).catch(() => undefined);
    await source.setStatus(issueRef, 'failed').catch(() => undefined);
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
