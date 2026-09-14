# Sisyphe Agent Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** choisir l'outil qui exécute l'agent (`sdk`, `claude-code`, `codex`, `opencode`) depuis `config.yml` et l'onglet Réglages, chaque backend faisant triage, implémentation et retry.

**Architecture:** un adaptateur par CLI derrière l'interface `AgentRunner` existante, plus un socle commun de sous-processus extrait de l'actuel `cli-runner`. La sortie structurée reste validée par le pipeline (zod) ; `agentBackend` normalise l'alias `cli` vers `claude-code` ; `protectedPathsTouched` devient bloquant pour compenser l'absence de hook Codex. Spec : `docs/superpowers/specs/2026-09-14-sisyphe-agent-backends-design.md`.

**Tech Stack:** Node 24+, TypeScript strict ESM, zod, yaml, vitest, execa, fakes shell (`test/fakes/`). Aucune dépendance ajoutée.

Le plan décrit des contrats et des tests, pas du code verbatim : l'implémenteur écrit le code en TDD. Chaque tâche finit par `npm test`, `npm run typecheck` et un commit. Se faire sur une branche dédiée `feat/agent-backends`.

---

## Structure des fichiers

- `src/config/machine.ts` (+ test) — enum des backends, alias `cli`, `agentModels`, `phaseModel`, message sandbox.
- `src/daemon/control-types.ts` — `agentModels` classé restart-required.
- `src/config/diff.ts` (+ test) — comparateur `agentModels`.
- `src/config/write.ts` (+ test) — sandbox réservé à `sdk`.
- `src/agent/runner.ts` — `model` optionnel, `phase` ajouté.
- `src/agent/cli/process.ts` (nouveau) — socle sous-processus.
- `src/agent/cli/claude-code-runner.ts` (déplacé depuis `src/agent/cli-runner.ts`) (+ test déplacé).
- `src/agent/cli/codex-runner.ts` (nouveau + test).
- `src/agent/cli/opencode-runner.ts` (nouveau + test).
- `src/agent/index.ts` (nouveau) — `createAgentRunner`.
- `src/app.ts` — utilise la factory.
- `src/jobs/pipeline.ts` — `phaseModel`, `phase`, blocage chemins protégés.
- `src/verify/commands.ts` (+ test) — `agentEnv` par backend.
- `src/service/index.ts` (+ test) — types élargis.
- `src/cli/format.ts` (+ test) — résumé des transcripts codex/opencode.
- `src/cli/commands/setup.ts`, `src/cli/commands/doctor.ts` (+ tests).
- `src/ui/page.ts` (+ test) — select 4 backends, champs `agentModels`.
- `src/deliver/comments.ts` — `renderProtectedPathsComment` (+ correction du texte « conservé 7 jours »).
- `test/fakes/fake-codex.sh`, `test/fakes/fake-opencode.sh` (nouveaux).
- `README.md`, `docs/playground.md`.

---

### Task 1 : backend enum, alias et `agentModels`

**Files:**
- Modify: `src/config/machine.ts` (+ `src/config/machine.test.ts`), `src/daemon/control-types.ts`, `src/config/diff.ts` (+ test), `src/config/write.ts` (+ test), `src/app.ts`, `test/helpers/harness.ts`

- [ ] **Step 1 : enum et alias.** Dans `machine.ts`, remplacer l'enum par
  `agentBackend: z.enum(['sdk', 'claude-code', 'codex', 'opencode', 'cli']).transform((v) => (v === 'cli' ? 'claude-code' : v)).default('sdk')`.
  Exporter `AGENT_BACKENDS = ['sdk', 'claude-code', 'codex', 'opencode'] as const` et `type AgentBackend` depuis cette liste. Tests : `cli` se relit `claude-code`, les quatre valeurs passent, `bedrock` est refusé, le défaut reste `sdk`.
- [ ] **Step 2 : `agentModels`.** Ajouter `agentModels: z.strictObject({ triage: z.string().min(1).max(100).optional(), implement: z.string().min(1).max(100).optional() }).optional()`. Tests : absent accepté, `{ triage: 'gpt-5-codex' }` accepté, clé inconnue refusée, chaîne vide refusée.
- [ ] **Step 3 : `phaseModel`.** Exporter `phaseModel(machine: Pick<MachineConfig, 'agentBackend' | 'agentModels'>, phase: 'triage' | 'implement', repoModel: string): string | undefined` : `repoModel` pour `sdk`/`claude-code`, `machine.agentModels?.[phase]` pour les autres. Tests : les quatre cas.
- [ ] **Step 4 : sandbox.** Renommer `SANDBOX_CLI_ERROR` en `SANDBOX_BACKEND_ERROR`, message « `sandbox: true` n'est supporté que par le backend `sdk` : mettre `sandbox: false` ou `agentBackend: sdk` ». Dans `write.ts`, la règle devient `config.sandbox && config.agentBackend !== 'sdk'` ; dans `app.ts`, même remplacement. Tests : refus pour `claude-code`, `codex`, `opencode` ; accepté pour `sdk`.
- [ ] **Step 5 : classement et diff.** Dans `control-types.ts`, ajouter `'agentModels'` à `RESTART_REQUIRED_FIELDS`. Dans `diff.ts`, ajouter au `Record` `agentModels: (a, b) => (a.agentModels?.triage ?? null) === (b.agentModels?.triage ?? null) && (a.agentModels?.implement ?? null) === (b.agentModels?.implement ?? null)`. Tests : un changement de `triage` seul remonte `['agentModels']`, un objet équivalent ne remonte rien.
- [ ] **Step 6 : alias et app.** Mettre à jour `test/helpers/harness.ts` (`agentBackend?: 'sdk' | 'cli' | 'claude-code' | 'codex' | 'opencode'`, aux deux endroits) et `src/config/machine.test.ts` (`cli` → `claude-code`). Dans `app.ts`, la sélection devient `machine.agentBackend === 'claude-code' ? new CliAgentRunner({}) : new SdkAgentRunner(...)` et le message de clé API cite `agentBackend: claude-code`. Corriger les attentes devenues fausses dans `test/integration/daemon-commands.test.ts` (reload `cli` → `claude-code`) et `src/service/index.test.ts` (type `Pick<MachineConfig, 'agentBackend'>`, remplacer `'cli'`).
- [ ] **Step 7 :** `npm test`, `npm run typecheck`, commit `feat(config): agent backend enum with claude-code, codex, opencode`.

### Task 2 : socle sous-processus et déplacement de claude-code

**Files:**
- Create: `src/agent/cli/process.ts`
- Move: `src/agent/cli-runner.ts` → `src/agent/cli/claude-code-runner.ts` (+ `cli-runner.test.ts` → `cli/claude-code-runner.test.ts`), adapter les imports
- Modify: `src/agent/runner.ts`, `src/app.ts`

- [ ] **Step 1 : options.** Dans `runner.ts`, `model` devient `model?: string` (commentaire : absent = la CLI choisit son défaut) et ajouter `phase?: 'triage' | 'implement'` (commentaire : les CLI sans liste d'outils s'en servent pour choisir leur mode). Adapter `buildCliArgs` de claude-code : ne pousser `--model` que si défini. `buildOptions` du SDK passe `o.model` (type `Options['model']`, optionnel).
- [ ] **Step 2 : socle.** Extraire de `cli-runner.ts` une fonction `runCliProcess(o: { bin, args, cwd, env, stdin, transcriptPath, timeoutMs, signal, onLine, onStderr })` dans `cli/process.ts` : spawn `detached`, sérialisation des écritures de transcript, découpage des lignes JSONL, timeout du groupe, kill SIGTERM puis SIGKILL après `KILL_GRACE_MS`, ring stderr de 20 lignes, refus de lancer si `signal` déjà annulé. Y déplacer `callSlug(transcriptPath)`. Tests unitaires du socle repris de l'existant (ligne coupée, ligne non JSON, kill du groupe).
- [ ] **Step 3 : déplacement.** Déplacer `cli-runner.ts` et son test vers `src/agent/cli/`, renommer la classe `CliAgentRunner` → `ClaudeCodeAgentRunner` et le fichier de test en conséquence ; mettre à jour l'import de `summarizeResult` et l'import dans `app.ts`. Aucun changement de comportement : les tests existants passent tels quels.
- [ ] **Step 4 :** `npm test`, `npm run typecheck`, commit `refactor(agent): cli subprocess core`.

### Task 3 : adaptateur codex

**Files:**
- Create: `src/agent/cli/codex-runner.ts`, `src/agent/cli/codex-runner.test.ts`, `test/fakes/fake-codex.sh`

- [ ] **Step 1 : faux binaire.** `test/fakes/fake-codex.sh` sur le modèle de `fake-claude.sh` : écrit ses arguments, son environnement et le prompt stdin dans des fichiers désignés par `FAKE_CODEX_*`, émet un script JSONL sur stdout, écrit le fichier `-o` (variable `FAKE_CODEX_RESULT`), gère `FAKE_CODEX_STDERR`, `FAKE_CODEX_SLEEP`, `FAKE_CODEX_EXIT`.
- [ ] **Step 2 : arguments.** Test d'arguments : `exec --json --cd <cwd> --sandbox read-only` quand `phase: 'triage'`, `--sandbox workspace-write` quand `phase: 'implement'`, `--model` seulement si `model`, `--output-schema <fichier>` contenant le schéma sérialisé, `-o <fichier-résultat>`, `--ignore-user-config`, `-c` de coupure web/MCP, prompt sur stdin. Reprise : `exec resume <id>` en tête.
- [ ] **Step 3 : résultat.** Implémenter `CodexAgentRunner` : lit `-o` à la sortie, `JSON.parse` → `output` ; `thread.started.thread_id` → `sessionId` ; `turn.completed.usage` → `inputTokens`/`cacheReadTokens`/`outputTokens` ; `costUsd` 0 ; `stopReason` `completed` si sortie 0 et résultat lu, `error` sinon, `timeout`/`aborted` via le socle. Tests : succès (output, session, usage), résultat absent → `output` nul et `error`, ligne non JSON conservée en `sisyphe_raw`, timeout et abort tuent le groupe (réutiliser `expectGroupKilled`).
- [ ] **Step 4 :** `npm test`, `npm run typecheck`, commit `feat(agent): codex exec runner`.

### Task 4 : adaptateur opencode

**Files:**
- Create: `src/agent/cli/opencode-runner.ts`, `src/agent/cli/opencode-runner.test.ts`, `test/fakes/fake-opencode.sh`

- [ ] **Step 1 : faux binaire.** `test/fakes/fake-opencode.sh` : mêmes leviers que `fake-codex.sh` (`FAKE_OPENCODE_*`), écrit son environnement (pour vérifier `OPENCODE_PERMISSION`) et émet un flux JSON sur stdout.
- [ ] **Step 2 : permissions.** Exporter `buildOpenCodePermission(o: AgentRunOptions): Record<string, unknown>` : `{ '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', external_directory: 'deny' }` ; si `allowedTools` contient `Edit` ou `Write`, ajouter `edit` (`{ '*': 'allow' }` plus une entrée `deny` par motif de `pathGuard.protectedPatterns` sous ses deux formes `motif` et `**/motif`) et `bash: 'allow'` ; sinon `edit` et `bash` restent refusés par `'*': 'deny'`. Test : triage sans `edit`/`bash`, implémentation avec, sans `webfetch`/`websearch`.
- [ ] **Step 3 : arguments et env.** Test : `run --format json --auto`, `-m <modèle>` seulement si `model`, `--session <id>` si `resumeSessionId`, prompt sur stdin, `OPENCODE_PERMISSION` dans l'env sérialisé.
- [ ] **Step 4 : résultat.** Extraire le dernier objet JSON du dernier texte assistant du flux (`extractLastJsonObject`) → `output` (le pipeline revalide par zod) ; session et usage/cost best-effort depuis les événements ; `stopReason` selon sortie et présence d'un output. Tests : flux avec JSON final exploitable, texte sans JSON → `output` nul, JSON invalide → `output` nul sans planter, timeout/abort.
- [ ] **Step 5 :** `npm test`, `npm run typecheck`, commit `feat(agent): opencode runner`.

### Task 5 : factory, `app` et câblage du pipeline

**Files:**
- Create: `src/agent/index.ts`
- Modify: `src/app.ts`, `src/jobs/pipeline.ts`, `test/integration/pipeline.test.ts`

- [ ] **Step 1 : factory.** `src/agent/index.ts` : `createAgentRunner(backend: AgentBackend, opts: { sandbox: boolean }): AgentRunner`, un `switch` exhaustif (`sdk` → `SdkAgentRunner`, `claude-code` → `ClaudeCodeAgentRunner`, `codex` → `CodexAgentRunner`, `opencode` → `OpenCodeAgentRunner`). Test : mapping des quatre backends.
- [ ] **Step 2 : app.** Remplacer la sélection en ligne dans `app.ts` par `createAgentRunner(machine.agentBackend, { sandbox: machine.sandbox })`.
- [ ] **Step 3 : câblage du pipeline.** Dans `pipeline.ts`, l'appel de triage passe `model: phaseModel(deps.machine, 'triage', config.models.triage)` et `phase: 'triage'` ; l'appel d'implémentation, `phaseModel(deps.machine, 'implement', config.models.implement)` et `phase: 'implement'`. La phase enregistrée par `phases.start` garde le modèle de `sisyphe.yml` pour l'affichage (inchangé). Test d'intégration avec un backend `codex` et `agentModels` : le runner reçoit le modèle surchargé, absent sinon.
- [ ] **Step 4 :** `npm test`, `npm run typecheck`, commit `refactor(agent): runner factory and phase model wiring`.

### Task 6 : environnement de l'agent par backend

**Files:**
- Modify: `src/verify/commands.ts` (+ test), `src/service/index.ts` (+ test)

- [ ] **Step 1 : `agentEnv`.** Signature `agentEnv(base, extra, backend: AgentBackend = 'sdk')` : `sdk` réajoute `ANTHROPIC_API_KEY` ; `claude-code` et `codex` ne la réajoutent pas et `codex` retire en plus `OPENAI_API_KEY` ; `opencode` ne retire rien de spécifique. Test : les quatre backends, présence/absence des clés.
- [ ] **Step 2 : service.** Élargir les `Pick<MachineConfig, 'agentBackend'>` à l'enum complet ; l'injection `ANTHROPIC_API_KEY` reste réservée à `sdk`. Mettre à jour `src/service/index.test.ts`.
- [ ] **Step 3 :** `npm test`, `npm run typecheck`, commit `fix(agent): backend-aware agent environment`.

### Task 7 : résumé des transcripts codex et opencode

**Files:**
- Modify: `src/cli/format.ts` (+ test)

- [ ] **Step 1 : codex.** Étendre `summarizeTranscript` : `item.completed` avec `item.type === 'agent_message'` → `💬`, `command_execution` → `🔧 <commande>`, `file_change` → `📝 <chemins>` ; `turn.completed` → ligne de résultat (coût non communiqué). Test sur un échantillon JSONL codex.
- [ ] **Step 2 : opencode.** Reconnaître les parties de type texte et outil d'un échantillon opencode. Test sur un échantillon.
- [ ] **Step 3 :** `npm test`, `npm run typecheck`, commit `feat(cli): summarize codex and opencode transcripts`.

### Task 8 : chemins protégés bloquants

**Files:**
- Modify: `src/jobs/pipeline.ts` (+ `test/integration/pipeline.test.ts`), `src/deliver/comments.ts`

- [ ] **Step 1 : commentaire.** Ajouter `renderProtectedPathsComment(found: string[], trigger: string): string` dans `deliver/comments.ts` (même forme que `renderSecretsComment`), et corriger le texte de `renderSecretsComment` qui promet encore une conservation 7 jours (le worktree est désormais supprimé en cas d'échec). Test de rendu.
- [ ] **Step 2 : blocage.** Dans `pipeline.ts`, après la pose du flag et comme pour `secretsFound` : si `verify.flags.protectedPathsTouched.length > 0`, commenter, `source.setStatus(issueRef, 'failed')`, `cleanup()`, `finish('failed', ...)`, sans livrer. Test d'intégration : un changement touchant `secrets/**` termine `failed`, aucune PR, worktree nettoyé.
- [ ] **Step 3 :** `npm test`, `npm run typecheck`, commit `fix(jobs): a touched protected path fails the job`.

### Task 9 : setup et doctor par backend

**Files:**
- Modify: `src/cli/commands/setup.ts` (+ `.test.ts`), `src/cli/commands/doctor.ts` (+ test)

- [ ] **Step 1 : setup.** `validateBackend` accepte `sdk`, `claude-code`, `codex`, `opencode` et l'alias `cli` ; le défaut de question devient `claude-code`. `buildRawConfig` force `sandbox: false` dès que le backend n'est pas `sdk`. `installService` vérifie le binaire du backend sur le PATH du service (`claude`/`codex`/`opencode`). Tests : les quatre backends, sandbox forcée, binaire manquant.
- [ ] **Step 2 : doctor.** `buildChecks` : `claude-code` garde les checks Claude ; `codex` ajoute version + statut de login ; `opencode` ajoute version + `opencode auth list` ; les checks de clé API ne s'appliquent qu'à `sdk`. Les commandes de statut exactes sont épinglées sur la machine réelle (Task 11) avant d'être figées. Tests : noms de checks par backend.
- [ ] **Step 3 :** `npm test`, `npm run typecheck`, commit `feat(cli): setup and doctor cover codex and opencode`.

### Task 10 : onglet Réglages

**Files:**
- Modify: `src/ui/page.ts` (+ `src/ui/page.test.ts`)

- [ ] **Step 1 : select.** Le select BACKEND prend les quatre valeurs (`sdk`, `claude-code`, `codex`, `opencode`). Test page : les quatre `option` présentes.
- [ ] **Step 2 : modèles.** Deux champs `set-model-triage`/`set-model-implement` dans le groupe Agent ; `FIELD_IDS` mappe `agentModels.triage`/`agentModels.implement`. `readSettingsConfig` omet `agentModels` quand les deux champs sont vides, sinon envoie l'objet ; `fillSettings` les remplit depuis `config.agentModels`. Le bandeau de redémarrage couvre déjà le champ. Tests page : présence des champs, omission si vides.
- [ ] **Step 3 :** `npm test`, `npm run typecheck`, commit `feat(ui): settings expose codex and opencode backends`.

### Task 11 : docs et captures réelles

**Files:**
- Modify: `README.md`, `docs/playground.md`

- [ ] **Step 1 : capture.** Sur la machine, lancer une exécution codex puis opencode (`codex exec --json …`, `opencode run --format json …`) et relever les noms exacts d'événements, les clés de config de coupure web/MCP, la syntaxe de `OPENCODE_PERMISSION` et les commandes de statut de login. Ajuster les adaptateurs, `format.ts`, `doctor.ts` en conséquence (retour en TDD sur les tâches concernées), puis figer les échantillons dans les tests.
- [ ] **Step 2 : docs.** README : les quatre backends, l'authentification attendue (login CLI vs clé API), les limites (budget/tours/coût, chemins protégés). `docs/playground.md` : scénarios de validation par backend, comme la validation `cli` existante.
- [ ] **Step 3 :** `npm test`, `npm run typecheck`, commit `docs: codex, opencode and claude-code backends`.

## Auto-revue du plan

- Couverture spec : §2 → tâches 1, 6, 8 ; §3 → tâches 2, 5 ; §4 → tâches 3, 4 ; §5 → tâche 1 ; §6 → tâche 6 ; §7 → tâche 7 ; §8 → tâche 8 (et limites en tâche 11) ; §9 → tâche 9 ; §10 → tâche 10 ; §11 → tests de chaque tâche ; §12 → hors périmètre.
- Noms cohérents : `createAgentRunner` (tâche 5) construit les quatre classes introduites en tâches 2, 3 et 4 ; `phaseModel` (tâche 1) est utilisé par le pipeline et le runner en tâche 5 ; `AgentRunOptions.model`/`phase` (tâche 2) consommés en tâches 3 et 4 ; `buildOpenCodePermission` défini et testé en tâche 4 ; `renderProtectedPathsComment` défini et utilisé en tâche 8 ; `AgentBackend` défini en tâche 1 et consommé ensuite.
- Dépendances : 2 après 1 (enum) ; 3 et 4 après 2 (socle) ; 5 après 3 et 4 (factory exhaustive) ; 6, 7, 8, 9, 10 après 1 ; 11 en dernier (épingle les formes réelles).
