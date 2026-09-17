# Vérification ciblée — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Le triage déclare quelles vérifications son changement mérite, Sisyphe ne lance que celles-là, et peut toujours élargir quand les faits contredisent la prévision — plus deux dettes de la bascule Jira.

**Architecture:** Une fonction pure `resolveVerifyScope` décide du périmètre à partir de ce que le triage a demandé, de ce que le dépôt déclare, et de quatre faits mesurés sur le diff. `runVerification` l'appelle après avoir calculé le diff, parce que trois des quatre faits n'existent qu'à ce moment-là. Le prompt d'implémentation et le corps de PR suivent le périmètre retenu.

**Tech Stack:** TypeScript strict ESM, vitest, zod, SQLite (better-sqlite3).

**Spec:** `docs/superpowers/specs/2026-09-17-sisyphe-verification-ciblee-design.md`

---

## Structure des fichiers

**Créés**

| Fichier | Responsabilité |
| --- | --- |
| `src/verify/scope.ts` | `resolveVerifyScope` : la décision de périmètre, pure et testable seule. |

**Modifiés**

| Fichier | Changement |
| --- | --- |
| `src/config/repo.ts` | Section `verify.alwaysRun`. |
| `src/agent/schemas.ts` | `verification` dans le verdict de triage. |
| `src/agent/prompts.ts` | Le triage explique ce champ ; l'implémentation ne nomme que les étapes retenues. |
| `src/verify/verify.ts` | `VerifyStep` gagne `out-of-scope` et `reason` ; `VerifyResult` gagne `scope`. |
| `src/jobs/pipeline.ts` | Passe le demandé, l'attempt et `files_likely_touched` à la vérification. |
| `src/deliver/pr-body.ts` | Rend la raison d'une étape non retenue, et l'élargissement. |
| `src/jobs/relaunch.ts`, `src/github/source.ts`, `src/jira/client.ts` | Nom affiché du compte au lieu de son identifiant. |
| `src/store/db.ts`, `src/store/types.ts`, `src/store/jobs.ts` | Colonne `issue_key`. |
| `src/daemon/poll.ts`, `src/daemon/daemon.ts` | L'écrivent à la création. |
| `src/ui/data.ts` | `issueUrlOf` suit le job, plus la configuration. |

---

## Task 1 : le dépôt peut se poser un plancher

**Files:** Modify `src/config/repo.ts`, `src/config/repo.test.ts`

- [ ] **Step 1 : écrire le test qui échoue**

```typescript
  it('verify.alwaysRun vaut [] par défaut et accepte les étapes connues', () => {
    const base = 'baseBranch: main\ncommands:\n  build: "true"\n';
    expect(parseRepoConfig(base).verify.alwaysRun).toEqual([]);
    expect(parseRepoConfig(`${base}verify:\n  alwaysRun: [build, lint]\n`).verify.alwaysRun).toEqual(['build', 'lint']);
    expect(() => parseRepoConfig(`${base}verify:\n  alwaysRun: [setup]\n`)).toThrow();
    expect(() => parseRepoConfig(`${base}verify:\n  alwaysRun: [nawak]\n`)).toThrow();
  });
```

`setup` est refusé parce qu'il n'est jamais sautable : l'inscrire dans un plancher laisserait croire qu'il pourrait ne pas l'être.

- [ ] **Step 2 : lancer le test et le voir échouer**

Run: `npx vitest run src/config/repo.test.ts`

- [ ] **Step 3 : implémenter**

Dans `src/config/repo.ts`, à côté des autres sections (reprendre la forme de `section(...)` et `.prefault({})` utilisée par `limits` et `timeouts`) :

```typescript
  /**
   * Ce que ce dépôt ne laisse jamais sauter, quoi que le triage demande. Vide par défaut : sur un projet
   * où `build` coûte autant que `test` (iOS, xcodebuild sur simulateur), un plancher à `build` annulerait
   * l'essentiel du gain. L'équipe qui veut cette garantie se la donne elle-même.
   */
  verify: section(
    z.strictObject({
      alwaysRun: z.array(z.enum(['build', 'test', 'lint'])).default([]),
    }).prefault({}),
  ),
```

- [ ] **Step 4 : lancer le test et le voir passer**

Run: `npx vitest run src/config/repo.test.ts`

- [ ] **Step 5 : commit**

```bash
git add src/config/repo.ts src/config/repo.test.ts
git commit -m "feat(config): un dépôt peut déclarer les vérifications qu'il ne saute jamais"
```

---

## Task 2 : le triage déclare le périmètre

**Files:** Modify `src/agent/schemas.ts`, `src/agent/prompts.ts`, `src/agent/schemas.test.ts`, `src/agent/prompts.test.ts`

- [ ] **Step 1 : écrire les tests qui échouent**

Dans `src/agent/schemas.test.ts` :

```typescript
  it('le verdict de triage porte le périmètre de vérification', () => {
    const v = TriageVerdictSchema.parse({ ...validVerdict, verification: { steps: ['build', 'lint'], why: 'changement de libellé' } });
    expect(v.verification.steps).toEqual(['build', 'lint']);
    // Un périmètre vide est une réponse, pas une omission : aucune vérification au-delà de setup.
    expect(TriageVerdictSchema.parse({ ...validVerdict, verification: { steps: [], why: 'aucun code exécutable modifié' } }).verification.steps).toEqual([]);
    expect(() => TriageVerdictSchema.parse({ ...validVerdict, verification: { steps: ['setup'], why: 'x' } })).toThrow();
  });
```

(Adapter `validVerdict` au fixture réellement présent dans le fichier.)

Dans `src/agent/prompts.test.ts` : le prompt de triage nomme les commandes que le dépôt déclare, et dit que `setup` n'est pas négociable.

- [ ] **Step 2 : lancer les tests et les voir échouer**

Run: `npx vitest run src/agent/schemas.test.ts src/agent/prompts.test.ts`

- [ ] **Step 3 : le schéma**

Dans `src/agent/schemas.ts`, ajouter à `TriageVerdictSchema` :

```typescript
  /**
   * Le périmètre est demandé **au triage**, pas dans le rapport d'implémentation : c'est le modèle qui
   * choisit ce qui va le contrôler, et au triage il n'a encore rien écrit — il lit un ticket, il ne
   * défend pas son code. Rempli même quand le verdict n'est pas `ready` : un schéma conditionnel se
   * remplit mal, et un verdict non `ready` n'atteint jamais la vérification.
   */
  verification: z.object({
    steps: z.array(z.enum(['build', 'test', 'lint'])).describe('Les vérifications que ce changement mérite. Tableau vide : aucune au-delà de setup.'),
    why: z.string().describe('En une phrase, pourquoi ce périmètre suffit. Lu par un relecteur humain dans la pull request, pas par une machine.'),
  }),
```

- [ ] **Step 4 : le prompt de triage**

Dans `triagePrompt`, après les critères, ajouter un paragraphe qui donne à l'agent de quoi choisir : la liste des commandes que le dépôt déclare (`commandBullets(config)` existe déjà), et la règle. Écris-le toi-même, en français, en disant au moins ceci :

- il choisit les vérifications que **ce** changement mérite, parmi celles que le dépôt déclare ;
- `setup` tourne toujours, il n'est pas à choisir ;
- ces commandes coûtent du temps réel (sur iOS, `build` comme `test` passent par un simulateur) : un changement de libellé n'a pas besoin de la suite entière ;
- en cas de doute, il demande tout — Sisyphe élargira de toute façon si le diff dément la prévision, mais un test manquant ne se rattrape pas ;
- `why` sera lu par un relecteur humain dans la pull request.

- [ ] **Step 5 : lancer les tests et les voir passer**

Run: `npx vitest run src/agent && npx tsc --noEmit`

Les fixtures de verdict des autres fichiers de test vont manquer le champ : ajoute-le-leur.

- [ ] **Step 6 : commit**

```bash
git add src/agent
git commit -m "feat(agent): le triage déclare le périmètre de vérification"
```

---

## Task 3 : `resolveVerifyScope`, la décision

**Files:** Create `src/verify/scope.ts`, `src/verify/scope.test.ts`

- [ ] **Step 1 : écrire les tests qui échouent**

`src/verify/scope.test.ts` :

```typescript
import { describe, expect, it } from 'vitest';
import { resolveVerifyScope } from './scope.js';

const base = {
  requested: { steps: ['build'] as const, why: 'changement de libellé' },
  configured: ['setup', 'build', 'test', 'lint'] as const,
  alwaysRun: [] as const,
  attempt: 1,
  largeDiff: false,
  protectedPathsTouched: [] as string[],
  filesLikelyTouched: ['App/Vue.swift'],
  changedFiles: ['App/Vue.swift'],
};

describe('resolveVerifyScope', () => {
  it('retient ce que le triage demande, croisé avec ce que le dépôt déclare', () => {
    const s = resolveVerifyScope({ ...base, configured: ['setup', 'build'] });
    expect(s.steps).toEqual(['setup', 'build']);
    expect(s.widened).toBe(false);
    expect(s.reason).toBe('changement de libellé');
  });

  it('setup est toujours retenu, même quand le triage ne demande rien', () => {
    expect(resolveVerifyScope({ ...base, requested: { steps: [], why: 'aucun code' } }).steps).toEqual(['setup']);
  });

  it('le plancher du dépôt s’ajoute à ce que le triage demande', () => {
    const s = resolveVerifyScope({ ...base, alwaysRun: ['lint'] });
    expect(s.steps).toEqual(['setup', 'build', 'lint']);
    expect(s.widened).toBe(false);
  });

  it('élargit sur un diff volumineux', () => {
    const s = resolveVerifyScope({ ...base, largeDiff: true });
    expect(s.steps).toEqual(['setup', 'build', 'test', 'lint']);
    expect(s.widened).toBe(true);
    expect(s.reason).toMatch(/volumineux/i);
  });

  it('élargit sur un chemin protégé touché', () => {
    expect(resolveVerifyScope({ ...base, protectedPathsTouched: ['App/Config.xcconfig'] })).toMatchObject({ widened: true });
  });

  it('élargit quand le diff sort de ce que le triage avait prévu', () => {
    const s = resolveVerifyScope({ ...base, changedFiles: ['App/Vue.swift', 'Core/Reseau.swift'] });
    expect(s.widened).toBe(true);
    expect(s.reason).toContain('Core/Reseau.swift');
  });

  it('élargit sur une reprise : le périmètre annoncé n’est plus crédible', () => {
    expect(resolveVerifyScope({ ...base, attempt: 2 })).toMatchObject({ widened: true });
  });

  it('n’élargit jamais au-delà de ce que le dépôt déclare', () => {
    const s = resolveVerifyScope({ ...base, configured: ['setup', 'build'], attempt: 2 });
    expect(s.steps).toEqual(['setup', 'build']);
  });
});
```

- [ ] **Step 2 : lancer les tests et les voir échouer**

Run: `npx vitest run src/verify/scope.test.ts`

- [ ] **Step 3 : implémenter**

`src/verify/scope.ts` :

```typescript
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
    : i.protectedPathsTouched.length ? `chemins protégés modifiés : ${i.protectedPathsTouched.join(', ')}`
    : surprises.length ? `le diff sort de ce que le triage avait prévu : ${surprises.join(', ')}`
    : null;

  if (widening) return { steps: [...i.configured], reason: widening, widened: true };
  return { steps: inRepo([...i.requested.steps, ...i.alwaysRun]), reason: i.requested.why, widened: false };
}
```

- [ ] **Step 4 : lancer les tests et les voir passer**

Run: `npx vitest run src/verify/scope.test.ts`

Le test « n'élargit jamais au-delà de ce que le dépôt déclare » est le garde-fou de cette fonction : un élargissement qui inventerait une commande absente ferait échouer la vérification sur un `undefined`.

- [ ] **Step 5 : commit**

```bash
git add src/verify/scope.ts src/verify/scope.test.ts
git commit -m "feat(verify): la décision de périmètre, pure et testable seule"
```

---

## Task 4 : `runVerification` suit le périmètre

**Files:** Modify `src/verify/verify.ts`, `src/verify/verify.test.ts`, `src/jobs/pipeline.ts`

- [ ] **Step 1 : écrire les tests qui échouent**

Dans `src/verify/verify.test.ts` (reprendre le harnais du fichier) :

```typescript
  it('ne lance que les étapes retenues et marque les autres hors périmètre', async () => {
    const r = await runVerification({ ...input, requested: { steps: ['build'], why: 'changement de libellé' }, attempt: 1, filesLikelyTouched: ['a.txt'] });
    expect(r.steps.filter((s) => s.status === 'ok').map((s) => s.name)).toEqual(['setup', 'build']);
    const horsPerimetre = r.steps.filter((s) => s.status === 'out-of-scope');
    expect(horsPerimetre.map((s) => s.name)).toEqual(['test', 'lint']);
    expect(horsPerimetre[0].reason).toBe('changement de libellé');
    expect(r.scope).toMatchObject({ widened: false });
  });

  it('élargit et le dit quand le diff sort de la prévision du triage', async () => {
    const r = await runVerification({ ...input, requested: { steps: ['build'], why: 'changement de libellé' }, attempt: 1, filesLikelyTouched: [] });
    expect(r.steps.every((s) => s.status !== 'out-of-scope')).toBe(true);
    expect(r.scope.widened).toBe(true);
  });
```

- [ ] **Step 2 : lancer les tests et les voir échouer**

Run: `npx vitest run src/verify/verify.test.ts`

- [ ] **Step 3 : implémenter**

Dans `src/verify/verify.ts` :

```typescript
export type VerifyStepStatus = 'ok' | 'failed' | 'timeout' | 'skipped' | 'out-of-scope';
```

`VerifyStep` gagne `reason?: string`, et `VerifyResult` gagne `scope: VerifyScope`.

`VerifyInput` gagne :

```typescript
  /** Le périmètre demandé par le verdict de triage, `setup` exclu. */
  requested: { steps: VerifyStepName[]; why: string };
  /** Numéro de tentative : au-delà de la première, le périmètre annoncé n'est plus crédible. */
  attempt: number;
  /** La prévision du triage, confrontée au diff réel. */
  filesLikelyTouched: string[];
```

Le calcul se place **après** `flags.protectedPathsTouched` / `flags.largeDiff` (ils en sont les entrées) et avant la boucle :

```typescript
  const scope = resolveVerifyScope({
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
```

Les étapes déclarées par le dépôt mais hors périmètre entrent dans `steps` avec `status: 'out-of-scope'`, `exitCode: 0`, `durationMs: 0` et `reason: scope.reason`. Elles n'ont pas de sortie : ne crée pas de fichier de log pour elles.

**Attention à `skipRest`** : il marque `skipped` avec `exitCode: 124` les étapes abandonnées faute de temps ou après un échec. Ne confonds pas les deux — une étape non retenue n'est pas une étape avortée, c'est exactement la distinction que le corps de PR doit rendre.

`scope` doit figurer dans **tous** les retours de `result(...)`, y compris les sorties anticipées (diff vide, secrets) : donne-lui une valeur par défaut dans le `result` de tête plutôt que de l'oublier sur un chemin.

- [ ] **Step 4 : câbler le pipeline**

Dans `src/jobs/pipeline.ts`, à l'appel de `runVerification`, passer `requested: verdict.verification`, `attempt`, `filesLikelyTouched: verdict.files_likely_touched`.

- [ ] **Step 5 : lancer les tests et les voir passer**

Run: `npx vitest run && npx tsc --noEmit`

- [ ] **Step 6 : commit**

```bash
git add src/verify src/jobs/pipeline.ts
git commit -m "feat(verify): ne lancer que les étapes retenues, et dire lesquelles ne l'ont pas été"
```

---

## Task 5 : l'agent ne relance que ce qui est retenu

**Files:** Modify `src/agent/prompts.ts`, `src/agent/prompts.test.ts`, `src/jobs/pipeline.ts`

Sans cela, le double passage subsiste précisément sur les étapes qu'on croyait avoir économisées : l'agent lancerait `test` avant de conclure alors que Sisyphe ne le lancera pas.

- [ ] **Step 1 : écrire le test qui échoue**

```typescript
  it('l’implémentation ne demande de relancer que les étapes retenues', () => {
    const p = implementPrompt(issue, { ...verdict, verification: { steps: ['build'], why: 'libellé' } }, config);
    expect(p).toContain('build');
    expect(p).not.toMatch(/exécute les commandes[^.]*test/);
  });
```

- [ ] **Step 2 : lancer le test et le voir échouer**

Run: `npx vitest run src/agent/prompts.test.ts`

- [ ] **Step 3 : implémenter**

`verifyStepsSentence(config)` devient `verifyStepsSentence(config, verdict.verification.steps)` : elle croise comme avant avec ce que le dépôt déclare, puis avec le périmètre. Quand le périmètre est vide, la phrase disparaît du prompt plutôt que de rester avec une liste vide — et l'exigence « corrige jusqu'au vert » avec elle.

Vérifie ce que devient la phrase voisine « Sisyphe relancera exactement ces commandes » : elle doit rester vraie.

- [ ] **Step 4 : lancer les tests et les voir passer**

Run: `npx vitest run && npx tsc --noEmit`

- [ ] **Step 5 : commit**

```bash
git add src/agent src/jobs/pipeline.ts
git commit -m "feat(agent): l'implémentation ne relance que les vérifications retenues"
```

---

## Task 6 : le corps de PR dit ce qui a été sauté, et pourquoi

**Files:** Modify `src/deliver/pr-body.ts`, `src/deliver/render.test.ts`

- [ ] **Step 1 : écrire les tests qui échouent**

```typescript
  it('distingue une étape hors périmètre d’une étape avortée', () => {
    const body = renderPrBody({ ...input, verify: { ...verify,
      scope: { steps: ['setup', 'build'], reason: 'changement de libellé', widened: false },
      steps: [
        { name: 'build', status: 'ok', exitCode: 0, durationMs: 1000, logFile: '' },
        { name: 'test', status: 'out-of-scope', exitCode: 0, durationMs: 0, logFile: '', reason: 'changement de libellé' },
        { name: 'lint', status: 'skipped', exitCode: 124, durationMs: 0, logFile: '' },
      ] } });
    expect(body).toContain('changement de libellé');
    expect(body).toMatch(/test.*hors périmètre/i);
    expect(body).toMatch(/lint.*non exécutée/i);
  });

  it('dit quand Sisyphe a élargi le périmètre malgré le triage', () => {
    const body = renderPrBody({ ...input, verify: { ...verify, scope: { steps: ['setup', 'build', 'test'], reason: 'reprise après échec : …', widened: true } } });
    expect(body).toContain('reprise après échec');
  });
```

- [ ] **Step 2 : lancer les tests et les voir échouer**

Run: `npx vitest run src/deliver/render.test.ts`

- [ ] **Step 3 : implémenter**

Ajouter l'entrée `'out-of-scope'` à `STEP_LABEL`, avec la raison portée par l'étape :

```typescript
  'out-of-scope': (s) => `⏭️ hors périmètre${s.reason ? ` : ${s.reason}` : ''}`,
```

et, quand `verify.scope.widened`, une ligne au-dessus du tableau des étapes qui dit que le périmètre a été élargi et pourquoi.

La raison vient du modèle de triage : passe-la par `sanitizeModelText` comme le reste du rapport (`sanitizeReport` est le modèle à suivre).

- [ ] **Step 4 : lancer les tests et les voir passer**

Run: `npx vitest run && npx tsc --noEmit`

- [ ] **Step 5 : commit**

```bash
git add src/deliver
git commit -m "feat(deliver): la pull request dit ce qui n'a pas été vérifié, et pourquoi"
```

---

## Task 7 : la consigne de relance nomme une personne, pas un identifiant

**Files:** Modify `src/github/source.ts`, `src/jira/client.ts`, `src/jobs/relaunch.ts`, `src/jobs/pipeline.ts`, leurs tests

Aujourd'hui le ticket porte « Pour relancer : … réassignez-le à `acc-sisyphe-ios` ». Un `accountId` Jira ne veut rien dire pour la personne qui a signalé le bug, et c'est elle qui lit.

- [ ] **Step 1 : écrire les tests qui échouent**

Dans `src/jobs/relaunch.test.ts` (le créer s'il n'existe pas) :

```typescript
  it('nomme le compte par son nom affiché', async () => {
    const r = await relaunchFor(machineWithJira, 'acme/ios', { accountName: async () => 'Sisyphe iOS' });
    expect(r).toEqual({ kind: 'assignee', who: 'Sisyphe iOS' });
  });

  it('sans nom résoluble, ne nomme personne plutôt qu’un identifiant', async () => {
    const r = await relaunchFor(machineWithJira, 'acme/ios', { accountName: async () => null });
    expect(r).toEqual({ kind: 'assignee', who: null });
    expect(relaunch(r, 'blocked')).not.toContain('acc-');
  });
```

Et dans `src/jira/client.test.ts` : `accountName` interroge `/rest/api/3/user`, mémorise son résultat (deux appels, une seule requête), et rend `null` plutôt que de lever quand l'appel échoue.

- [ ] **Step 2 : lancer les tests et les voir échouer**

Run: `npx vitest run src/jobs src/jira`

- [ ] **Step 3 : implémenter**

Dans `src/github/source.ts`, ajouter à `IssueTracker` :

```typescript
  /**
   * Nom affiché d'un compte, pour l'écrire dans un message lu par un humain. Optionnel : le suivi par
   * label n'en a pas besoin, ses consignes nomment un label et non une personne.
   */
  accountName?(accountId: string): Promise<string | null>;
```

Dans `src/jira/client.ts`, l'implémenter sur `GET /rest/api/3/user?accountId=…`, avec une `Map` d'instance en mémoire — un nom affiché ne change jamais en pratique, et l'échec de sa résolution ne doit pas empêcher de poster un message.

`Relaunch` devient `{ kind: 'assignee'; who: string | null }`, et `relaunch()` écrit « réassignez le ticket au compte Sisyphe » quand `who` est `null`.

`relaunchFor` devient `async` et prend le traqueur en troisième paramètre. Dans `pipeline.ts`, `const trigger = await relaunchFor(deps.machine, job.repo, deps.source);` — il est déjà dans une fonction async.

- [ ] **Step 4 : lancer les tests et les voir passer**

Run: `npx vitest run && npx tsc --noEmit`

- [ ] **Step 5 : commit**

```bash
git add src/github/source.ts src/jira src/jobs src/deliver
git commit -m "feat(jira): la consigne de relance nomme le compte, pas son identifiant"
```

---

## Task 8 : chaque job sait de quel traqueur il vient

**Files:** Modify `src/store/db.ts`, `src/store/types.ts`, `src/store/jobs.ts`, `src/store/store.test.ts`, `src/daemon/poll.ts`, `src/daemon/daemon.ts`, `src/ui/data.ts`, `src/ui/data.test.ts`

`issueUrlOf` déduit aujourd'hui le traqueur de la configuration **actuelle** du dépôt. Elle répond donc à « ce dépôt est-il sur Jira aujourd'hui ? » alors que la question est « ce job l'était-il ? ». Un job créé avant la bascule affiche un lien vers un ticket Jira qui n'existe pas.

- [ ] **Step 1 : écrire les tests qui échouent**

Dans `src/store/store.test.ts` : `create` accepte `issueKey`, le relit, et une base migrée depuis la version précédente rend `issueKey: null` sur ses lignes existantes.

Dans `src/ui/data.test.ts` :

```typescript
  it('issueUrl suit le traqueur du job, pas la configuration du dépôt', async () => {
    const ui = await makeUi({ jira: true });
    insertJob(ui.db, { id: 'avant', repo: 'acme/demo', issueNumber: 42, issueKey: null });
    insertJob(ui.db, { id: 'apres', repo: 'acme/demo', issueNumber: 7, issueKey: 'DEMO-7' });

    // Le dépôt est sur Jira aujourd'hui, mais ce job-là venait d'une issue GitHub.
    expect((await ui.data.jobDetail('avant'))?.issueUrl).toBe('https://github.com/acme/demo/issues/42');
    expect((await ui.data.jobDetail('apres'))?.issueUrl).toBe('https://acme.atlassian.net/browse/DEMO-7');
  });
```

- [ ] **Step 2 : lancer les tests et les voir échouer**

Run: `npx vitest run src/store src/ui`

- [ ] **Step 3 : la migration**

Dans `src/store/db.ts`, une nouvelle entrée de `MIGRATIONS` (append-only, ne jamais modifier les précédentes) : `ALTER TABLE jobs ADD COLUMN issue_key TEXT;`. Un `ALTER TABLE ADD COLUMN` nullable suffit ici — pas besoin de reconstruire la table, contrairement à la migration de `phases`, parce qu'aucune contrainte ne change.

`Job` gagne `issueKey: string | null`, `rowToJob` le lit, `create` l'écrit.

- [ ] **Step 4 : l'écrire à la création**

`JobStore.create` accepte `issueKey?: string | null`. Les deux appelants (`src/daemon/poll.ts` et `createLabelled` dans `src/daemon/daemon.ts`) ont l'`Issue` sous la main : passer `issue.tracker?.key ?? null`.

Vérifie qu'il n'existe pas d'autre appelant de `create` (`grep -rn 'store.create(' src`).

- [ ] **Step 5 : l'UI suit le job**

Dans `src/ui/data.ts`, `issueUrlOf` prend le job plutôt que la carte des projets :

```typescript
/**
 * Le lien d'un ticket suit le job, pas la configuration du dépôt : un job créé avant la bascule vers Jira
 * porte un numéro d'issue GitHub, et le dépôt qui est sur Jira aujourd'hui ne dit rien de ce qu'il était.
 */
export function issueUrlOf(job: Pick<Job, 'repo' | 'issueNumber' | 'issueKey'>, site: string | null): string {
  if (job.issueKey && site) return browseUrl(site, job.issueKey);
  return `https://github.com/${job.repo}/issues/${job.issueNumber}`;
}
```

La page fabrique ses liens côté client à partir de `ui.jira.keys[repo]` : elle doit maintenant lire `job.issueKey`, qui est déjà dans les lignes qu'elle reçoit. `JiraLinks.keys` n'a plus de consommateur si c'est le cas — vérifie, et retire-le si oui : la carte dépôt → clé de projet n'existait que pour la déduction qu'on supprime. `site` reste nécessaire.

`page.test.ts` construit ses cas depuis `issueLink(repo, number)` : adapte-les à la nouvelle signature, et garde la validation du site, qui reste la garantie de sécurité du lien.

- [ ] **Step 6 : lancer les tests et les voir passer**

Run: `npx vitest run && npx tsc --noEmit && npm run build`

- [ ] **Step 7 : commit**

```bash
git add src/store src/daemon src/ui
git commit -m "feat(store): chaque job porte la clé de son ticket, les liens la suivent"
```

---

## Task 9 : vérification d'ensemble

- [ ] **Step 1 : la suite complète**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: vert, aucune erreur.

- [ ] **Step 2 : lire le prompt de triage en entier**

```bash
node -e "import('./dist/agent/prompts.js').then(async (m) => { const c = (await import('./dist/config/repo.js')).parseRepoConfig(require('fs').readFileSync('examples/sisyphe.ios.yml','utf8')); console.log(m.triagePrompt({ repo: { owner:'a', name:'b', full:'a/b' }, number: 1, title: 'Couleur du bandeau', body: 'Le texte est jaune au lieu d orange', author: 'v', state: 'open', labels: [], comments: [] }, c)); })"
```

Relis-le comme si tu étais le modèle qui le reçoit : la consigne sur le périmètre est-elle claire, et le coût des commandes est-il dit assez fort pour qu'un changement de libellé ne demande pas la suite entière ?

- [ ] **Step 3 : lire un corps de PR avec une étape hors périmètre**

Vérifie de visu que « hors périmètre : *raison* » se distingue bien de « non exécutée (étape précédente en échec) ».

- [ ] **Step 4 : consigner**

Ajouter à la fin de la spec ce qui a été vérifié, et la date.

```bash
git add docs/superpowers/specs/2026-09-17-sisyphe-verification-ciblee-design.md
git commit -m "docs(spec): vérification d'ensemble de la vérification ciblée"
```

---

## Ce que ce plan ne fait pas

- La parallélisation des étapes de vérification.
- Un `testFast` déclaré par le dépôt.
- La reprise des jobs Jira créés entre la bascule et la migration de la Task 8 : ils garderont un lien GitHub mort.
- La vérification sur un vrai ticket, qui demande la machine portant la configuration Jira.
