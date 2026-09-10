import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { summarizeTranscript } from '../cli/format.js';
import type { ServiceStatus } from '../service/index.js';
import { AmbiguousJobPrefixError, findJob } from '../cli/resolve-job.js';
import type { AgentBackend, MachineConfig } from '../config/machine.js';
import { jobDir, type DataPaths } from '../config/paths.js';
import { readLock } from '../daemon/lock.js';
import { startOfLocalDay } from '../jobs/scheduler.js';
import { buildReport, parseSince, type ReportStats } from '../report/report.js';
import type { JobStore } from '../store/jobs.js';
import type { PhaseStore } from '../store/phases.js';
import { JOB_STATES, isTerminal, type Job, type JobState, type Phase, type PhaseName } from '../store/types.js';
import { tail } from '../util/text.js';
import { parseGitleaksReport } from '../verify/secrets.js';

/** Fil d'actions d'un job actif : assez pour suivre, jamais tout le transcript. */
const FEED_LINES = 30;
/** Résumé de transcript dans le détail d'un job. */
const TRANSCRIPT_LINES = 400;
/** Sorties de vérification (`setup.log`, `verify-*.log`). */
const VERIFY_TAIL_LINES = 40;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/** Au-delà, `perDay` ne renvoie que les jours réellement peuplés : inutile de fabriquer des milliers de zéros. */
const MAX_FILLED_DAYS = 400;
/** Lignes de transcript retenues pour un fil : largement de quoi produire 30 lignes résumées. */
const FEED_SOURCE_LINES = 400;
/** Le fil ne lit que la fin du transcript : un transcript en cours grossit sans borne et le snapshot tombe toutes les 2 s. */
const FEED_TAIL_BYTES = 256 * 1024;
/** L'état du service change rarement ; le snapshot SSE, lui, tombe toutes les 2 s : sans ce cache, un `launchctl print` par tic. */
const SERVICE_TTL_MS = 5_000;
const TRANSCRIPT_RE = /^transcript-([a-z]+)-(\d+)\.jsonl$/;
const VERIFY_RE = /^(setup\.log|verify-.+\.log)$/;

/** Paramètre de requête invalide : l'UI répond 400, pas 500. */
export class UiInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UiInputError';
  }
}

/** Le sous-ensemble du ServiceManager dont l'UI a besoin : un test passe un faux, jamais launchd ni systemd. */
export interface UiService {
  status(): Promise<ServiceStatus>;
}

export interface UiDataDeps {
  store: JobStore;
  phases: PhaseStore;
  paths: DataPaths;
  machine: MachineConfig;
  /** Gestionnaire de service de la plateforme ; son `status()` est mémorisé quelques secondes. */
  service: UiService;
  now?: () => Date;
}

export interface Counts {
  /** Jobs non terminaux, `queued` compris (c'est aussi la taille du tableau `active`). */
  active: number;
  queued: number;
  done: number;
  blocked: number;
  failed: number;
  cancelled: number;
}

export interface ActivePhase {
  name: PhaseName;
  attempt: number;
  startedAt: string;
}

export interface ActiveJob extends Job {
  /** Dernière phase encore ouverte, null pour un job en file ou entre deux phases. */
  phase: ActivePhase | null;
  elapsedMs: number;
  feed: string[];
}

export interface Overview {
  now: string;
  daemon: { running: boolean; pid: number | null };
  service: ServiceStatus;
  budget: { spentTodayUsd: number; dailyBudgetUsd: number; ratio: number };
  backend: AgentBackend;
  repos: string[];
  counts: Counts;
  active: ActiveJob[];
}

export interface TranscriptView {
  phase: string;
  attempt: number;
  lines: string[];
}

export interface VerifyLog {
  name: string;
  tail: string[];
}

export interface DiffStat {
  additions: number;
  deletions: number;
  bytes: number;
}

/** Un finding gitleaks réduit à ce qui est affichable : jamais `Match` ni `Secret`. */
export interface SecretRow {
  file: string;
  ruleId: string;
  line: number;
}

export interface JobDetail {
  job: Job;
  phases: Phase[];
  issueUrl: string;
  files: string[];
  transcript: TranscriptView | null;
  verify: VerifyLog[];
  diff: DiffStat | null;
  secrets: SecretRow[];
}

export interface DayStat {
  day: string;
  jobs: number;
  costUsd: number;
  done: number;
  failed: number;
  blocked: number;
}

export type UiReport = ReportStats & { perDay: DayStat[] };

export interface ListJobsQuery {
  state?: JobState;
  repo?: string;
  limit?: number;
}

export interface UiData {
  overview(): Promise<Overview>;
  listJobs(q: ListJobsQuery): Job[];
  jobDetail(idOrPrefix: string): Promise<JobDetail | null>;
  report(since?: string): UiReport;
}

function localDay(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `12h`, `7d`, `2w` ou une date ISO. Toute autre saisie est une erreur d'entrée, pas une panne. */
export function resolveSince(text: string, now: Date): string {
  const t = text.trim();
  if (/^\d+[hdw]$/.test(t)) {
    try {
      return parseSince(t, now);
    } catch (err) {
      throw new UiInputError((err as Error).message);
    }
  }
  // `new Date('7')` rend juillet 2001 : sans cette forme imposée, une durée mal tapée passerait pour une date.
  const d = /^\d{4}-\d{2}-\d{2}/.test(t) ? new Date(t) : new Date(Number.NaN);
  if (Number.isNaN(d.getTime())) throw new UiInputError(`Période invalide : ${text} (attendu 24h, 7d, 2w ou une date ISO)`);
  return d.toISOString();
}

function diffStat(text: string): DiffStat {
  let additions = 0;
  let deletions = 0;
  for (const line of text.split('\n')) {
    // L'espace compte : une ligne de contenu `---` ou `++i;` n'est pas un en-tête de patch.
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) additions++;
    else if (line.startsWith('-')) deletions++;
  }
  return { additions, deletions, bytes: Buffer.byteLength(text) };
}

const readTextOrNull = (path: string) => readFile(path, 'utf8').catch(() => null);

/**
 * Derniers octets d'un fichier, sans charger le reste. La première ligne du bloc lu est presque
 * toujours tronquée (et peut couper un caractère multi-octets) : elle est écartée.
 */
async function readTailOrNull(path: string, maxBytes: number): Promise<string | null> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    if (size <= length) return text;
    const firstBreak = text.indexOf('\n');
    return firstBreak === -1 ? '' : text.slice(firstBreak + 1);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
const listDir = (dir: string) => readdir(dir).catch(() => [] as string[]);

/** Transcript le plus récent du dossier : mtime d'abord, tentative ensuite (`-10` est plus récent que `-9`). */
async function newestTranscript(dir: string, files: string[]): Promise<{ file: string; phase: string; attempt: number } | null> {
  const candidates = files
    .map((file) => ({ file, m: TRANSCRIPT_RE.exec(file) }))
    .filter((c): c is { file: string; m: RegExpExecArray } => c.m !== null)
    .map((c) => ({ file: c.file, phase: c.m[1], attempt: Number(c.m[2]) }));
  if (candidates.length === 0) return null;
  const withTime = await Promise.all(
    candidates.map(async (c) => ({ ...c, mtimeMs: await stat(join(dir, c.file)).then((s) => s.mtimeMs, () => 0) })),
  );
  withTime.sort((a, b) => a.mtimeMs - b.mtimeMs || a.attempt - b.attempt || a.file.localeCompare(b.file));
  return withTime[withTime.length - 1];
}

export function createUiData(deps: UiDataDeps): UiData {
  const { store, phases, paths, machine } = deps;
  const now = deps.now ?? (() => new Date());
  // La promesse est mémorisée, pas seulement sa valeur : deux snapshots simultanés partagent la même
  // sonde au lieu de lancer deux `launchctl print`. Un échec n'est pas mis en cache — le suivant réessaie.
  let cachedService: { at: number; status: Promise<ServiceStatus> } | null = null;

  async function serviceStatus(): Promise<ServiceStatus> {
    const at = now().getTime();
    if (!cachedService || at - cachedService.at > SERVICE_TTL_MS) cachedService = { at, status: deps.service.status() };
    const pending = cachedService;
    try {
      return await pending.status;
    } catch (err) {
      if (cachedService === pending) cachedService = null;
      throw err;
    }
  }

  async function feedFor(jobId: string): Promise<string[]> {
    const dir = jobDir(paths, jobId);
    const newest = await newestTranscript(dir, await listDir(dir));
    if (!newest) return [];
    const text = await readTailOrNull(join(dir, newest.file), FEED_TAIL_BYTES);
    if (text === null) return [];
    return summarizeTranscript(text.split('\n').slice(-FEED_SOURCE_LINES)).slice(-FEED_LINES);
  }

  async function overview(): Promise<Overview> {
    const at = now();
    const lock = await readLock(paths);
    const byState = store.countByState();
    const activeJobs = store.listActive();
    const spentTodayUsd = phases.costSince(startOfLocalDay(at));
    const active: ActiveJob[] = await Promise.all(
      activeJobs.map(async (job) => {
        const open = phases.listForJob(job.id).filter((p) => p.finishedAt === null);
        const last = open[open.length - 1];
        return {
          ...job,
          phase: last ? { name: last.name, attempt: last.attempt, startedAt: last.startedAt } : null,
          elapsedMs: Math.max(0, at.getTime() - new Date(job.startedAt ?? job.createdAt).getTime()),
          feed: await feedFor(job.id),
        };
      }),
    );
    return {
      now: at.toISOString(),
      daemon: { running: lock?.alive ?? false, pid: lock?.pid ?? null },
      service: await serviceStatus(),
      budget: {
        spentTodayUsd,
        dailyBudgetUsd: machine.dailyBudgetUsd,
        ratio: machine.dailyBudgetUsd > 0 ? spentTodayUsd / machine.dailyBudgetUsd : 0,
      },
      backend: machine.agentBackend,
      repos: machine.repos,
      counts: {
        active: activeJobs.length,
        queued: byState.queued,
        done: byState.done,
        blocked: byState.blocked,
        failed: byState.failed,
        cancelled: byState.cancelled,
      },
      active,
    };
  }

  function listJobs(q: ListJobsQuery): Job[] {
    if (q.state !== undefined && !(JOB_STATES as readonly string[]).includes(q.state)) {
      throw new UiInputError(`État inconnu : ${q.state} (attendu ${JOB_STATES.join(', ')})`);
    }
    const limit = q.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) throw new UiInputError(`Limite invalide : ${q.limit}`);
    return store.listFiltered({ state: q.state, repo: q.repo, limit: Math.min(limit, MAX_LIMIT) });
  }

  async function jobDetail(idOrPrefix: string): Promise<JobDetail | null> {
    const job = findJob(store, idOrPrefix);
    if (!job) return null;
    const dir = jobDir(paths, job.id);
    const files = (await listDir(dir)).sort();

    const newest = await newestTranscript(dir, files);
    let transcript: TranscriptView | null = null;
    if (newest) {
      const text = await readTextOrNull(join(dir, newest.file));
      if (text !== null) {
        transcript = { phase: newest.phase, attempt: newest.attempt, lines: summarizeTranscript(text.split('\n')).slice(-TRANSCRIPT_LINES) };
      }
    }

    const verify: VerifyLog[] = [];
    for (const name of files.filter((f) => VERIFY_RE.test(f))) {
      const text = await readTextOrNull(join(dir, name));
      if (text !== null) verify.push({ name, tail: tail(text, VERIFY_TAIL_LINES).split('\n') });
    }

    const patch = files.includes('diff.patch') ? await readTextOrNull(join(dir, 'diff.patch')) : null;
    const leaks = files.includes('gitleaks.json') ? await readTextOrNull(join(dir, 'gitleaks.json')) : null;
    let secrets: SecretRow[] = [];
    if (leaks !== null) {
      try {
        // Seuls fichier · règle · ligne sortent d'ici : le rapport brut contient le secret trouvé.
        secrets = parseGitleaksReport(leaks).map((f) => ({ file: f.file, ruleId: f.ruleId, line: f.line }));
      } catch {
        secrets = [];
      }
    }

    return {
      job,
      phases: phases.listForJob(job.id),
      issueUrl: `https://github.com/${job.repo}/issues/${job.issueNumber}`,
      files,
      transcript,
      verify,
      diff: patch === null ? null : diffStat(patch),
      secrets,
    };
  }

  function report(since = '30d'): UiReport {
    const at = now();
    const sinceIso = resolveSince(since, at);
    const jobs = store.listSince(sinceIso);
    const perDay = new Map<string, DayStat>();
    // Remplissage jour par jour avec `setDate` et comparaison sur la clé locale : un changement
    // d'heure d'été fausserait un comptage par division de millisecondes.
    const cursor = new Date(Math.min(new Date(sinceIso).getTime(), at.getTime()));
    cursor.setHours(0, 0, 0, 0);
    const lastKey = localDay(at.toISOString());
    for (let i = 0; i < MAX_FILLED_DAYS; i++) {
      const key = localDay(cursor.toISOString());
      perDay.set(key, { day: key, jobs: 0, costUsd: 0, done: 0, failed: 0, blocked: 0 });
      if (key >= lastKey) break;
      cursor.setDate(cursor.getDate() + 1);
      // Période plus longue que le plafond : on abandonne le remplissage, seuls les jours peuplés sortiront.
      if (i === MAX_FILLED_DAYS - 1) perDay.clear();
    }
    for (const j of jobs) {
      const key = localDay(j.createdAt);
      const row = perDay.get(key) ?? { day: key, jobs: 0, costUsd: 0, done: 0, failed: 0, blocked: 0 };
      row.jobs++;
      row.costUsd += j.costUsd;
      if (j.state === 'done') row.done++;
      if (j.state === 'failed') row.failed++;
      if (j.state === 'blocked') row.blocked++;
      perDay.set(key, row);
    }
    return { ...buildReport(jobs, sinceIso), perDay: [...perDay.values()].sort((a, b) => a.day.localeCompare(b.day)) };
  }

  return { overview, listJobs, jobDetail, report };
}

export { AmbiguousJobPrefixError, isTerminal };
