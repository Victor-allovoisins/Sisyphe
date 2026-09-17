import { rm } from 'node:fs/promises';
import type { Logger } from 'pino';
import { diffMachineConfig } from '../config/diff.js';
import { effectiveDailyBudget, loadMachineConfig, type MachineConfig } from '../config/machine.js';
import { jobDir, machineConfigPath } from '../config/paths.js';
import { renderBudgetPauseComment } from '../deliver/comments.js';
import { issueRefOf, parseRepo, type Issue } from '../github/source.js';
import { CANCELLED, SHUTDOWN, runJob, type PipelineDeps } from '../jobs/pipeline.js';
import { purgeOrphanWorktrees, reconcile } from '../jobs/reconcile.js';
import { canStartJob, startOfLocalDay } from '../jobs/scheduler.js';
import { purgeOldFiles } from '../log/logger.js';
import type { ActionInput, ActionName, ActionSource } from '../store/actions.js';
import { isTerminal, type Job, type JobState } from '../store/types.js';
import { purgeCache, type PurgeResult } from '../util/cache.js';
import { startCaffeinate } from './caffeinate.js';
import { startControlServer, type ControlServer } from './control.js';
import {
  RESTART_REQUIRED_FIELDS,
  type CommandResult,
  type DaemonStatus,
  type EnqueueIssueInput,
  type HotReloadField,
  type ReloadResult,
  type RestartRequiredField,
} from './control-types.js';
import { pollOnce, resumeBlocked } from './poll.js';

/** Délai maximal laissé aux jobs en vol pour se terminer avant que stop() abandonne (ex. sleep de rate limit d'une heure). */
const STOP_GRACE_MS = 30_000;

const STOPPING_ERROR = "daemon en cours d'arrêt";
const RETRYABLE_STATES: ReadonlySet<JobState> = new Set<JobState>(['failed', 'blocked', 'cancelled']);

/**
 * Un recopieur par champ à chaud, qui pose la valeur du fichier sur la configuration vivante. `Record` : un
 * champ classé à chaud sans recopieur ne compile pas. Savoir *si* un champ a changé revient à
 * `diffMachineConfig`, partagé avec la page de réglages.
 */
const COPY_HOT: Record<HotReloadField, (current: MachineConfig, next: MachineConfig) => void> = {
  dailyBudgetUsd: (c, n) => {
    c.dailyBudgetUsd = n.dailyBudgetUsd;
  },
  maxConcurrentJobs: (c, n) => {
    c.maxConcurrentJobs = n.maxConcurrentJobs;
  },
  pollIntervalSeconds: (c, n) => {
    c.pollIntervalSeconds = n.pollIntervalSeconds;
  },
};

/** Ce qu'une commande sait du job visé au moment d'être journalisée ; rempli au fil de son exécution. */
type ActionRef = Pick<ActionInput, 'jobId' | 'repo' | 'issueNumber'>;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface DaemonOptions {
  intervals?: { pollMs?: number; cancelMs?: number; prTrackMs?: number; purgeMs?: number };
  stopGraceMs?: number;
  /** `start()` ouvre la socket de contrôle (`paths.controlSocketPath`) ; false pour les tests qui n'en veulent pas. */
  control?: boolean;
  /**
   * Fichier relu par `reload` ; par défaut `machineConfigPath()`, résolu à l'appel et non à la construction,
   * pour qu'un test qui ne recharge jamais rien n'aille pas chercher la configuration réelle de la machine.
   */
  configPath?: string;
}

export class Daemon {
  private readonly running = new Map<string, AbortController>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly timers: NodeJS.Timeout[] = [];
  /** Minuteur de poll, retenu à part pour que `reload` reprogramme celui-là et lui seul. */
  private pollTimer: NodeJS.Timeout | null = null;
  /** Champs structurels vus différents du fichier depuis le démarrage : seul un redémarrage les efface. */
  private readonly pendingRestart = new Set<RestartRequiredField>();
  private readonly budgetAnnounced = new Set<string>();
  private budgetDay = '';
  private stopCaffeinate: (() => void) | null = null;
  private control: ControlServer | null = null;
  private stopping = false;
  /** Porte de sérialisation : ticks, balayages d'annulation et commandes s'y enchaînent, jamais en parallèle. */
  private chain: Promise<void> = Promise.resolve();
  /** Tick accepté mais pas encore démarré (en attente dans la porte) : les demandes de tick se regroupent dessus. */
  private tickQueued: Promise<void> | null = null;
  private tickRunning = false;
  private paused = false;
  /** Purges en cours (périodique, commande) : tant qu'il y en a une, rien ne démarre. Compteur, pour que la fin de l'une ne rouvre pas la porte à l'autre. */
  private purging = 0;
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
    await resumeBlocked(this.d);
    await pollOnce(this.d);
    await this.watchCancellations();
    for (;;) {
      const started = this.startNext();
      if (!started) break;
      await started;
    }
    await Promise.allSettled([...this.inflight, this.chain]);
  }

  async start(): Promise<void> {
    // stop() avant même le premier await : ne rien ouvrir.
    if (this.stopping) return;
    // La socket d'abord : le prologue (réconciliation, labels) interroge GitHub repo par repo et peut
    // durer des dizaines de secondes. Sans socket ouverte, l'UI conclurait à tort à un échec de démarrage ;
    // les commandes reçues entre-temps attendent derrière la porte de sérialisation.
    if (this.opts.control !== false) {
      this.control = await startControlServer({ path: this.d.paths.controlSocketPath, daemon: this, actions: this.d.actions, log: this.d.log });
      // stop() pendant l'ouverture n'a rien trouvé à fermer : c'est à nous de le faire.
      if (this.stopping) {
        await this.closeControl();
        return;
      }
      // Le démarrage n'arrive jamais par une commande : sans cette ligne, « Dernières actions » montrerait
      // les arrêts sans les démarrages. `cli` parce que c'est le process lui-même, quel que soit ce qui l'a lancé.
      this.journal({ action: 'start', source: 'cli', outcome: 'ok' });
    }
    await reconcile(this.d);
    await this.ensureLabels();
    // stop() a pu survenir pendant ce prologue : ne pas poser de timers ni attendre indéfiniment.
    // closeControl() est idempotent : doStop() a déjà pu fermer la socket de son côté.
    if (this.stopping) {
      await this.closeControl();
      return;
    }
    const iv = this.opts.intervals ?? {};
    const pollMs = iv.pollMs ?? this.d.machine.pollIntervalSeconds * 1000;
    this.schedulePoll(pollMs);
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
    // Le champ ne doit pas survivre au minuteur qu'il nomme.
    this.pollTimer = null;
    // La socket d'abord : plus aucune commande n'entre pendant l'arrêt.
    await this.closeControl();
    for (const c of this.running.values()) c.abort(SHUTDOWN);

    let graceTimer: NodeJS.Timeout | undefined;
    const grace = new Promise<'timeout'>((resolve) => {
      graceTimer = setTimeout(() => resolve('timeout'), this.opts.stopGraceMs ?? STOP_GRACE_MS);
      graceTimer.unref();
    });
    // La porte aussi : une commande en vol ne doit pas être coupée par process.exit entre « créer le job » et « poser le label ».
    const outcome = await Promise.race([Promise.allSettled([...this.inflight, this.chain]).then((): 'done' => 'done'), grace]);
    clearTimeout(graceTimer);
    if (outcome === 'timeout') {
      this.log.warn({ inflight: this.inflight.size }, 'arrêt : jobs encore en vol abandonnés, la réconciliation les reprendra');
    }

    this.stopCaffeinate?.();
    this.log.info('daemon arrêté');
    this.resolveStopped?.();
  }

  private async closeControl(): Promise<void> {
    const control = this.control;
    this.control = null;
    if (!control) return;
    try {
      await control.close();
    } catch (err) {
      this.log.warn({ err }, 'socket de contrôle : fermeture en erreur');
    }
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
      await resumeBlocked(this.d);
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
    if (this.purging > 0) return null;
    const check = canStartJob({
      activeCount: this.running.size,
      maxConcurrent: this.d.machine.maxConcurrentJobs,
      spentTodayUsd: this.d.phases.costSince(startOfLocalDay()),
      dailyBudgetUsd: effectiveDailyBudget(this.d.machine),
    });
    if (!check.ok) {
      if (check.reason === 'budget') {
        // Suivi dans inflight pour que runOnce() et stop() attendent les commentaires.
        const p: Promise<unknown> = this.announceBudgetPause(check.capUsd).finally(() => this.inflight.delete(p));
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

  private async announceBudgetPause(dailyBudgetUsd: number): Promise<void> {
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
      await this.d.source.comment(issueRefOf(job), renderBudgetPauseComment(dailyBudgetUsd)).catch(() => undefined);
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
    this.journal({ action: 'pause', source, outcome: 'ok' });
    return this.status();
  }

  /** Idempotent. Déclenche un tick immédiat (sans l'attendre) : les jobs en file ne patientent pas jusqu'au timer. */
  resume(source: ActionSource): DaemonStatus {
    this.paused = false;
    this.log.info({ source }, 'daemon repris');
    this.journal({ action: 'resume', source, outcome: 'ok' });
    void this.requestTick();
    return this.status();
  }

  /**
   * Relit `config.yml` et applique à chaud les seuls champs relus à chaque décision : le budget quotidien
   * et la concurrence maximale valent dès le prochain `startNext`, l'intervalle de poll reprogramme son
   * minuteur. Les champs structurels sont seulement nommés dans `needsRestart`. Une configuration devenue
   * invalide ne change rien : le daemon continue avec celle qu'il avait, et le refus porte l'erreur.
   */
  reload(source: ActionSource): Promise<CommandResult<ReloadResult>> {
    return this.command('reload', source, async () => {
      const path = this.opts.configPath ?? machineConfigPath();
      let next: MachineConfig;
      try {
        next = await loadMachineConfig(path);
      } catch (err) {
        return { ok: false, error: messageOf(err) };
      }
      // Rien n'est touché avant que la lecture ait abouti : la configuration précédente est conservée par
      // construction, pas par discipline.
      const current = this.d.machine;
      const { hot, restart: needsRestart } = diffMachineConfig(current, next);
      // Le rappel persistant suit ce que le daemon exécute, pas ce que le dernier `reload` a vu : un champ
      // ramené à sa valeur vivante en sort, un champ changé par un enregistrement antérieur y reste.
      for (const field of RESTART_REQUIRED_FIELDS) {
        if (needsRestart.includes(field)) this.pendingRestart.add(field);
        else this.pendingRestart.delete(field);
      }
      const applied: HotReloadField[] = [];
      for (const field of hot) {
        // Le budget ne voyage pas sans son backend : `effectiveDailyBudget` résout la **paire** (valeur brute,
        // backend), et `agentBackend` n'est pas rechargeable. Recopier le budget seul poserait le daemon sur un
        // plafond résolu à partir d'un backend que le fichier ne demande plus — ni celui d'avant, ni celui
        // d'après : un `{sdk, 40}` vivant face à un fichier `{cli, budget absent}` donnerait 60, que personne
        // n'a écrit. `agentBackend` est dans `needsRestart` : il porte les deux jusqu'au redémarrage.
        if (field === 'dailyBudgetUsd' && needsRestart.includes('agentBackend')) continue;
        COPY_HOT[field](current, next);
        applied.push(field);
      }
      if (applied.includes('pollIntervalSeconds')) this.reschedulePoll();
      this.log.info({ source, path, applied, needsRestart }, 'configuration relue');
      return { ok: true, result: { applied, needsRestart } };
    });
  }

  /**
   * Vide le cache de build à la demande (page de réglages). Sérialisée par la porte comme toute commande,
   * refusée tant qu'un job tourne ; le contrôle et la levée de `purging` sont faits d'un même tenant, avant
   * tout `await` : aucun job ne peut démarrer entre les deux, ni pendant la suppression. Un job lancé en cours
   * de route casserait son build sur un cache à moitié vidé. Les jobs en file attendent le tick suivant.
   */
  purgeBuildCache(source: ActionSource): Promise<CommandResult<PurgeResult>> {
    return this.command('purge', source, async () => {
      if (this.running.size > 0) return { ok: false, error: `purge refusée : ${this.running.size} job(s) en cours` };
      this.purging++;
      try {
        const result = await purgeCache(this.d.paths);
        this.log.info({ source, freedBytes: result.freedBytes }, 'cache de build vidé');
        return { ok: true, result };
      } finally {
        this.purging--;
      }
    });
  }

  /** Reprogramme le minuteur de poll sur l'intervalle de la configuration courante, si c'est bien lui qui le fixe. */
  private reschedulePoll(): void {
    // Intervalle imposé par les options : il prime sur le fichier, au rechargement comme au démarrage.
    if (this.opts.intervals?.pollMs !== undefined) return;
    // Aucun minuteur posé : `start()` n'a pas été appelé, et en créer un ici ferait tourner un daemon
    // que personne n'a démarré.
    if (this.pollTimer === null) return;
    this.schedulePoll(this.d.machine.pollIntervalSeconds * 1000);
  }

  /**
   * Pose le minuteur de poll, ou remplace le précédent à sa place dans `this.timers` : `stop()` annule les
   * minuteurs par cette liste, un minuteur laissé hors liste survivrait à l'arrêt du daemon.
   */
  private schedulePoll(pollMs: number): void {
    const at = this.pollTimer === null ? -1 : this.timers.indexOf(this.pollTimer);
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    const timer = setInterval(() => void this.tick(), pollMs);
    if (at === -1) this.timers.push(timer);
    else this.timers[at] = timer;
    this.pollTimer = timer;
  }

  status(): DaemonStatus {
    return {
      pid: process.pid,
      paused: this.paused,
      running: this.running.size,
      queued: this.d.store.countByState().queued,
      startedAt: this.startedAt,
      // Filtré depuis la liste de référence plutôt que rendu dans l'ordre d'insertion : la page affiche
      // toujours les champs dans le même ordre, quel que soit celui des enregistrements successifs.
      pendingRestart: RESTART_REQUIRED_FIELDS.filter((f) => this.pendingRestart.has(f)),
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
      try {
        await this.d.source.removeTriggerLabel(issueRefOf(job));
      } catch (err) {
        return { ok: false, error: `label impossible à retirer : ${messageOf(err)}` };
      }
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
      // La clé est reprise du job relancé, jamais redéduite : relancer un job d'avant la bascule ne doit pas
      // lui coller la clé Jira que son dépôt porte aujourd'hui.
      return this.createLabelled({ repo: job.repo, issueNumber: job.issueNumber, issueTitle: job.issueTitle, issueKey: job.issueKey }, ref);
    });
  }

  /**
   * Supprime définitivement un job terminé : sa ligne, ses phases et son répertoire `jobs/<id>`
   * (transcripts, diff, logs de vérification). Le ticket n'est jamais touché : on efface une trace locale,
   * pas un travail. Les lignes du journal des actions qui désignent ce job restent, celle-ci comprise.
   *
   * Id complet exigé, comme `cancelJob` et `retryJob` : aucune commande de la socket ne passe par la
   * résolution de préfixe de `findJob`, réservée à la CLI, et l'interface envoie l'id que le détail lui a donné.
   */
  deleteJob(jobId: string, source: ActionSource): Promise<CommandResult<Job>> {
    return this.command('delete', source, async (ref) => {
      ref.jobId = jobId;
      const job = this.d.store.get(jobId);
      if (!job) return { ok: false, error: `job inconnu : ${jobId}` };
      ref.repo = job.repo;
      ref.issueNumber = job.issueNumber;
      // Un job en cours a un agent qui écrit dans son répertoire et un worktree ouvert : les deux
      // resteraient orphelins. L'annulation, elle, sait arrêter tout cela proprement.
      if (!isTerminal(job.state)) return { ok: false, error: `job en cours (${job.state}) : l'annuler d'abord, puis le supprimer` };
      // Le pipeline passe le job terminal *avant* de clore le ticket, et cette clôture écrit encore dans le
      // répertoire (phase `jira`). Un job peut donc être terminal et toujours en vol : supprimer sous lui
      // ferait renaître le répertoire effacé.
      if (this.running.has(jobId)) return { ok: false, error: 'clôture du job encore en cours : réessayer dans un instant' };
      // Le disque avant la base : une base vidée sur un `rm` en échec laisserait un répertoire que plus
      // rien ne nomme, invisible et jamais nettoyé. Dans l'autre sens, la ligne survit à un répertoire déjà
      // parti — l'interface l'affiche sans ses fichiers, et refaire la suppression achève le travail.
      await rm(jobDir(this.d.paths, jobId), { recursive: true, force: true });
      this.d.store.delete(jobId);
      this.log.info({ jobId, source }, 'job supprimé');
      return { ok: true, result: job };
    });
  }

  /** Crée un job sur une issue au choix de l'opérateur local. Pas de `canTrigger` : il est de confiance. */
  enqueueIssue(input: EnqueueIssueInput, source: ActionSource): Promise<CommandResult<Job>> {
    return this.command('enqueue', source, async (ref) => {
      ref.repo = input.repo;
      ref.issueNumber = input.issueNumber;
      if (!this.d.machine.repos.includes(input.repo)) return { ok: false, error: `repo hors configuration : ${input.repo}` };
      // Refus le plus courant, vérifié avant l'aller-retour GitHub ; createLabelled revérifie pour retryJob.
      const active = this.d.store.findActiveByIssue(input.repo, input.issueNumber);
      if (active) return { ok: false, error: `un job est déjà actif sur ${input.repo}#${input.issueNumber} (${active.id}, ${active.state})` };
      let issue: Issue;
      try {
        issue = await this.d.source.getIssue({ repo: parseRepo(input.repo), number: input.issueNumber });
      } catch (err) {
        return { ok: false, error: `issue illisible : ${messageOf(err)}` };
      }
      if (issue.state === 'closed') return { ok: false, error: `issue fermée : ${input.repo}#${input.issueNumber}` };
      return this.createLabelled({ repo: input.repo, issueNumber: input.issueNumber, issueTitle: issue.title, issueKey: issue.tracker?.key ?? null }, ref);
    });
  }

  /**
   * Crée le job puis pose le label, dans cet ordre : `canTrigger` ignore nos propres poses de label et
   * retombe sur l'auteur de l'issue, donc un poll intercalé créerait un second job s'il n'en trouvait pas
   * déjà un actif — il doit le trouver et passer son chemin. Et comme `watchCancellations`
   * annule un job actif sans label, la séquence entière tient sous la porte de sérialisation.
   */
  private async createLabelled(input: { repo: string; issueNumber: number; issueTitle: string; issueKey: string | null }, ref: ActionRef): Promise<CommandResult<Job>> {
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
      this.journal({ action, source, ...ref, outcome: res.ok ? 'ok' : 'error', error: res.ok ? null : res.error });
      return res;
    });
  }

  /** Le journal ne transforme jamais une commande aboutie en rejet : un échec d'écriture est seulement loggé. */
  private journal(input: ActionInput): void {
    try {
      this.d.actions.record(input);
    } catch (err) {
      this.log.error({ err }, 'journal des actions : écriture impossible');
    }
  }

  /** Met à jour l'état des PR ouvertes de moins de 30 jours (KPI taux de merge). */
  async trackPullRequests(): Promise<void> {
    for (const job of this.d.store.listWithOpenPr(30)) {
      if (job.prNumber === null) continue;
      try {
        const st = await this.d.forge.getPullRequestState({ repo: parseRepo(job.repo), number: job.prNumber, url: job.prUrl ?? '' });
        this.d.store.update(job.id, { prState: st.state, prMergedAt: st.mergedAt });
      } catch (err) {
        this.log.warn({ err, jobId: job.id }, 'trackPullRequests : lecture impossible');
      }
    }
  }

  private async purge(): Promise<void> {
    // Pas de purge pendant qu'un job tourne : `keep` est un instantané (voir purgeOrphanWorktrees).
    if (this.running.size === 0) {
      this.purging++;
      try {
        await purgeOrphanWorktrees(this.d);
      } catch (err) {
        this.log.warn({ err }, 'purge des worktrees');
      } finally {
        this.purging--;
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
