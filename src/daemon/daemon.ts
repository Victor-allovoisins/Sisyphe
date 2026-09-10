import type { Logger } from 'pino';
import { renderBudgetPauseComment } from '../deliver/comments.js';
import { issueRefOf, parseRepo, type Issue } from '../github/source.js';
import { CANCELLED, SHUTDOWN, runJob, type PipelineDeps } from '../jobs/pipeline.js';
import { purgeOrphanWorktrees, reconcile } from '../jobs/reconcile.js';
import { canStartJob, startOfLocalDay } from '../jobs/scheduler.js';
import { purgeOldFiles } from '../log/logger.js';
import type { ActionInput, ActionName, ActionSource } from '../store/actions.js';
import { isTerminal, type Job, type JobState } from '../store/types.js';
import { startCaffeinate } from './caffeinate.js';
import type { CommandResult, DaemonStatus, EnqueueIssueInput } from './control-types.js';
import { pollOnce } from './poll.js';

/** Délai maximal laissé aux jobs en vol pour se terminer avant que stop() abandonne (ex. sleep de rate limit d'une heure). */
const STOP_GRACE_MS = 30_000;

const STOPPING_ERROR = "daemon en cours d'arrêt";
const RETRYABLE_STATES: ReadonlySet<JobState> = new Set<JobState>(['failed', 'blocked', 'cancelled']);

/** Ce qu'une commande sait du job visé au moment d'être journalisée ; rempli au fil de son exécution. */
type ActionRef = Pick<ActionInput, 'jobId' | 'repo' | 'issueNumber'>;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface DaemonOptions {
  intervals?: { pollMs?: number; cancelMs?: number; prTrackMs?: number; purgeMs?: number };
  stopGraceMs?: number;
}

export class Daemon {
  private readonly running = new Map<string, AbortController>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly budgetAnnounced = new Set<string>();
  private budgetDay = '';
  private stopCaffeinate: (() => void) | null = null;
  private stopping = false;
  /** Porte de sérialisation : ticks, balayages d'annulation et commandes s'y enchaînent, jamais en parallèle. */
  private chain: Promise<void> = Promise.resolve();
  /** Tick accepté mais pas encore démarré (en attente dans la porte) : les demandes de tick se regroupent dessus. */
  private tickQueued: Promise<void> | null = null;
  private tickRunning = false;
  private paused = false;
  private purging = false;
  private readonly startedAt = new Date().toISOString();
  private stopped: Promise<void> | null = null;
  private resolveStopped: (() => void) | null = null;
  private readonly log: Logger;

  constructor(private readonly d: PipelineDeps, private readonly opts: DaemonOptions = {}) {
    this.log = d.log.child({ component: 'daemon' });
  }

  /** Un cycle complet puis retour : réconciliation, labels, poll, annulations, traitement séquentiel de la file. */
  async runOnce(): Promise<void> {
    await reconcile(this.d);
    await this.ensureLabels();
    await pollOnce(this.d);
    await this.watchCancellations();
    for (;;) {
      const started = this.startNext();
      if (!started) break;
      await started;
    }
    await Promise.allSettled([...this.inflight]);
  }

  async start(): Promise<void> {
    await reconcile(this.d);
    await this.ensureLabels();
    // stop() a pu survenir pendant ce prologue : ne pas poser de timers ni attendre indéfiniment.
    if (this.stopping) return;
    const iv = this.opts.intervals ?? {};
    const pollMs = iv.pollMs ?? this.d.machine.pollIntervalSeconds * 1000;
    this.timers.push(setInterval(() => void this.tick(), pollMs));
    this.timers.push(setInterval(() => void this.watchCancellations(), iv.cancelMs ?? 60_000));
    this.timers.push(setInterval(() => void this.trackPullRequests(), iv.prTrackMs ?? 3_600_000));
    this.timers.push(setInterval(() => void this.purge(), iv.purgeMs ?? 3_600_000));
    this.log.info({ repos: this.d.machine.repos, pollMs }, 'daemon démarré');
    // Un job queued annulé pendant que le daemon était arrêté (label retiré, issue fermée) ne doit
    // pas être lancé par ce premier tick : on balaie les annulations avant, pas seulement toutes les 60 s.
    await this.watchCancellations();
    await this.tick();
    await new Promise<void>((resolve) => {
      if (this.stopping) resolve();
      else this.resolveStopped = resolve;
    });
  }

  /**
   * Arrêt propre, idempotent : tout appelant reçoit la même promesse, résolue une fois le premier arrêt terminé.
   * Pas de `async` ici : il renverrait un nouveau wrapper à chaque appel au lieu de la promesse mémoïsée elle-même.
   */
  stop(): Promise<void> {
    return (this.stopped ??= this.doStop());
  }

  /**
   * Les jobs en cours sont interrompus avec la raison SHUTDOWN et laissés en place pour la réconciliation.
   * L'attente est bornée : un job bloqué (ex. sleep de rate limit d'une heure côté client GitHub) ne doit pas
   * empêcher l'arrêt du daemon — la réconciliation au prochain démarrage reprendra le job resté non terminal.
   */
  private async doStop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    for (const c of this.running.values()) c.abort(SHUTDOWN);

    let graceTimer: NodeJS.Timeout | undefined;
    const grace = new Promise<'timeout'>((resolve) => {
      graceTimer = setTimeout(() => resolve('timeout'), this.opts.stopGraceMs ?? STOP_GRACE_MS);
      graceTimer.unref();
    });
    const outcome = await Promise.race([Promise.allSettled([...this.inflight]).then((): 'done' => 'done'), grace]);
    clearTimeout(graceTimer);
    if (outcome === 'timeout') {
      this.log.warn({ inflight: this.inflight.size }, 'arrêt : jobs encore en vol abandonnés, la réconciliation les reprendra');
    }

    this.stopCaffeinate?.();
    this.log.info('daemon arrêté');
    this.resolveStopped?.();
  }

  /**
   * Enchaîne `fn` après tout ce qui est déjà dans la porte. Le rejet est rendu à l'appelant mais
   * jamais propagé au maillon suivant : une commande en erreur ne bloque pas les ticks.
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Tick du timer : ignoré si un tick tourne ou attend déjà — les ticks ne s'empilent pas. */
  private tick(): Promise<void> {
    if (this.stopping || this.tickQueued || this.tickRunning) return Promise.resolve();
    return this.scheduleTick();
  }

  /**
   * Tick immédiat (commande `poll`). Si un tick est en cours, exactement un tick de plus s'enchaîne
   * après lui ; les demandes reçues pendant ce tick-là se regroupent sur ce seul tick supplémentaire.
   * Renvoie la promesse du tick qui répond à la demande.
   */
  requestTick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return this.tickQueued ?? this.scheduleTick();
  }

  private scheduleTick(): Promise<void> {
    const queued = this.serial(async () => {
      this.tickQueued = null;
      this.tickRunning = true;
      try {
        await this.doTick();
      } finally {
        this.tickRunning = false;
      }
    });
    this.tickQueued = queued;
    return queued;
  }

  private async doTick(): Promise<void> {
    if (this.stopping) return;
    try {
      await pollOnce(this.d);
      while (this.startNext()) {
        /* démarre tant que la concurrence et le budget le permettent */
      }
    } catch (err) {
      this.log.error({ err }, 'tick en erreur');
    }
  }

  /** Démarre le prochain job `queued` si possible. Renvoie sa promesse, ou null. */
  private startNext(): Promise<unknown> | null {
    if (this.stopping) return null;
    if (this.paused) return null;
    if (this.purging) return null;
    const check = canStartJob({
      activeCount: this.running.size,
      maxConcurrent: this.d.machine.maxConcurrentJobs,
      spentTodayUsd: this.d.phases.costSince(startOfLocalDay()),
      dailyBudgetUsd: this.d.machine.dailyBudgetUsd,
    });
    if (!check.ok) {
      if (check.reason === 'budget') {
        // Suivi dans inflight pour que runOnce() et stop() attendent les commentaires.
        const p: Promise<unknown> = this.announceBudgetPause().finally(() => this.inflight.delete(p));
        this.inflight.add(p);
      }
      return null;
    }
    const job = this.d.store.nextQueued();
    if (!job) return null;

    const controller = new AbortController();
    this.running.set(job.id, controller);
    if (this.running.size === 1) this.stopCaffeinate = startCaffeinate();
    const p: Promise<unknown> = runJob(job.id, this.d, controller.signal)
      .catch((err) => this.log.error({ err, jobId: job.id }, 'runJob a levé une exception'))
      .finally(() => {
        this.running.delete(job.id);
        this.inflight.delete(p);
        if (this.running.size === 0) {
          this.stopCaffeinate?.();
          this.stopCaffeinate = null;
        }
      });
    this.inflight.add(p);
    return p;
  }

  private async announceBudgetPause(): Promise<void> {
    const day = startOfLocalDay();
    if (day !== this.budgetDay) {
      this.budgetDay = day;
      this.budgetAnnounced.clear();
    }
    for (const job of this.d.store.listByStates(['queued'])) {
      const key = `${day}:${job.repo}#${job.issueNumber}`;
      if (this.budgetAnnounced.has(key)) continue;
      this.budgetAnnounced.add(key);
      this.log.warn({ jobId: job.id }, 'budget quotidien atteint');
      await this.d.source.comment(issueRefOf(job), renderBudgetPauseComment(this.d.machine.dailyBudgetUsd)).catch(() => undefined);
    }
  }

  /**
   * Annule les jobs dont l'issue a perdu son label trigger ou a été fermée : ceux en cours d'exécution, et ceux
   * encore en file. Sous la porte de sérialisation : une commande qui crée un job puis pose son label ne peut
   * pas être observée à mi-chemin (job actif sans label).
   */
  watchCancellations(): Promise<void> {
    return this.serial(() => this.sweepCancellations());
  }

  private async sweepCancellations(): Promise<void> {
    for (const [jobId, controller] of this.running) {
      const job = this.d.store.get(jobId);
      if (!job) continue;
      try {
        if (!(await this.d.source.isStillActive(issueRefOf(job)))) {
          this.log.info({ jobId }, 'label retiré ou issue fermée : annulation');
          controller.abort(CANCELLED);
        }
      } catch (err) {
        this.log.warn({ err, jobId }, 'watchCancellations : vérification impossible');
      }
    }
    for (const job of this.d.store.listByStates(['queued'])) {
      try {
        if (!(await this.d.source.isStillActive(issueRefOf(job)))) {
          // Défense en profondeur : sous la porte de sérialisation aucun tick ne s'intercale pendant l'await
          // ci-dessus, mais relire l'état avant d'annuler ne coûte rien et protège un futur appelant hors porte.
          const fresh = this.d.store.get(job.id);
          if (fresh?.state !== 'queued') continue;
          this.d.store.transition(job.id, 'cancelled');
          this.log.info({ jobId: job.id }, 'job annulé avant démarrage');
        }
      } catch (err) {
        this.log.warn({ err, jobId: job.id }, 'watchCancellations : vérification impossible');
      }
    }
  }

  /** Idempotent ; journalisé à chaque appel, même sans changement d'état. */
  pause(source: ActionSource): DaemonStatus {
    this.paused = true;
    this.log.info({ source }, 'daemon en pause : aucun job ne démarre');
    this.d.actions.record({ action: 'pause', source, outcome: 'ok' });
    return this.status();
  }

  resume(source: ActionSource): DaemonStatus {
    this.paused = false;
    this.log.info({ source }, 'daemon repris');
    this.d.actions.record({ action: 'resume', source, outcome: 'ok' });
    return this.status();
  }

  status(): DaemonStatus {
    return {
      pid: process.pid,
      paused: this.paused,
      running: this.running.size,
      queued: this.d.store.countByState().queued,
      startedAt: this.startedAt,
    };
  }

  /**
   * Annule un job : label trigger retiré, puis abort du pipeline (job en cours) ou passage direct en
   * `cancelled` (job en file). Pour un job en cours, le job renvoyé est l'instantané au moment de
   * l'abort : c'est le pipeline qui le passe `cancelled`, de façon asynchrone.
   */
  cancelJob(jobId: string, source: ActionSource): Promise<CommandResult<Job>> {
    return this.command('cancel', source, async (ref) => {
      ref.jobId = jobId;
      const job = this.d.store.get(jobId);
      if (!job) return { ok: false, error: `job inconnu : ${jobId}` };
      ref.repo = job.repo;
      ref.issueNumber = job.issueNumber;
      if (isTerminal(job.state)) return { ok: false, error: `job déjà terminé (${job.state})` };
      await this.d.source.removeTriggerLabel(issueRefOf(job));
      const controller = this.running.get(jobId);
      if (controller) {
        controller.abort(CANCELLED);
        this.log.info({ jobId, source }, 'annulation : job en cours interrompu');
        return { ok: true, result: this.d.store.get(jobId) ?? job };
      }
      // Le job a pu se terminer de lui-même pendant l'appel réseau ci-dessus : on relit l'état avant d'agir.
      const fresh = this.d.store.get(jobId) ?? job;
      if (isTerminal(fresh.state)) return { ok: false, error: `job terminé entre-temps (${fresh.state})` };
      this.log.info({ jobId, source }, 'annulation : job retiré de la file');
      return { ok: true, result: this.d.store.transition(jobId, 'cancelled') };
    });
  }

  /** Relance un job terminé sans succès : nouveau job `queued` sur la même issue, label trigger reposé. */
  retryJob(jobId: string, source: ActionSource): Promise<CommandResult<Job>> {
    return this.command('retry', source, async (ref) => {
      ref.jobId = jobId;
      const job = this.d.store.get(jobId);
      if (!job) return { ok: false, error: `job inconnu : ${jobId}` };
      ref.repo = job.repo;
      ref.issueNumber = job.issueNumber;
      if (!RETRYABLE_STATES.has(job.state)) {
        return { ok: false, error: `job non relançable (${job.state}) : seuls failed, blocked et cancelled le sont` };
      }
      return this.createLabelled({ repo: job.repo, issueNumber: job.issueNumber, issueTitle: job.issueTitle }, ref);
    });
  }

  /** Crée un job sur une issue au choix de l'opérateur local. Pas de `canTrigger` : il est de confiance. */
  enqueueIssue(input: EnqueueIssueInput, source: ActionSource): Promise<CommandResult<Job>> {
    return this.command('enqueue', source, async (ref) => {
      ref.repo = input.repo;
      ref.issueNumber = input.issueNumber;
      if (!this.d.machine.repos.includes(input.repo)) return { ok: false, error: `repo hors configuration : ${input.repo}` };
      let issue: Issue;
      try {
        issue = await this.d.source.getIssue({ repo: parseRepo(input.repo), number: input.issueNumber });
      } catch (err) {
        return { ok: false, error: `issue illisible : ${messageOf(err)}` };
      }
      if (issue.state === 'closed') return { ok: false, error: `issue fermée : ${input.repo}#${input.issueNumber}` };
      return this.createLabelled({ repo: input.repo, issueNumber: input.issueNumber, issueTitle: issue.title }, ref);
    });
  }

  /**
   * Crée le job puis pose le label, dans cet ordre : le poll refuse un label posé par l'App elle-même
   * (`canTrigger`), il doit donc déjà trouver un job actif et passer son chemin. Et comme `watchCancellations`
   * annule un job actif sans label, la séquence entière tient sous la porte de sérialisation.
   */
  private async createLabelled(input: { repo: string; issueNumber: number; issueTitle: string }, ref: ActionRef): Promise<CommandResult<Job>> {
    const active = this.d.store.findActiveByIssue(input.repo, input.issueNumber);
    if (active) return { ok: false, error: `un job est déjà actif sur ${input.repo}#${input.issueNumber} (${active.id}, ${active.state})` };
    const job = this.d.store.create(input);
    ref.jobId = job.id;
    try {
      await this.d.source.addTriggerLabel(issueRefOf(job));
    } catch (err) {
      const error = `label impossible : ${messageOf(err)}`;
      this.log.warn({ err, jobId: job.id }, 'label trigger non posé : job annulé');
      this.d.store.transition(job.id, 'cancelled', { flags: { ...job.flags, earlyStop: error } });
      return { ok: false, error };
    }
    this.log.info({ jobId: job.id, repo: job.repo, issue: job.issueNumber }, 'nouveau job créé à la demande');
    return { ok: true, result: job };
  }

  /**
   * Exécute une commande sous la porte de sérialisation et la journalise dans `actions`. Une exception
   * devient un refus (`ok: false`) : le client (socket, UI) n'a jamais à distinguer un refus métier d'une panne.
   */
  private command<T>(action: ActionName, source: ActionSource, fn: (ref: ActionRef) => Promise<CommandResult<T>>): Promise<CommandResult<T>> {
    return this.serial(async () => {
      const ref: ActionRef = {};
      let res: CommandResult<T>;
      if (this.stopping) res = { ok: false, error: STOPPING_ERROR };
      else {
        try {
          res = await fn(ref);
        } catch (err) {
          this.log.error({ err, action }, 'commande en erreur');
          res = { ok: false, error: messageOf(err) };
        }
      }
      this.d.actions.record({ action, source, ...ref, outcome: res.ok ? 'ok' : 'error', error: res.ok ? null : res.error });
      return res;
    });
  }

  /** Met à jour l'état des PR ouvertes de moins de 30 jours (KPI taux de merge). */
  async trackPullRequests(): Promise<void> {
    for (const job of this.d.store.listWithOpenPr(30)) {
      if (job.prNumber === null) continue;
      try {
        const st = await this.d.source.getPullRequestState({ repo: parseRepo(job.repo), number: job.prNumber, url: job.prUrl ?? '' });
        this.d.store.update(job.id, { prState: st.state, prMergedAt: st.mergedAt });
      } catch (err) {
        this.log.warn({ err, jobId: job.id }, 'trackPullRequests : lecture impossible');
      }
    }
  }

  private async purge(): Promise<void> {
    // Pas de purge pendant qu'un job tourne : `keep` est un instantané (voir purgeOrphanWorktrees).
    if (this.running.size === 0) {
      this.purging = true;
      try {
        await purgeOrphanWorktrees(this.d);
      } catch (err) {
        this.log.warn({ err }, 'purge des worktrees');
      } finally {
        this.purging = false;
      }
    }
    await purgeOldFiles(this.d.paths.logsDir, 14).catch(() => undefined);
  }

  private async ensureLabels(): Promise<void> {
    for (const full of this.d.machine.repos) {
      await this.d.source.ensureLabels(parseRepo(full)).catch((err) => this.log.warn({ err, repo: full }, 'ensureLabels'));
    }
  }
}
