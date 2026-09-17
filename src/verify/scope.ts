import type { VerifyStepName } from './verify.js';

/** Le périmètre réellement vérifié, et pourquoi. Rendu dans la pull request : un relecteur doit pouvoir contester. */
export interface VerifyScope {
  /** Les étapes retenues, dans l'ordre d'exécution, `setup` compris. */
  steps: VerifyStepName[];
  /** La phrase du triage, ou le fait qui a forcé l'élargissement. */
  reason: string;
  /** Sisyphe a repris la main sur ce que le triage demandait. */
  widened: boolean;
}

export interface VerifyScopeInput {
  /** Ce que le verdict de triage a demandé, `setup` exclu. */
  requested: { steps: readonly VerifyStepName[]; why: string };
  /** Les étapes que le dépôt déclare, dans l'ordre. Le périmètre n'en sort jamais. */
  configured: readonly VerifyStepName[];
  /** Le plancher du dépôt : jamais sauté, quoi que le triage demande. */
  alwaysRun: readonly VerifyStepName[];
  attempt: number;
  largeDiff: boolean;
  protectedPathsTouched: readonly string[];
  /** La prévision du triage. */
  filesLikelyTouched: readonly string[];
  /** Ce que le diff a réellement touché. */
  changedFiles: readonly string[];
}

/** La raison part dans le corps de la pull request : un diff de trois cents fichiers n'y tient pas, et dix suffisent à comprendre. */
const cite = (files: readonly string[]) =>
  files.length > 10 ? `${files.slice(0, 10).join(', ')} et ${files.length - 10} autres` : files.join(', ');

/**
 * Le triage peut restreindre à partir d'une lecture ; les faits peuvent toujours élargir. Jamais l'inverse.
 *
 * Les trois premiers faits se mesurent sur le diff, donc après l'implémentation : c'est pourquoi cette
 * décision se prend dans `runVerification` et non au triage. Le quatrième, la reprise, dit qu'une
 * vérification a déjà échoué — le périmètre annoncé avant d'écrire le code n'est alors plus crédible.
 */
export function resolveVerifyScope(i: VerifyScopeInput): VerifyScope {
  const inRepo = (steps: readonly VerifyStepName[]) => i.configured.filter((s) => s === 'setup' || steps.includes(s));

  const surprises = i.changedFiles.filter((f) => !i.filesLikelyTouched.includes(f));
  const widening =
    i.attempt > 1 ? 'reprise après échec : le périmètre annoncé au triage n’est plus crédible'
    : i.largeDiff ? 'diff volumineux : au-delà de ce qu’un périmètre restreint peut couvrir'
    : i.protectedPathsTouched.length ? `chemins protégés modifiés : ${cite(i.protectedPathsTouched)}`
    : surprises.length ? `le diff sort de ce que le triage avait prévu : ${cite(surprises)}`
    : null;

  if (widening) return { steps: [...i.configured], reason: widening, widened: true };
  return { steps: inRepo([...i.requested.steps, ...i.alwaysRun]), reason: i.requested.why, widened: false };
}
