import { join } from 'node:path';
import type { RepoConfig } from '../config/repo.js';
import type { Git } from '../git/git.js';
import { emptyFlags, type JobFlags } from '../store/types.js';
import { tail } from '../util/text.js';
import { minutes } from '../util/time.js';
import { runRepoCommand } from './commands.js';
import { isLargeDiff, matchProtectedPaths } from './flags.js';
import { scanPatch, type SecretFinding } from './secrets.js';

export type ScanFn = (patchFile: string, reportFile: string) => Promise<SecretFinding[]>;
export type VerifyStepName = 'setup' | 'build' | 'test' | 'lint';

export interface VerifyStep {
  name: VerifyStepName;
  exitCode: number;
  durationMs: number;
  logFile: string;
}

export interface VerifyResult {
  ok: boolean;
  noChanges: boolean;
  steps: VerifyStep[];
  failedStep: VerifyStepName | 'secrets' | null;
  failureTail: string;
  files: string[];
  changedLines: number;
  flags: JobFlags;
}

export interface VerifyInput {
  worktreePath: string;
  baseSha: string;
  config: RepoConfig;
  jobDir: string;
  env: Record<string, string>;
  git: Git;
  signal?: AbortSignal;
  scan?: ScanFn;
}

/** Vérification faite par Sisyphe, indépendamment de ce que l'agent affirme. */
export async function runVerification(i: VerifyInput): Promise<VerifyResult> {
  const flags = emptyFlags();
  const empty: VerifyResult = { ok: false, noChanges: false, steps: [], failedStep: null, failureTail: '', files: [], changedLines: 0, flags };

  if (!(await i.git.hasChanges(i.worktreePath, i.baseSha))) return { ...empty, noChanges: true };

  const stat = await i.git.diffStat(i.worktreePath, i.baseSha);
  const patchFile = join(i.jobDir, 'diff.patch');
  await i.git.writePatch(i.worktreePath, i.baseSha, patchFile);
  flags.protectedPathsTouched = matchProtectedPaths(stat.files, i.config.protectedPaths);
  flags.largeDiff = isLargeDiff(stat.changedLines, i.config.limits.maxDiffLines);
  const withStat = { ...empty, files: stat.files, changedLines: stat.changedLines };

  const findings = await (i.scan ?? scanPatch)(patchFile, join(i.jobDir, 'gitleaks.json'));
  if (findings.length > 0) {
    flags.secretsFound = [...new Set(findings.map((f) => `${f.file} (${f.ruleId})`))];
    return { ...withStat, failedStep: 'secrets' };
  }

  const deadline = Date.now() + minutes(i.config.timeouts.verifyMinutes);
  const steps: VerifyStep[] = [];
  const order: Array<[VerifyStepName, string | undefined]> = [
    ['setup', i.config.commands.setup],
    ['build', i.config.commands.build],
    ['test', i.config.commands.test],
    ['lint', i.config.commands.lint],
  ];
  for (const [name, command] of order) {
    if (!command) continue;
    const logFile = join(i.jobDir, `verify-${name}.log`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      steps.push({ name, exitCode: 124, durationMs: 0, logFile });
      return { ...withStat, steps, failedStep: name, failureTail: `Temps de vérification épuisé avant l'étape ${name}` };
    }
    const r = await runRepoCommand(command, { cwd: i.worktreePath, env: i.env, timeoutMs: remaining, logFile, signal: i.signal });
    steps.push({ name, exitCode: r.exitCode, durationMs: r.durationMs, logFile });
    if (r.cancelled) i.signal?.throwIfAborted();
    if (r.exitCode !== 0) {
      return { ...withStat, steps, failedStep: name, failureTail: tail(r.output, 200) + (r.timedOut ? '\n[timeout]' : '') };
    }
  }
  return { ...withStat, ok: true, steps };
}
