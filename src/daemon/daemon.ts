import type { Logger } from 'pino';
import { renderBudgetPauseComment } from '../deliver/comments.js';
import { issueRefOf, parseRepo } from '../github/source.js';
import { CANCELLED, SHUTDOWN, runJob, type PipelineDeps } from '../jobs/pipeline.js';
import { purgeOrphanWorktrees, reconcile } from '../jobs/reconcile.js';
import { canStartJob, startOfLocalDay } from '../jobs/scheduler.js';
import { purgeOldFiles } from '../log/logger.js';
import { startCaffeinate } from './caffeinate.js';
import { pollOnce } from './poll.js';

export interface DaemonOptions {
  intervals?: { pollMs?: number; cancelMs?: number; prTrackMs?: number; purgeMs?: number };
}

export class Daemon {
  private readonly running = new Map<string, AbortController>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly budgetAnnounced = new Set<string>();
  private budgetDay = '';
  private stopCaffeinate: (() => void) | null = null;
  private stopping = false;
  private ticking = false;
  private purging = false;
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

  /** Les jobs en cours sont interrompus avec la raison SHUTDOWN et laissés en place pour la réconciliation. */
  private async doStop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    for (const c of this.running.values()) c.abort(SHUTDOWN);
    await Promise.allSettled([...this.inflight]);
    this.stopCaffeinate?.();
    this.log.info('daemon arrêté');
    this.resolveStopped?.();
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.ticking) return;
    this.ticking = true;
    try {
      await pollOnce(this.d);
      while (this.startNext()) {
        /* démarre tant que la concurrence et le budget le permettent */
      }
    } catch (err) {
      this.log.error({ err }, 'tick en erreur');
    } finally {
      this.ticking = false;
    }
  }

  /** Démarre le prochain job `queued` si possible. Renvoie sa promesse, ou null. */
  private startNext(): Promise<unknown> | null {
    if (this.stopping) return null;
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

  /** Annule les jobs dont l'issue a perdu son label trigger ou a été fermée : ceux en cours d'exécution, et ceux encore en file. */
  async watchCancellations(): Promise<void> {
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
          this.d.store.transition(job.id, 'cancelled');
          this.log.info({ jobId: job.id }, 'job annulé avant démarrage');
        }
      } catch (err) {
        this.log.warn({ err, jobId: job.id }, 'watchCancellations : vérification impossible');
      }
    }
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
