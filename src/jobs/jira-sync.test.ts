import { describe, expect, it } from 'vitest';
import { JIRA_SKILL } from '../agent/plugin-path.js';
import { jiraSyncPrompt } from '../agent/prompts.js';
import type { AgentResult, AgentRunOptions, AgentRunner } from '../agent/runner.js';
import type { JiraSyncReport } from '../agent/schemas.js';
import { emptyFlags, zeroUsage, type Job, type JobFlags } from '../store/types.js';
import { jiraOutcomeOf, runJiraPhase, type JiraSyncDeps } from './jira-sync.js';

function makeJob(over: Partial<Job> = {}): Job {
  return {
    id: 'job-1', repo: 'acme/ios', issueNumber: 42, issueTitle: 'Le bouton ne répond plus',
    state: 'done', attempt: 2, requeues: 0, branch: 'sisyphe/42', baseSha: 'abc', worktreePath: '/wt',
    verdict: null, report: null, flags: emptyFlags(),
    prNumber: 412, prUrl: 'https://github.com/acme/ios/pull/412', prState: 'open', prMergedAt: null,
    costUsd: 3.5, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, durationMs: 125_000,
    error: null, createdAt: 'now', startedAt: 'now', finishedAt: null, updatedAt: 'now',
    ...over,
  };
}

function flags(over: Partial<JobFlags>): JobFlags {
  return { ...emptyFlags(), ...over };
}

const report: JiraSyncReport = { status: 'En relecture', comment: '🪨 C’est prêt.', note: '' };

function agentResult(over: Partial<AgentResult<JiraSyncReport>> = {}): AgentResult<JiraSyncReport> {
  return {
    output: report, sessionId: 'sess', costUsd: 0.12, usage: zeroUsage(), numTurns: 4,
    durationMs: 900, stopReason: 'completed', transcriptPath: '/t.jsonl', ...over,
  };
}

/** Un runner qui enregistre les options reçues et rend (ou lève) ce que le test lui donne. */
function stubAgent(behaviour: () => Promise<AgentResult<JiraSyncReport>>): { agent: AgentRunner; calls: AgentRunOptions[] } {
  const calls: AgentRunOptions[] = [];
  const agent: AgentRunner = {
    run: async <T>(opts: AgentRunOptions) => {
      calls.push(opts);
      return (await behaviour()) as unknown as AgentResult<T>;
    },
  };
  return { agent, calls };
}

function deps(agent: AgentRunner): JiraSyncDeps {
  return {
    agent, env: { PATH: '/bin' }, transcriptPath: '/jobs/job-1/transcript-jira-1.jsonl', cwd: '/jobs/job-1',
    timeoutMs: 300_000, signal: new AbortController().signal,
  };
}

describe('jiraOutcomeOf', () => {
  it('décrit un job livré', () => {
    const o = jiraOutcomeOf(makeJob(), 'done', 'En relecture', 'IOS-886');
    expect(o).toEqual({
      key: 'IOS-886', state: 'done', verificationFailed: false,
      prUrl: 'https://github.com/acme/ios/pull/412', attempts: 2, costUsd: 3.5,
      duration: '2 min 5 s', targetHint: 'En relecture', reason: null, flags: [], draft: '',
    });
  });

  it('décrit un job bloqué sans PR, avec sa raison', () => {
    const job = makeJob({ state: 'blocked', prNumber: null, prUrl: null, prState: null, error: 'triage : too_big' });
    const o = jiraOutcomeOf(job, 'blocked', 'En relecture', 'IOS-887');
    expect(o.prUrl).toBeNull();
    expect(o.state).toBe('blocked');
    expect(o.reason).toBe('triage : too_big');
    expect(o.flags).toEqual([]);
  });

  it('remonte chaque drapeau du job', () => {
    expect(jiraOutcomeOf(makeJob({ flags: flags({ secretsFound: ['aws-key'] }) }), 'failed', 'X').flags).toEqual(['secrets détectés dans le diff']);
    expect(jiraOutcomeOf(makeJob({ flags: flags({ protectedPathsTouched: ['.github/**'] }) }), 'failed', 'X').flags).toEqual(['chemins protégés modifiés']);
    expect(jiraOutcomeOf(makeJob({ flags: flags({ largeDiff: true }) }), 'done', 'X').flags).toEqual(['diff volumineux']);
    expect(jiraOutcomeOf(makeJob({ flags: flags({ earlyStop: 'max_turns' }) }), 'done', 'X').flags).toEqual(['agent arrêté avant la fin (max_turns)']);
    const all = jiraOutcomeOf(makeJob({ flags: flags({ secretsFound: ['k'], protectedPathsTouched: ['p'], largeDiff: true, earlyStop: 'timeout', verificationFailed: true }) }), 'failed', 'X');
    expect(all.flags).toHaveLength(4);
    expect(all.verificationFailed).toBe(true);
  });

  it('la clé est optionnelle et vaut la chaîne vide par défaut', () => {
    expect(jiraOutcomeOf(makeJob(), 'done', 'En relecture').key).toBe('');
  });

  it('porte le brouillon jusqu’au prompt : c’est là que vivent les questions du triage', () => {
    const draft = '🪨 Sisyphe met cette issue en pause.\n\nPour avancer :\n- Quel écran ?';
    const o = jiraOutcomeOf(makeJob({ state: 'blocked', error: 'triage : needs_clarification' }), 'blocked', 'En relecture', 'IOS-887', draft);
    expect(o.draft).toBe(draft);
    expect(jiraSyncPrompt(o)).toContain('Quel écran ?');
  });
});

describe('runJiraPhase', () => {
  const outcome = jiraOutcomeOf(makeJob(), 'done', 'En relecture', 'IOS-886');

  it("rend le rapport de l'agent et le résultat brut quand il aboutit", async () => {
    const { agent } = stubAgent(async () => agentResult());
    const out = await runJiraPhase(deps(agent), makeJob(), outcome);
    expect(out.report).toEqual(report);
    expect(out.result.costUsd).toBe(0.12);
    expect(out.result.stopReason).toBe('completed');
  });

  it('demande un seul outil, le garde-fou Bash et le skill jira', async () => {
    const { agent, calls } = stubAgent(async () => agentResult());
    await runJiraPhase(deps(agent), makeJob(), outcome);
    expect(calls).toHaveLength(1);
    const o = calls[0];
    expect(o.allowedTools).toEqual(['Bash']);
    expect(o.disallowedTools).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
    expect(o.bashGuard).toBe(true);
    expect(o.skills).toEqual([JIRA_SKILL]);
    expect(o.pathGuard).toBeUndefined();
    expect(o.cwd).toBe('/jobs/job-1');
    expect(o.transcriptPath).toBe('/jobs/job-1/transcript-jira-1.jsonl');
    expect(o.maxTurns).toBe(20);
    expect(o.maxBudgetUsd).toBe(1);
    expect(o.prompt).toContain('IOS-886');
    expect(o.outputSchema).toBeDefined();
  });

  it('rend le rapport de secours quand la sortie est absente ou non conforme', async () => {
    const empty = { status: '', comment: '', note: 'aucun rapport produit' };
    const { agent: a1 } = stubAgent(async () => agentResult({ output: null, stopReason: 'max_turns' }));
    const r1 = await runJiraPhase(deps(a1), makeJob(), outcome);
    expect(r1.report).toEqual(empty);
    expect(r1.result.stopReason).toBe('max_turns');

    const { agent: a2 } = stubAgent(async () => agentResult({ output: { status: 'X' } as unknown as JiraSyncReport }));
    expect((await runJiraPhase(deps(a2), makeJob(), outcome)).report).toEqual(empty);
  });

  it("ne lève pas quand agent.run lève : le job garde sa clôture, dégradée", async () => {
    const { agent } = stubAgent(async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, open '/jobs/job-1/system-append-x.md'"), { code: 'ENOENT' });
    });
    const out = await runJiraPhase(deps(agent), makeJob(), outcome);
    expect(out.report.note).toBe('aucun rapport produit');
    expect(out.report.comment).toBe('');
    expect(out.result.stopReason).toBe('error');
    expect(out.result.errorMessage).toContain('ENOENT');
    expect(out.result.costUsd).toBe(0);
    expect(out.result.transcriptPath).toBe('/jobs/job-1/transcript-jira-1.jsonl');
  });

  it('un abort pendant le run est rapporté comme tel, pas comme une erreur', async () => {
    const controller = new AbortController();
    const { agent } = stubAgent(async () => {
      controller.abort();
      throw new Error('AbortError');
    });
    const out = await runJiraPhase({ ...deps(agent), signal: controller.signal }, makeJob(), outcome);
    expect(out.result.stopReason).toBe('aborted');
    expect(out.report.note).toBe('aucun rapport produit');
  });

  it('le rapport de secours est une copie : le mutiler ne contamine pas le suivant', async () => {
    const { agent } = stubAgent(async () => agentResult({ output: null }));
    const first = await runJiraPhase(deps(agent), makeJob(), outcome);
    first.report.comment = 'écrit par le pipeline';
    expect((await runJiraPhase(deps(agent), makeJob(), outcome)).report.comment).toBe('');
  });
});
