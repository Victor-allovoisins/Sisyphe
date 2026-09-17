import { join } from 'node:path';
import type { RepoConfig } from '../config/repo.js';
import type { Git } from '../git/git.js';
import type { JobFlags } from '../store/types.js';
import { tail } from '../util/text.js';
import { minutes } from '../util/time.js';
import { runRepoCommand } from './commands.js';
import { isLargeDiff, matchProtectedPaths } from './flags.js';
import { resolveVerifyScope, type VerifyScope } from './scope.js';
import { scanPatch, type ScanOptions, type SecretFinding } from './secrets.js';

export type ScanFn = (patchFile: string, reportFile: string, opts: ScanOptions) => Promise<SecretFinding[]>;
export type VerifyStepName = 'setup' | 'build' | 'test' | 'lint';
export type VerifyStepStatus = 'ok' | 'failed' | 'timeout' | 'skipped' | 'out-of-scope';

/** Les seuls drapeaux que la vérification possède ; `verificationFailed` et `earlyStop` appartiennent au pipeline. */
export type VerifyFlags = Pick<JobFlags, 'protectedPathsTouched' | 'largeDiff' | 'secretsFound'>;

export interface VerifyStep {
  name: VerifyStepName;
  status: VerifyStepStatus;
  exitCode: number;
  durationMs: number;
  logFile: string;
  /** Pourquoi cette étape n'a pas été lancée. Renseigné pour `out-of-scope`, où le statut seul n'explique rien. */
  reason?: string;
}

export interface VerifyResult {
  ok: boolean;
  noChanges: boolean;
  /** Arbre git exact qui a été vérifié : la livraison commite cet objet, pas l'état ultérieur du worktree. */
  treeSha: string | null;
  steps: VerifyStep[];
  failedStep: VerifyStepName | 'secrets' | null;
  failureTail: string;
  files: string[];
  changedLines: number;
  flags: VerifyFlags;
  /** Ce qui a été vérifié et pourquoi ce périmètre-là. */
  scope: VerifyScope;
  /** Fichiers suivis modifiés par les étapes de vérification elles-mêmes (lockfiles, projet régénéré). Ils ne font pas partie du commit livré. Calculé seulement quand la vérification passe. */
  driftedFiles: string[];
}

export interface VerifyInput {
  worktreePath: string;
  baseSha: string;
  config: RepoConfig;
  /** Doit exister : les logs et le patch y sont écrits. */
  jobDir: string;
  env: Record<string, string>;
  git: Git;
  signal?: AbortSignal;
  scan?: ScanFn;
  /** Le périmètre demandé par le verdict de triage, `setup` exclu. */
  requested: { steps: VerifyStepName[]; why: string };
  /** Numéro de tentative : au-delà de la première, le périmètre annoncé n'est plus crédible. */
  attempt: number;
  /** La prévision du triage, confrontée au diff réel. */
  filesLikelyTouched: string[];
}

const ORDER: VerifyStepName[] = ['setup', 'build', 'test', 'lint'];

/** Vérification faite par Sisyphe, indépendamment de ce que l'agent affirme. Tout tient dans `timeouts.verifyMinutes`, scan compris. */
export async function runVerification(i: VerifyInput): Promise<VerifyResult> {
  const flags: VerifyFlags = { protectedPathsTouched: [], largeDiff: false, secretsFound: [] };
  // Le périmètre se décide sur le diff : les sorties qui précèdent le diff (aucun changement, secret
  // trouvé) n'ont rien retenu du tout, et le triage n'y est pour rien.
  let scope: VerifyScope = { steps: [], reason: 'périmètre non calculé : la vérification s’est arrêtée avant les étapes', widened: false };
  let outOfScope: VerifyStep[] = [];
  // Les étapes écartées passent par ici, quel que soit le chemin de sortie : une étape qu'on n'a pas
  // lancée se dit aussi quand la vérification échoue.
  const result = (over: Partial<VerifyResult>): VerifyResult => ({
    ok: false, noChanges: false, treeSha: null, failedStep: null, failureTail: '', files: [], changedLines: 0, flags, scope, driftedFiles: [], ...over,
    steps: [...(over.steps ?? []), ...outOfScope].sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name)),
  });
  const deadline = Date.now() + minutes(i.config.timeouts.verifyMinutes);
  const remaining = () => deadline - Date.now();

  await i.git.stage(i.worktreePath, i.baseSha);
  const stat = await i.git.diffStat(i.worktreePath, i.baseSha);
  if (stat.files.length === 0) return result({ noChanges: true });
  const treeSha = await i.git.writeTree(i.worktreePath);
  const patchFile = join(i.jobDir, 'diff.patch');
  await i.git.writePatch(i.worktreePath, i.baseSha, patchFile);
  flags.protectedPathsTouched = matchProtectedPaths(stat.files, i.config.protectedPaths);
  flags.largeDiff = isLargeDiff(stat.changedLines, i.config.limits.maxDiffLines);
  const common = { treeSha, files: stat.files, changedLines: stat.changedLines };

  const findings = await (i.scan ?? scanPatch)(patchFile, join(i.jobDir, 'gitleaks.json'), { signal: i.signal, timeoutMs: Math.max(1000, remaining()) });
  if (findings.length > 0) {
    flags.secretsFound = [...new Set(findings.map((f) => `${f.file} (${f.ruleId})`))];
    return result({ ...common, failedStep: 'secrets' });
  }

  scope = resolveVerifyScope({
    requested: i.requested,
    configured: ORDER.filter((name) => i.config.commands[name]),
    alwaysRun: i.config.verify.alwaysRun,
    attempt: i.attempt,
    largeDiff: flags.largeDiff,
    protectedPathsTouched: flags.protectedPathsTouched,
    filesLikelyTouched: i.filesLikelyTouched,
    changedFiles: stat.files,
  });
  const configured = scope.steps;
  // Déclarées par le dépôt, écartées par le périmètre : aucune commande, donc aucun log à ouvrir.
  outOfScope = ORDER.filter((name) => i.config.commands[name] && !configured.includes(name))
    .map((name) => ({ name, status: 'out-of-scope', exitCode: 0, durationMs: 0, logFile: '', reason: scope.reason }));
  const steps: VerifyStep[] = [];
  const skipRest = (from: number) => {
    for (const name of configured.slice(from)) steps.push({ name, status: 'skipped', exitCode: 124, durationMs: 0, logFile: join(i.jobDir, `verify-${name}.log`) });
  };
  for (let k = 0; k < configured.length; k++) {
    const name = configured[k];
    const logFile = join(i.jobDir, `verify-${name}.log`);
    const left = remaining();
    if (left <= 0) {
      skipRest(k);
      return result({ ...common, steps, failedStep: name, failureTail: `Budget de vérification (${i.config.timeouts.verifyMinutes} min) épuisé avant l'étape ${name}.` });
    }
    const r = await runRepoCommand(i.config.commands[name]!, { cwd: i.worktreePath, env: i.env, timeoutMs: left, logFile, signal: i.signal });
    if (r.cancelled) i.signal?.throwIfAborted();
    const status: VerifyStepStatus = r.exitCode === 0 ? 'ok' : r.timedOut ? 'timeout' : 'failed';
    steps.push({ name, status, exitCode: r.exitCode, durationMs: r.durationMs, logFile });
    if (status !== 'ok') {
      skipRest(k + 1);
      const head = r.timedOut
        ? `Étape ${name} interrompue : délai de vérification dépassé.`
        : r.output.trim() === ''
          ? `Étape ${name} terminée avec le code ${r.exitCode} sans aucune sortie.`
          : '';
      return result({ ...common, steps, failedStep: name, failureTail: [head, tail(r.output, 200)].filter(Boolean).join('\n') });
    }
  }
  // Dérive informative, jamais bloquante : fichiers suivis que setup/build/test ont modifiés. Ils ne sont pas dans l'arbre livré.
  let driftedFiles: string[] = [];
  if (remaining() > 0) {
    try {
      driftedFiles = await i.git.modifiedTrackedSince(i.worktreePath, treeSha);
    } catch {
      /* la dérive n'est qu'une information */
    }
  }
  return result({ ...common, ok: true, steps, driftedFiles });
}
