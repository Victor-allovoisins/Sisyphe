/**
 * Comparaison champ à champ de deux configurations machine, rangée dans les deux familles du daemon. Une
 * seule définition pour `Daemon.reload` et pour l'enregistrement daemon arrêté de la page de réglages : deux
 * comparateurs finiraient par ne plus dire la même chose.
 */
import {
  HOT_RELOAD_FIELDS,
  RESTART_REQUIRED_FIELDS,
  type HotReloadField,
  type RestartRequiredField,
} from '../daemon/control-types.js';
import type { MachineConfig } from './machine.js';
import { expandHome } from './paths.js';

export type MachineConfigField = HotReloadField | RestartRequiredField;

export interface MachineConfigDiff {
  /** Champs rechargeables à chaud qui diffèrent, dans l'ordre de `HOT_RELOAD_FIELDS`. */
  hot: HotReloadField[];
  /** Champs structurels qui diffèrent, dans l'ordre de `RESTART_REQUIRED_FIELDS`. */
  restart: RestartRequiredField[];
}

type Same = (a: MachineConfig, b: MachineConfig) => boolean;

/**
 * Chemins comparés développés : la page manipule la forme écrite (`~/x`), le daemon la forme développée
 * (`/Users/v/x`), et ce n'est pas une modification. Sans effet sur deux formes déjà développées.
 */
const samePath = (a: string, b: string): boolean => expandHome(a) === expandHome(b);

/** Un comparateur par champ structurel : `Record`, donc un champ classé structurel sans comparateur ne compile pas. */
const SAME_RESTART: Record<RestartRequiredField, Same> = {
  'github.appId': (a, b) => a.github.appId === b.github.appId,
  'github.installationId': (a, b) => a.github.installationId === b.github.installationId,
  'github.privateKeyPath': (a, b) => samePath(a.github.privateKeyPath, b.github.privateKeyPath),
  // Égalité ordonnée : signaler à tort un simple réordonnancement coûte un bandeau de trop, rater un
  // changement laisserait un dépôt surveillé pour rien ou pas surveillé du tout.
  repos: (a, b) => a.repos.length === b.repos.length && a.repos.every((r, i) => r === b.repos[i]),
  triggerLabel: (a, b) => a.triggerLabel === b.triggerLabel,
  sandbox: (a, b) => a.sandbox === b.sandbox,
  agentBackend: (a, b) => a.agentBackend === b.agentBackend,
  // Champ absent et sous-champ absent se comparent pareil (`null`) : ajouter ou retirer une surcharge est un
  // changement, mais deux formes équivalentes de l'objet ne doivent pas réclamer un redémarrage pour rien.
  agentModels: (a, b) =>
    (a.agentModels?.triage ?? null) === (b.agentModels?.triage ?? null)
    && (a.agentModels?.implement ?? null) === (b.agentModels?.implement ?? null),
  dataDir: (a, b) => samePath(a.dataDir, b.dataDir),
};

/**
 * Un comparateur par champ à chaud, sur les valeurs **brutes** : pour `dailyBudgetUsd`, `null` (aucun plafond,
 * explicitement) et l'absence du champ se résolvent pareil sous `cli` sans dire la même chose.
 */
const SAME_HOT: Record<HotReloadField, Same> = {
  dailyBudgetUsd: (a, b) => a.dailyBudgetUsd === b.dailyBudgetUsd,
  maxConcurrentJobs: (a, b) => a.maxConcurrentJobs === b.maxConcurrentJobs,
  pollIntervalSeconds: (a, b) => a.pollIntervalSeconds === b.pollIntervalSeconds,
};

/** Ce qui change de `current` à `next`, famille par famille. Pur : ne lit rien, ne modifie rien. */
export function diffMachineConfig(current: MachineConfig, next: MachineConfig): MachineConfigDiff {
  return {
    hot: HOT_RELOAD_FIELDS.filter((f) => !SAME_HOT[f](current, next)),
    restart: RESTART_REQUIRED_FIELDS.filter((f) => !SAME_RESTART[f](current, next)),
  };
}
