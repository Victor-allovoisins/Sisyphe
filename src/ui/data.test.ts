import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { parseMachineConfig } from '../config/machine.js';
import { dataPaths, jobDir } from '../config/paths.js';
import { openDatabase } from '../store/db.js';
import { JobStore } from '../store/jobs.js';
import { PhaseStore } from '../store/phases.js';
import { emptyFlags, type JobState } from '../store/types.js';
import { AmbiguousJobPrefixError } from '../cli/resolve-job.js';
import { createUiData, UiInputError, type LaunchdProbe } from './data.js';

/** Pid hors de l'espace des pid macOS (max 99998) : `process.kill(pid, 0)` échoue toujours en ESRCH. */
const DEAD_PID = 999_999;

interface SeedJob {
  id: string;
  repo?: string;
  issueNumber?: number;
  issueTitle?: string;
  state?: JobState;
  createdAt?: string;
  costUsd?: number;
  prUrl?: string | null;
}

/** Numéro d'issue distinct par défaut : `jobs_active_issue` interdit deux jobs actifs sur la même issue. */
let nextIssueNumber = 1;

function insertJob(db: DatabaseSync, j: SeedJob): void {
  const createdAt = j.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO jobs (id, repo, issue_number, issue_title, state, flags_json, cost_usd, pr_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    j.id,
    j.repo ?? 'acme/demo',
    j.issueNumber ?? nextIssueNumber++,
    j.issueTitle ?? 'Un titre',
    j.state ?? 'queued',
    JSON.stringify(emptyFlags()),
    j.costUsd ?? 0,
    j.prUrl ?? null,
    createdAt,
    createdAt,
  );
}

function insertPhase(db: DatabaseSync, p: { jobId: string; name?: string; attempt?: number; costUsd?: number; startedAt?: string; finishedAt?: string | null }): void {
  db.prepare(
    `INSERT INTO phases (job_id, name, attempt, cost_usd, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(p.jobId, p.name ?? 'implement', p.attempt ?? 1, p.costUsd ?? 0, p.startedAt ?? new Date().toISOString(), p.finishedAt ?? null);
}

const okLaunchd: LaunchdProbe = async () => ({ loaded: true, lastExitCode: 0, detail: 'state = running' });

async function makeUi(opts: { launchd?: LaunchdProbe; now?: () => Date; dailyBudgetUsd?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sisyphe-ui-'));
  const paths = dataPaths(root);
  const db = openDatabase(':memory:');
  const store = new JobStore(db);
  const phases = new PhaseStore(db);
  const machine = parseMachineConfig(
    `github:\n  appId: 1\n  installationId: 1\n  privateKeyPath: /dev/null\nrepos:\n  - acme/demo\n  - acme/other\ndataDir: ${root}\ndailyBudgetUsd: ${opts.dailyBudgetUsd ?? 20}\n`,
  );
  const data = createUiData({ store, phases, paths, machine, launchd: opts.launchd ?? okLaunchd, now: opts.now });
  return { root, paths, db, store, phases, machine, data };
}

describe('overview', () => {
  it("daemon.running est faux sans fichier de verrou, vrai avec le pid courant, faux avec un pid mort", async () => {
    const ui = await makeUi();

    expect((await ui.data.overview()).daemon).toEqual({ running: false, pid: null });

    await writeFile(join(ui.paths.root, 'daemon.lock'), String(process.pid));
    expect(await ui.data.overview().then((o) => o.daemon)).toEqual({ running: true, pid: process.pid });

    await writeFile(join(ui.paths.root, 'daemon.lock'), String(DEAD_PID));
    expect(await ui.data.overview().then((o) => o.daemon)).toEqual({ running: false, pid: DEAD_PID });
  });

  it('budget.spentTodayUsd somme les phases terminées aujourd’hui et ignore celles d’hier', async () => {
    const ui = await makeUi({ dailyBudgetUsd: 10 });
    insertJob(ui.db, { id: 'a1' });
    const yesterday = new Date(Date.now() - 30 * 3_600_000).toISOString();
    insertPhase(ui.db, { jobId: 'a1', costUsd: 1.5, finishedAt: new Date().toISOString() });
    insertPhase(ui.db, { jobId: 'a1', costUsd: 2.5, finishedAt: new Date().toISOString() });
    insertPhase(ui.db, { jobId: 'a1', costUsd: 99, startedAt: yesterday, finishedAt: yesterday });
    insertPhase(ui.db, { jobId: 'a1', costUsd: 42, finishedAt: null }); // en cours : ne compte pas

    const o = await ui.data.overview();

    expect(o.budget.spentTodayUsd).toBeCloseTo(4);
    expect(o.budget.dailyBudgetUsd).toBe(10);
    expect(o.budget.ratio).toBeCloseTo(0.4);
  });

  it('counts compte les jobs par état, backend et repos viennent de la config machine', async () => {
    const ui = await makeUi();
    insertJob(ui.db, { id: 'q1', state: 'queued' });
    insertJob(ui.db, { id: 'i1', state: 'implementing' });
    insertJob(ui.db, { id: 'd1', state: 'done' });
    insertJob(ui.db, { id: 'd2', state: 'done' });
    insertJob(ui.db, { id: 'b1', state: 'blocked' });
    insertJob(ui.db, { id: 'f1', state: 'failed' });
    insertJob(ui.db, { id: 'c1', state: 'cancelled' });

    const o = await ui.data.overview();

    expect(o.counts).toEqual({ active: 2, queued: 1, done: 2, blocked: 1, failed: 1, cancelled: 1 });
    expect(o.backend).toBe('sdk');
    expect(o.repos).toEqual(['acme/demo', 'acme/other']);
  });

  it('active porte la dernière phase ouverte, le temps écoulé et les 30 dernières lignes du transcript', async () => {
    const now = new Date('2026-09-09T12:00:00.000Z');
    const ui = await makeUi({ now: () => now });
    insertJob(ui.db, { id: 'act1', state: 'implementing', createdAt: '2026-09-09T11:59:00.000Z' });
    insertJob(ui.db, { id: 'done1', state: 'done' });
    insertPhase(ui.db, { jobId: 'act1', name: 'triage', attempt: 1, finishedAt: '2026-09-09T11:59:30.000Z' });
    insertPhase(ui.db, { jobId: 'act1', name: 'implement', attempt: 2, startedAt: '2026-09-09T11:59:40.000Z', finishedAt: null });
    const dir = jobDir(ui.paths, 'act1');
    await mkdir(dir, { recursive: true });
    const lines = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `étape ${i}` }] } }),
    );
    await writeFile(join(dir, 'transcript-implement-2.jsonl'), lines.join('\n'));

    const o = await ui.data.overview();

    expect(o.active.map((j) => j.id)).toEqual(['act1']);
    expect(o.active[0].phase).toEqual({ name: 'implement', attempt: 2, startedAt: '2026-09-09T11:59:40.000Z' });
    expect(o.active[0].elapsedMs).toBe(60_000);
    expect(o.active[0].feed).toHaveLength(30);
    expect(o.active[0].feed.at(-1)).toContain('étape 39');
    expect(o.active[0].feed[0]).toContain('étape 10');
  });

  it('un job actif sans dossier ni phase donne un fil vide plutôt qu’une erreur', async () => {
    const ui = await makeUi();
    insertJob(ui.db, { id: 'nodir', state: 'triaging' });

    const o = await ui.data.overview();

    expect(o.active[0].feed).toEqual([]);
    expect(o.active[0].phase).toBeNull();
  });

  it('launchd est injectable : la sonde par défaut n’est jamais appelée en test', async () => {
    const ui = await makeUi({ launchd: async () => ({ loaded: false, lastExitCode: null, detail: 'agent launchd non chargé' }) });

    expect((await ui.data.overview()).launchd).toEqual({ loaded: false, lastExitCode: null, detail: 'agent launchd non chargé' });
  });
});

describe('listJobs', () => {
  it('filtre par état et par repo, trie du plus récent au plus ancien', async () => {
    const ui = await makeUi();
    insertJob(ui.db, { id: 'j1', state: 'done', repo: 'acme/demo', createdAt: '2026-09-01T10:00:00.000Z' });
    insertJob(ui.db, { id: 'j2', state: 'done', repo: 'acme/other', createdAt: '2026-09-02T10:00:00.000Z' });
    insertJob(ui.db, { id: 'j3', state: 'failed', repo: 'acme/demo', createdAt: '2026-09-03T10:00:00.000Z' });

    expect(ui.data.listJobs({}).map((j) => j.id)).toEqual(['j3', 'j2', 'j1']);
    expect(ui.data.listJobs({ state: 'done' }).map((j) => j.id)).toEqual(['j2', 'j1']);
    expect(ui.data.listJobs({ repo: 'acme/demo' }).map((j) => j.id)).toEqual(['j3', 'j1']);
    expect(ui.data.listJobs({ state: 'done', repo: 'acme/demo' }).map((j) => j.id)).toEqual(['j1']);
  });

  it('plafonne la limite à 500 et refuse une limite absurde', async () => {
    const ui = await makeUi();
    for (let i = 0; i < 5; i++) insertJob(ui.db, { id: `k${i}`, createdAt: `2026-09-0${i + 1}T10:00:00.000Z` });

    expect(ui.data.listJobs({ limit: 2 })).toHaveLength(2);
    expect(ui.data.listJobs({ limit: 10_000 })).toHaveLength(5);
    expect(() => ui.data.listJobs({ limit: 0 })).toThrow(UiInputError);
    expect(() => ui.data.listJobs({ state: 'nawak' as JobState })).toThrow(UiInputError);
  });
});

describe('jobDetail', () => {
  async function seedDetail() {
    const ui = await makeUi();
    insertJob(ui.db, { id: 'abcdef01', repo: 'acme/demo', issueNumber: 42, state: 'blocked' });
    insertPhase(ui.db, { jobId: 'abcdef01', name: 'triage', attempt: 1, finishedAt: new Date().toISOString() });
    const dir = jobDir(ui.paths, 'abcdef01');
    await mkdir(dir, { recursive: true });
    return { ui, dir };
  }

  it('rassemble phases, fichiers, transcript plafonné, sorties de vérification, diff et secrets', async () => {
    const { ui, dir } = await seedDetail();
    const transcript = Array.from({ length: 500 }, (_, i) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `ligne ${i}` }] } }),
    );
    await writeFile(join(dir, 'transcript-triage-1.jsonl'), transcript.join('\n'));
    await writeFile(join(dir, 'setup.log'), Array.from({ length: 100 }, (_, i) => `setup ${i}`).join('\n'));
    await writeFile(join(dir, 'verify-build.log'), 'build ok');
    const patch = 'diff --git a/x b/x\n+++ b/x\n--- a/x\n+un\n+deux\n-trois\n contexte\n';
    await writeFile(join(dir, 'diff.patch'), patch);
    await writeFile(
      join(dir, 'gitleaks.json'),
      JSON.stringify([{ File: 'Config.swift', RuleID: 'generic-api-key', StartLine: 5, Match: 'sk-live-SUPERSECRET', Secret: 'sk-live-SUPERSECRET' }]),
    );

    const detail = await ui.data.jobDetail('abcdef01');
    if (!detail) throw new Error('détail attendu');

    expect(detail.job.id).toBe('abcdef01');
    expect(detail.issueUrl).toBe('https://github.com/acme/demo/issues/42');
    expect(detail.phases.map((p) => p.name)).toEqual(['triage']);
    expect(detail.files).toContain('diff.patch');
    expect(detail.transcript?.phase).toBe('triage');
    expect(detail.transcript?.attempt).toBe(1);
    expect(detail.transcript?.lines).toHaveLength(400);
    expect(detail.transcript?.lines.at(-1)).toContain('ligne 499');
    const setup = detail.verify.find((v) => v.name === 'setup.log');
    expect(setup?.tail.at(-1)).toBe('setup 99');
    expect(setup?.tail.join('\n')).not.toContain('setup 50');
    expect(detail.verify.map((v) => v.name)).toEqual(['setup.log', 'verify-build.log']);
    expect(detail.diff).toEqual({ additions: 2, deletions: 1, bytes: Buffer.byteLength(patch) });
    expect(detail.secrets).toEqual([{ file: 'Config.swift', ruleId: 'generic-api-key', line: 5 }]);
    expect(JSON.stringify(detail)).not.toContain('SUPERSECRET');
  });

  it('choisit le transcript le plus récent, y compris au-delà de la tentative 9', async () => {
    const { ui, dir } = await seedDetail();
    await writeFile(join(dir, 'transcript-implement-9.jsonl'), JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 1, num_turns: 3 }));
    await writeFile(join(dir, 'transcript-implement-10.jsonl'), JSON.stringify({ type: 'result', subtype: 'error', total_cost_usd: 2, num_turns: 4 }));

    const detail = await ui.data.jobDetail('abcdef01');

    expect(detail?.transcript?.attempt).toBe(10);
    expect(detail?.transcript?.lines[0]).toContain('result error');
  });

  it('un dossier de job absent donne des listes vides, pas une erreur', async () => {
    const ui = await makeUi();
    insertJob(ui.db, { id: 'sansdossier' });

    const detail = await ui.data.jobDetail('sansdossier');

    expect(detail?.files).toEqual([]);
    expect(detail?.verify).toEqual([]);
    expect(detail?.transcript).toBeNull();
    expect(detail?.diff).toBeNull();
    expect(detail?.secrets).toEqual([]);
  });

  it('accepte un préfixe non ambigu, renvoie null sur un id inconnu et lève sur un préfixe ambigu', async () => {
    const ui = await makeUi();
    insertJob(ui.db, { id: 'aaa111' });
    insertJob(ui.db, { id: 'aaa222' });
    insertJob(ui.db, { id: 'bbb333' });

    expect((await ui.data.jobDetail('bbb'))?.job.id).toBe('bbb333');
    expect(await ui.data.jobDetail('zzz')).toBeNull();
    await expect(ui.data.jobDetail('aaa')).rejects.toBeInstanceOf(AmbiguousJobPrefixError);
  });
});

describe('report', () => {
  it('renvoie les stats et le détail par jour local', async () => {
    const now = new Date('2026-09-09T12:00:00.000Z');
    const ui = await makeUi({ now: () => now });
    const day = (d: string, h = '10') => new Date(`${d}T${h}:00:00.000Z`).toISOString();
    insertJob(ui.db, { id: 'r1', state: 'done', costUsd: 1, createdAt: day('2026-09-08') });
    insertJob(ui.db, { id: 'r2', state: 'failed', costUsd: 2, createdAt: day('2026-09-09') });
    insertJob(ui.db, { id: 'r3', state: 'blocked', costUsd: 3, createdAt: day('2026-09-09', '11') });

    const r = ui.data.report('7d');

    expect(r.total).toBe(3);
    expect(r.totalCostUsd).toBeCloseTo(6);
    const last = r.perDay.at(-1);
    expect(last?.jobs).toBe(2);
    expect(last?.costUsd).toBeCloseTo(5);
    expect(last?.failed).toBe(1);
    expect(last?.blocked).toBe(1);
    expect(r.perDay.filter((d) => d.jobs > 0)).toHaveLength(2);
    expect(r.perDay.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day))).toBe(true);
  });

  it('accepte une date ISO et refuse une période invalide', async () => {
    const ui = await makeUi();

    expect(() => ui.data.report('2026-09-01T00:00:00.000Z')).not.toThrow();
    expect(() => ui.data.report('demain')).toThrow(UiInputError);
  });
});
