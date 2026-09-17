import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { supportsSkills } from '../agent/plugin-path.js';
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
  renderBlockedComment, renderCancelledComment, renderConfigProblemComment, renderDoneComment,
  renderMissingVersionComment, renderFailedComment,
  renderNoChangesComment, renderProtectedPathsComment, renderSecretsComment,
} from '../deliver/comments.js';
import { deliver } from '../deliver/deliver.js';
import type { Git } from '../git/git.js';
import { issueRefOf, type Forge, type Issue, type IssueTracker, type StatusLabel } from '../github/source.js';
import { browseUrl } from '../jira/links.js';
import { sameStatus } from '../jira/transitions.js';
import type { ActionStore } from '../store/actions.js';
import type { JobPatch, JobStore } from '../store/jobs.js';
import type { PhaseFinish, PhaseStore } from '../store/phases.js';
import { isTerminal, type Job, type JobFlags, type JobState, type PhaseName } from '../store/types.js';
import { minutes } from '../util/time.js';
import { agentEnv, repoEnv, runRepoCommand } from '../verify/commands.js';
import { runVerification, type ScanFn, type VerifyResult } from '../verify/verify.js';
import { resolveBaseBranch } from './base-branch.js';
import { jiraOutcomeOf, runJiraPhase } from './jira-sync.js';
import { relaunchFor } from './relaunch.js';
import { branchName } from './slug.js';

export interface PipelineDeps {
  store: JobStore;
  phases: PhaseStore;
  /** Journal des commandes (UI, CLI) : écrit par le daemon, lu par l'UI. */
  actions: ActionStore;
  source: IssueTracker;
  /** La forge git, distincte du suivi : c'est elle qui pousse et ouvre les PR. */
  forge: Forge;
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

/** Le statut que le chemin scripté posait pour chaque issue. */
function statusFor(state: JobState): StatusLabel | null {
  if (state === 'done') return 'done';
  if (state === 'failed') return 'failed';
  if (state === 'blocked') return 'blocked';
  return null;
}

export async function runJob(jobId: string, deps: PipelineDeps, signal: AbortSignal): Promise<Job> {
  const { store, phases, source, forge } = deps;
  const initial = store.get(jobId);
  if (!initial) throw new Error(`Job inconnu : ${jobId}`);
  let job = initial;
  const log = deps.log.child({ jobId, repo: job.repo, issue: job.issueNumber });
  const issueRef = issueRefOf(job);
  const trigger = relaunchFor(deps.machine, job.repo);
  const dir = jobDirFor(deps.paths, job.id);
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
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

  // Hors du `try` : la clôture s'en sert depuis les sorties les plus précoces comme depuis le `catch`.
  let issue: Issue | null = null;
  /**
   * L'environnement de la phase `jira` : le daemon épuré, et rien du dépôt. Elle n'a ni worktree ni branche
   * à nommer — `SISYPHE_BRANCH` vide plutôt qu'une branche qui n'existe pas encore sur les sorties précoces.
   */
  const jiraEnv = agentEnv(
    deps.env,
    { cacheDir: repoCachePath(deps.paths, job.repo), issueNumber: job.issueNumber, branch: '' },
    deps.machine.agentBackend,
  );

  /** Ce que le scripté postait avant, réutilisé par le filet quand l'agent n'a rien dit. */
  const scriptedComment = (state: JobState, finished: Job): string => {
    if (state === 'cancelled') return renderCancelledComment(finished.id);
    if (finished.prUrl) {
      return renderDoneComment({
        jobId: finished.id, prUrl: finished.prUrl, status: state === 'done' ? 'done' : 'failed',
        costUsd: finished.costUsd, durationMs: finished.durationMs, attempts: finished.attempt,
      });
    }
    return renderFailedComment(finished.id, (finished.error ?? '').slice(0, 500), trigger);
  };

  /**
   * Phase `jira` puis filet. Trois invariants, et rien d'autre :
   * 1. un job non livré ne laisse jamais le ticket assigné au compte dédié ;
   * 2. un job terminé laisse toujours un commentaire ;
   * 3. un job livré, dont le ticket est resté sur le statut « en cours », ne reste pas bloqué là.
   *
   * Le filet tient dans le `finally`, et il n'interroge que Jira. Ni le rapport de l'agent ni même la bonne
   * fin de la phase ne le conditionnent : un agent qui affirme avoir rendu la main sans l'avoir fait, un
   * `canTrigger` qui tombe, une exception avant d'arriver jusqu'ici — chacun laissait sinon le ticket assigné
   * au compte dédié et hors des statuts candidats, c'est-à-dire repris par personne et vu par personne.
   *
   * `comment` est le texte que la sortie avait rédigé pour elle-même (verdict de triage, secrets, chemins
   * protégés…) : lui seul dit *pourquoi* le job s'arrête là, et le message générique ne le remplace pas. Il
   * part donc en brouillon à l'agent, qui le reformule sans en perdre la substance, et sert de repli s'il
   * n'écrit rien — son texte, quand il en écrit un, remplace le brouillon plutôt que de s'y ajouter.
   */
  const closeTicket = async (finished: Job, state: JobState, comment?: string): Promise<void> => {
    const scripted = comment ?? scriptedComment(state, finished);
    const key = issue?.tracker?.key;
    const project = deps.machine.jira?.projects.find((p) => p.repo === job.repo);
    if (!key || !project || !supportsSkills(deps.machine.agentBackend)) {
      // Chemin historique : suivi GitHub, ou backend sans skills. Les échecs se loggent comme ceux du chemin
      // Jira : avant que la clôture ne soit séparée de `deliver`, ils remontaient en `warnings` du job — un
      // label `sisyphe:done` jamais posé ne laissait sinon aucune trace nulle part.
      await source.comment(issueRef, scripted).catch((err) => log.warn({ err }, 'commentaire de fin non posté'));
      await source.setStatus(issueRef, statusFor(state)).catch((err) => log.warn({ err }, 'statut de fin non posé'));
      return;
    }
    // L'agent rédige, le pipeline poste : c'est le seul chemin, et il garantit qu'un job terminé laisse
    // toujours une trace — texte de l'agent s'il en a écrit un, message scripté sinon. Calculé ici, avant
    // le `try` : le filet doit pouvoir le poster même quand la phase a levé sans rien rendre.
    let body = scripted;
    try {
      // Pas de modèle imposé : `config` (le sisyphe.yml du dépôt) n'existe pas sur les sorties les plus
      // précoces — une config illisible est justement l'une d'elles. Chaque backend applique son défaut.
      const { report, result } = await runPhase('jira', finished.attempt, null, () =>
        runJiraPhase(
          { agent: deps.agent, env: jiraEnv, transcriptPath: join(dir, `transcript-jira-${finished.attempt}.jsonl`), cwd: dir, timeoutMs: minutes(5), signal },
          finished,
          jiraOutcomeOf(finished, state, project.doneStatus, key, scripted),
        ),
        (out) => ({ outcome: out.report.note ? 'failure' : 'success', costUsd: out.result.costUsd, usage: out.result.usage, numTurns: out.result.numTurns, stopReason: out.result.stopReason }),
      );
      // Le coût suit le job comme celui des autres phases : le plafond quotidien le compte.
      record(result);
      body = report.comment.trim() || scripted;
    } finally {
      if (state !== 'done') {
        // Un `canTrigger` en erreur ne dit pas « pas à nous », il ne dit rien : on penche alors vers le rendu.
        // Rendre un ticket déjà rendu ne coûte qu'un PUT — `removeTriggerLabel` est idempotent — quand ne pas
        // rendre celui qui aurait dû l'être est précisément la panne silencieuse à empêcher.
        const still = await source.canTrigger(issueRef).catch(() => ({ ok: true, login: null }));
        if (still.ok) await source.removeTriggerLabel(issueRef).catch((err) => log.warn({ err }, 'ticket non rendu'));
      } else {
        // Livré : seul l'agent posait le statut de relecture, et une phase muette laissait le ticket sur le
        // statut « en cours ». La réconciliation le rattrape, mais au seul démarrage du daemon — des semaines,
        // sur un service qui tourne (`releaseStaleInProgressLabels`, qui s'appuie sur la PR ouverte).
        //
        // Resserré sur ce statut précis, et non sur « pas encore terminé » : un ticket avancé *au-delà* de
        // `doneStatus` — par exemple sur « Developpement fini », toujours assigné au compte dédié, l'état
        // normal d'une livraison puisque le skill garde volontairement l'assignation — passait l'ancien garde
        // (`isStillActive` : assigné au compte dédié et catégorie ≠ done, rien de plus précis), et
        // `setStatus(ref, 'done')` l'aurait fait *reculer* : `walkTo` marche à l'envers dès que la cible
        // précède le statut courant dans `statusesInOrder`.
        //
        // Sur incertitude (lecture Jira en échec, ou état vide), on ne bouge pas : `?? ''` ne peut jamais
        // égaler `inProgressStatus`, donc l'échec et l'inconnu retombent tous deux sur « ne pas agir ».
        // Contrairement au rendu ci-dessus — un PUT assignee, idempotent, où pencher vers l'action ne coûte
        // rien — celui-ci déplace le ticket sur le board, et se tromper y coûte un recul ; un faux négatif,
        // lui, n'est pas définitif : la réconciliation au prochain démarrage du daemon le rattrape tant qu'une
        // PR reste ouverte.
        const fresh = await source.getIssue(issueRef).catch(() => null);
        const stillInProgress = fresh ? sameStatus(fresh.tracker?.status ?? '', project.inProgressStatus) : false;
        if (stillInProgress) {
          await source.setStatus(issueRef, 'done').catch((err) => log.warn({ err }, 'statut de relecture non posé'));
        }
      }
      await source.comment(issueRef, body).catch((err) => log.warn({ err }, 'commentaire de fin non posté'));
    }
  };

  /**
   * Le point de sortie unique du job. Toute issue passe par ici : c'est ce qui garantit qu'un ticket est
   * toujours clos, quel que soit le chemin pris — y compris les sorties anticipées du triage.
   *
   * Sous suivi GitHub, ou sur un backend agent sans skills, on garde le chemin scripté d'avant.
   */
  const finish = async (state: JobState, patch: JobPatch = {}, comment?: string): Promise<Job> => {
    const current = store.get(job.id) ?? job;
    const finished = store.transition(job.id, state, { ...patch, durationMs: (current.durationMs ?? 0) + elapsed() });
    await closeTicket(finished, state, comment).catch((err) => log.warn({ err }, 'clôture du ticket incomplète'));
    // Relu après la clôture : la phase `jira` a pu imputer son coût au job entre-temps.
    return store.get(job.id) ?? finished;
  };

  try {
    // Synchrone, avant tout await : le daemon s'appuie dessus pour ne pas redémarrer le même job.
    job = store.transition(job.id, 'triaging');
    // Avant la première sortie possible, `throwIfAborted` compris : toute sortie passe par `finish`, qui
    // fait tourner la phase `jira` dans `dir`. Une annulation au tout début l'y trouverait sinon absent.
    await mkdir(dir, { recursive: true });
    signal.throwIfAborted();
    await source.setStatus(issueRef, 'in-progress');
    issue = await source.getIssue(issueRef);
    // Constante, comme `wtPath` plus bas : le `let` sert à la clôture, qui lit le ticket depuis le `catch`,
    // mais son rétrécissement à `Issue` ne survit ni aux `await` qui suivent ni aux closures.
    const loaded = issue;

    // Git et configuration du repo : on ne rafraîchit que les branches de base, jamais celles des jobs.
    const fetchUrl = await forge.getAuthenticatedRemoteUrl(issueRef.repo);
    const publicUrl = `https://github.com/${job.repo}.git`;
    const defaultBranch = await forge.getDefaultBranch(issueRef.repo);
    await deps.git.ensureMirror(job.repo, fetchUrl, publicUrl, [defaultBranch]);
    const configText = await deps.git.readFileAtRef(job.repo, defaultBranch, REPO_CONFIG_FILENAME);
    let config: RepoConfig;
    try {
      if (configText === null) throw new RepoConfigError('missing', `${REPO_CONFIG_FILENAME} absent sur la branche ${defaultBranch}`);
      config = parseRepoConfig(configText);
    } catch (err) {
      if (!(err instanceof RepoConfigError)) throw err;
      return finish('blocked', { error: err.message }, renderConfigProblemComment(err.kind, err.message, trigger));
    }

    // Avec Jira, la branche de base dépend de la version visée par le ticket, pas seulement du `sisyphe.yml`.
    const base = await resolveBaseBranch({
      config,
      issue: loaded,
      branchExists: (b) => deps.git.remoteBranchExists(fetchUrl, b),
    });
    if (base.kind === 'blocked') {
      return finish('blocked', { error: base.reason }, renderMissingVersionComment(base.reason, trigger));
    }
    const baseBranch = base.branch;
    deps.log.info({ jobId: job.id, baseBranch, raison: base.reason }, 'branche de base retenue');

    if (baseBranch !== defaultBranch) await deps.git.ensureMirror(job.repo, fetchUrl, publicUrl, [baseBranch]);
    branch = branchName(config.branchPrefix, job.issueNumber, job.issueTitle);
    const wt = await deps.git.createWorktree(job.repo, job.issueNumber, branch, baseBranch);
    // Constante : les closures ci-dessous (agent, vérification, livraison) ne conservent pas le rétrécissement d'un `let`.
    const wtPath = wt.worktreePath;
    worktreePath = wtPath;
    job = store.update(job.id, { branch, baseSha: wt.baseSha, worktreePath: wtPath });
    const envExtra = { cacheDir: repoCachePath(deps.paths, job.repo), issueNumber: job.issueNumber, branch };
    const env = repoEnv(deps.env, envExtra);
    // Les phases de code travaillent dans le worktree : elles reçoivent les variables du dépôt, dont la
    // phase `jira` (voir `jiraEnv` plus haut) n'a rien à faire.
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
          prompt: triagePrompt(loaded, config), outputSchema: triageJsonSchema,
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
          note: "Sisyphe a rencontré un problème technique avant de pouvoir analyser cette issue, sans rapport avec son contenu.",
          change_type: 'chore', plan: [], files_likely_touched: [], questions: [], reasons: [`Arrêt du triage : ${tres.stopReason}`],
          // Le triage n'a rien pu prévoir : périmètre complet, jamais l'occasion de vérifier moins.
          verification: { steps: ['build', 'test', 'lint'], why: "aucune prévision de périmètre, le triage n'a pas abouti" },
        };
    job = store.update(job.id, { verdict });
    if (verdict.verdict !== 'ready') {
      await cleanup();
      return finish('blocked', { error: `triage : ${verdict.verdict}` }, renderBlockedComment(verdict, trigger));
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
      const prompt = verify?.failedStep ? retryPrompt(verify.failedStep, verify.failureTail) : implementPrompt(loaded, verdict, config);
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
        await cleanup();
        return finish('blocked', { error: 'aucun changement produit' }, renderNoChangesComment(report.summary, trigger));
      }
      if (verify.flags.secretsFound.length > 0) {
        await cleanup();
        return finish('failed', { error: 'secrets détectés dans le diff' }, renderSecretsComment(verify.flags.secretsFound, trigger));
      }
      if (verify.flags.protectedPathsTouched.length > 0) {
        await cleanup();
        return finish('failed', { error: 'chemins protégés modifiés dans le diff' }, renderProtectedPathsComment(verify.flags.protectedPathsTouched, trigger));
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
        const prTemplate = await readPrTemplate(deps.git, job.repo, baseBranch);
        // Le token d'installation vit une heure : on le ré-obtient juste avant le push, un job peut durer plus longtemps.
        const pushUrl = await forge.getAuthenticatedRemoteUrl(issueRef.repo);
        // durationMs ici = durée de ce seul run (depuis startedAt, ligne ~71) ; job.durationMs, lui, cumule
        // les runs précédents d'un job requeué (voir finish() ci-dessus) — deux grandeurs distinctes.
        const ticket = loaded.tracker && deps.machine.jira
          ? { key: loaded.tracker.key, url: browseUrl(deps.machine.jira.site, loaded.tracker.key) }
          : null;
        return deliver({
          job, issue: loaded, config, report, verify: verified, phases: phases.listForJob(job.id), ticket,
          forge, git: deps.git, worktreePath: wtPath, pushUrl, prTemplate, baseBranch, durationMs: elapsed(),
        });
      },
      () => ({ outcome: 'success' }),
    );
    // La PR existe : on la persiste avant tout nettoyage, pour qu'un incident ensuite n'en perde pas la trace.
    job = store.update(job.id, { prNumber: delivered.prNumber, prUrl: delivered.prUrl, prState: 'open' });
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
        return finish('cancelled', { error: 'annulé' });
      }
      log.info({ reason: signal.reason, err }, 'arrêt du daemon ou abort inconnu : job laissé pour la réconciliation');
      return current;
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'job en échec');
    // Avant la clôture, désormais, et non plus après : `finish` y fait tourner un tour d'agent, et le
    // worktree n'a pas à rester sur le disque pendant ce temps. Le nettoyage ne lève jamais (voir `cleanup`),
    // donc il ne peut toujours pas retarder indéfiniment ce que l'opérateur voit.
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
