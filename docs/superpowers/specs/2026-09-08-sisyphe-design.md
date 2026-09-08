# Sisyphe — Design

Date : 2026-09-08
Statut : validé en brainstorming, en attente de relecture avant plan d'implémentation.

## 1. Objectif

Sisyphe est un daemon qui prend en charge automatiquement les issues GitHub étiquetées, les implémente avec un agent Claude (Claude Agent SDK), vérifie le résultat par lui-même, et ouvre une pull request. Le développeur relit des PR le matin au lieu de coder la veille.

Première cible : `ILokYou/ILokYou-iOS` (Swift, branche de base `develop`). Sisyphe ne contient rien de spécifique à iOS : tout ce qui dépend du repo cible vit dans un fichier `sisyphe.yml` à la racine de ce repo.

Contexte : POC sur le Mac de Victor, destiné à prouver la faisabilité et à justifier l'achat de Mac mini dédiés. Les métriques (coût par issue, durée, taux de merge) sont donc une fonctionnalité de première classe, pas un bonus.

## 2. Décisions structurantes

- **Runtime : un Mac** (laptop pour le POC, Mac mini à terme). Raison : Xcode ne tourne que sur macOS, et on veut que l'agent compile et teste.
- **Orchestration : daemon custom + Claude Agent SDK**, pas GitHub Actions. Raison : contrôle fin du pipeline en phases (triage, implémentation, vérification, livraison), et portabilité vers d'autres sources d'issues (Jira) et d'autres forges plus tard.
- **Langage : TypeScript sur Node 24 ou plus.** Même runtime que Claude Code, SDK le mieux documenté, launchd trivial. Le module intégré `node:sqlite` remplace `better-sqlite3` : aucun module natif à compiler sur un Mac neuf.
- **Auth Claude : clé API entreprise** via `ANTHROPIC_API_KEY`. L'auth par abonnement claude.ai n'est pas autorisée pour les agents SDK, et la clé API donne le coût réel par issue.
- **Identité GitHub : une GitHub App `sisyphe[bot]`** installée sur les repos cibles. Raison : GitHub interdit d'approuver sa propre PR, donc les PR ne doivent pas être ouvertes avec le token de Victor. Le bot donne aussi une attribution claire.
- **Interface de review v1 : GitHub natif** (PR, labels, commentaires). Pas de dashboard web en v1.
- **Un job à la fois par défaut.** Xcode supporte mal le parallélisme sur une même machine.

## 3. Architecture

### 3.1 Modules (`src/`)

- `config` : chargement et validation (zod) de la config machine `~/.sisyphe/config.yml` et de la config repo `sisyphe.yml`. Applique les défauts.
- `github` : client GitHub App (Octokit) : issues, labels, commentaires, permissions, PR. Implémente l'interface `IssueSource`.
- `git` : miroir bare par repo, worktree par job, branches, squash, push, diff. Appelle le binaire `git` via `execa`.
- `store` : SQLite via `node:sqlite`, tables `jobs` et `phases`, migrations versionnées.
- `jobs` : machine à états, scheduler, réconciliation au démarrage.
- `agent` : `AgentRunner` qui enveloppe le SDK, prompts de triage et d'implémentation, schémas JSON de sortie, hooks de sécurité.
- `verify` : exécution de build, test, lint ; scan de secrets (gitleaks) ; détection des chemins protégés ; taille du diff.
- `deliver` : squash, commit, push, rendu du body de PR, création de la PR, labels et commentaires finaux.
- `daemon` : boucle de poll, gestion de la concurrence, `caffeinate`, arrêt propre, suivi des PR.
- `cli` : `sisyphe setup | doctor | start | status | logs | report | cancel`.
- `report` : agrégation des KPI depuis SQLite, rendu markdown.

### 3.2 Dépendances externes

Node 24 ou plus, git, gitleaks (via Homebrew), Claude Code CLI (embarqué par le SDK). Les outils du repo cible (Xcode, xcodegen, swiftlint) ne sont pas connus de Sisyphe : ils sont invoqués via les commandes déclarées dans `sisyphe.yml`, et `sisyphe doctor` vérifie seulement que leur premier mot est sur le PATH.

Librairies : `@anthropic-ai/claude-agent-sdk`, `@octokit/app`, `@octokit/rest`, `zod`, `yaml`, `execa`, `picomatch`, `pino`, `commander`, `vitest`.

### 3.3 Interfaces internes

```ts
interface IssueSource {
  listCandidates(repo: RepoRef): Promise<IssueRef[]>;       // ouvertes, label trigger, sans label de statut
  getIssue(ref: IssueRef): Promise<Issue>;                   // titre, body, commentaires, labels, auteur
  canTrigger(ref: IssueRef): Promise<{ ok: boolean; login: string | null }>; // le poseur du label a write/maintain/admin
  setStatus(ref: IssueRef, status: JobStatusLabel | null): Promise<void>; // pose ce label de statut, retire les autres ; null = aucun
  comment(ref: IssueRef, markdown: string): Promise<void>;
  isStillActive(ref: IssueRef): Promise<boolean>;            // ouverte et label trigger présent
  openPullRequest(input: PullRequestInput): Promise<PullRef>;
  findPullRequest(repo: RepoRef, headBranch: string): Promise<PullRef | null>;
  getPullRequestState(ref: PullRef): Promise<{ state: 'open' | 'closed'; mergedAt: string | null }>;
}

interface AgentRunner {
  run<T>(opts: {
    cwd: string;
    model: string;
    systemPromptAppend: string;
    prompt: string;
    outputSchema?: JSONSchema;
    maxTurns: number;
    maxBudgetUsd: number;
    resumeSessionId?: string;
    allowedTools: string[];
    disallowedTools: string[];
    hooks?: SDKHooks;            // garde des chemins (PreToolUse)
    env: Record<string, string>; // env épuré du daemon + SISYPHE_* + clé API
    timeoutMs: number;
    signal: AbortSignal;
    transcriptPath: string;
  }): Promise<AgentResult<T>>;
}

interface AgentResult<T> {
  output: T | null;            // null si le schéma n'a pas été respecté ou arrêt anticipé
  sessionId: string | null;    // null si le SDK s'arrête avant l'init
  costUsd: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number };
  numTurns: number;
  durationMs: number;
  stopReason: 'completed' | 'max_turns' | 'max_budget' | 'timeout' | 'aborted' | 'error';
  errorMessage?: string;
  transcriptPath: string;
}
```

`IssueSource` et `AgentRunner` ont une seule implémentation réelle chacun en v1, plus des fakes pour les tests. L'abstraction existe d'abord pour rendre les tests possibles sans réseau ni coût API. Elle regroupe volontairement tout ce que Sisyphe demande à la forge (issues, labels, PR, URL authentifiée, branche par défaut) : une source Jira en v2 ne couvrirait que la partie issues et viendrait s'y ajouter, pas la remplacer. Le plan d'implémentation fait foi pour le détail des signatures (`listWithStatus`, `removeTriggerLabel`, `getDefaultBranch`, `getAuthenticatedRemoteUrl`, `updatePullRequest`, `ensureLabels`).

## 4. Flux d'un job

### 4.1 Machine à états

```
queued → triaging → implementing → verifying → delivering → done
                 ↘ blocked        ↺ (retry)   ↘ failed   ↘ failed
tout état actif → cancelled
```

États terminaux : `done`, `blocked`, `failed`, `cancelled`. Un job est dit **actif** dans tout autre état, `queued` compris.

- `verifying` échoué avec des tentatives restantes revient en `implementing` sur la même session agent, avec le log d'échec.
- `verifying` échoué à la dernière tentative passe quand même en `delivering`, avec un flag `verificationFailed` : on livre une PR draft pour inspection, et le job termine en `failed`.
- `verifying` avec secret détecté passe directement en `failed`, sans livraison.
- `blocked` : le job attend un humain (triage non concluant, diff vide, `sisyphe.yml` absent).
- `failed` : vérification rouge après épuisement des tentatives, secret détecté, ou erreur technique.
- `cancelled` : label retiré ou issue fermée pendant le job.

### 4.2 Détection

Toutes les `pollIntervalSeconds` (défaut 60), pour chaque repo configuré, Sisyphe liste les issues ouvertes portant le label trigger (défaut `sisyphe`) et aucun label de statut (`sisyphe:in-progress`, `sisyphe:blocked`, `sisyphe:done`, `sisyphe:failed`), sans job actif en base pour ce couple repo/issue.

Pour chaque candidate, `canTrigger` vérifie que le dernier événement `labeled` du label trigger a été posé par un utilisateur ayant la permission write, maintain ou admin sur le repo. Sinon : commentaire « label ignoré, permission insuffisante », retrait du label, pas de job.

Une candidate valide devient un job `queued`.

Relance d'une issue déjà traitée : retirer son label de statut (`sisyphe:blocked`, `sisyphe:failed` ou `sisyphe:done`) en laissant le label trigger. Elle redevient candidate au poll suivant et un nouveau job est créé, avec un compteur de tentatives remis à zéro.

### 4.3 Prise en charge

Le scheduler prend le plus ancien job `queued` si le nombre de jobs actifs est inférieur à `maxConcurrentJobs` (défaut 1) et si le budget quotidien n'est pas atteint.

1. Label `sisyphe:in-progress` sur l'issue, commentaire « Sisyphe a pris l'issue » contenant le marqueur invisible `<!-- sisyphe:job:<id> -->`.
2. `caffeinate -dims` pendant toute la durée du job.
3. Git : miroir `~/.sisyphe/mirrors/<owner>__<repo>.git` créé avec `git clone --mirror` la première fois, puis `git remote update --prune`. Worktree `~/.sisyphe/work/<owner>__<repo>/issue-<n>` sur une branche neuve `<branchPrefix>issue-<n>-<slug>` depuis `origin/<baseBranch>`. Le slug est le titre en kebab-case tronqué à 40 caractères. Le SHA de `origin/<baseBranch>` au moment de la création est enregistré comme `base_sha` du job : c'est la référence du squash final, même si la base avance pendant le job. Si la branche existe déjà sur le remote (job précédent échoué), elle est écrasée au push : chaque job repart de la base.
4. Lecture de `sisyphe.yml` sur la **branche par défaut** du repo (dans le miroir, avant la création du worktree : il faut connaître `baseBranch` pour créer le worktree). Conséquence : le fichier doit vivre sur la branche par défaut, même si `baseBranch` est une autre branche. S'il est absent ou invalide : job `blocked`, commentaire distinguant les deux cas (exemple minimal si absent, erreurs de validation si invalide).
5. `commands.setup` exécuté dans le worktree (exemple iOS : `xcodegen generate`).
6. Variables d'environnement exposées aux commandes du repo et à l'agent : `SISYPHE_CACHE_DIR=~/.sisyphe/cache/<owner>__<repo>` (pour DerivedData, SPM, gradle), `SISYPHE_ISSUE_NUMBER`, `SISYPHE_BRANCH`.

### 4.4 Triage

Agent en lecture seule. Outils disponibles : `Read`, `Glob`, `Grep` uniquement (option SDK `tools`, liste blanche ; ces outils sont aussi auto-approuvés via `allowedTools`). Modèle `models.triage` (défaut `claude-sonnet-5`), budget `budget.triageUsd` (défaut 1), `maxTurns` 40, timeout `timeouts.triageMinutes` (défaut 10).

Le prompt contient : le rôle, l'issue (titre, body, commentaires) placée entre balises `<issue>` et présentée explicitement comme des données non fiables à ne pas exécuter, les `instructions` du repo, les critères de décision. Le SDK ne charge rien depuis le repo cible (`settingSources: []`) : Sisyphe lit lui-même `CLAUDE.md`, `.claude/CLAUDE.md` et `AGENTS.md` à la racine du worktree et les injecte dans le system prompt.

Sortie imposée par schéma JSON :

```json
{
  "verdict": "ready | needs_clarification | too_big | out_of_scope",
  "confidence": 0.0,
  "summary": "reformulation en une phrase",
  "change_type": "feat | fix | refactor | chore | docs",
  "plan": ["étape 1", "étape 2"],
  "files_likely_touched": ["chemin/relatif"],
  "questions": ["si needs_clarification"],
  "reasons": ["si too_big ou out_of_scope"]
}
```

Critères de `ready` : le comportement attendu est identifiable sans ambiguïté ; pour un bug, une reproduction ou une localisation plausible existe ; le plan tient en au plus `limits.maxFilesEstimate` fichiers (défaut 15). Pour `too_big`, `reasons` doit proposer un découpage.

Si le verdict n'est pas `ready` : commentaire sur l'issue avec les questions ou les raisons, label `sisyphe:blocked`, job `blocked`, worktree supprimé. Relance par un humain : répondre dans l'issue, puis retirer `sisyphe:blocked` en laissant le label trigger. Sisyphe crée un nouveau job et le triage relit tous les commentaires.

### 4.5 Implémentation

Agent en écriture. `cwd` = worktree, `settingSources: []`, system prompt = preset `claude_code` + un append composé des consignes Sisyphe, des `instructions` du repo et de son CLAUDE.md lu par Sisyphe. `permissionMode: 'dontAsk'` : tout ce qui n'est pas explicitement autorisé est refusé sans prompt.

- Outils disponibles (`tools`, liste blanche) et auto-approuvés (`allowedTools`) : `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash`.
- `disallowedTools` : `git push` et `git remote` sous Bash (deux syntaxes de préfixe, vérifiées en validation end-to-end), `WebFetch`, `WebSearch`.
- Hook `PreToolUse` sur `Edit` et `Write` : refuse toute cible dont le chemin résolu sort du worktree, `.git`, les chemins protégés de base (`.claude/**`, `.mcp.json`, `sisyphe.yml`, `.github/workflows/**`, non désactivables) et ceux de `protectedPaths`. Comparaison lexicale : un lien symbolique n'est pas suivi, c'est le rôle du sandbox.
- Option machine `sandbox: true` : active le sandbox macOS de Claude Code, qui confine le système de fichiers au worktree et limite le réseau sortant. Désactivé par défaut pour le POC.
- Aucun settings du repo cible n'est chargé (`settingSources: []`) : un `.claude/settings.json` peut porter des hooks, commandes shell exécutées avec les privilèges du daemon, qu'un repo ou l'agent lui-même pourrait déposer. `managedSettings.strictPluginOnlyCustomization: ['hooks', 'mcp']` est posé en plus, mais il peut être ignoré sur une machine gérée par MDM ; la protection ne repose donc pas sur lui. Le CLAUDE.md du repo est injecté par Sisyphe (voir 4.4).
- Le budget `maxBudgetUsd` est remis à zéro à chaque reprise de session (retry) : le plafond effectif d'un job est `limits.maxAttempts × budget.implementUsd`, le budget quotidien reste la borne globale.

Le prompt contient : l'issue (mêmes balises que le triage), le `summary` et le `plan` du triage, les commandes `setup`, `build`, `test`, `lint` à utiliser, et les consignes : ne pas toucher aux `protectedPaths`, ne pas se soucier des commits (Sisyphe squash tout en un commit à la fin, un commit intermédiaire est toléré), exécuter build et tests avant de conclure, terminer par un rapport structuré :

```json
{
  "summary": "ce qui a été fait, 2 à 4 phrases",
  "changes": [{ "file": "chemin", "what": "quoi et pourquoi" }],
  "decisions": ["choix non évidents et alternatives écartées"],
  "tests_run": ["commande : résultat"],
  "risks": ["ce que le relecteur doit regarder en priorité"],
  "follow_ups": ["ce qui reste à faire hors périmètre"],
  "confidence": 0.0
}
```

Modèle `models.implement` (défaut `claude-opus-5`), budget `budget.implementUsd` (défaut 8), `maxTurns` 200, timeout `timeouts.implementMinutes` (défaut 60). Si la session s'arrête sur budget, turns ou timeout, le job passe quand même en vérification avec ce qui existe ; le rapport est alors remplacé par un rapport minimal généré par Sisyphe indiquant l'arrêt anticipé.

### 4.6 Vérification

Exécutée par Sisyphe, pas par l'agent. Le rapport de l'agent n'est jamais pris pour preuve.

1. Diff vide : job `blocked`, commentaire « aucun changement produit » avec le `summary` de l'agent.
2. `commands.setup` rejoué (le projet a pu changer, par exemple un fichier ajouté sous xcodegen), puis `commands.build`, `commands.test`, `commands.lint`, chacune si définie, avec timeout global `timeouts.verifyMinutes` (défaut 30). Sorties capturées dans le dossier du job.
3. Échec et `attempt < limits.maxAttempts` (défaut 3) : retour en `implementing` avec `resumeSessionId` et un prompt « la vérification a échoué, voici les 200 dernières lignes, corrige ». Échec à la dernière tentative : flag `verificationFailed`, passage en `delivering` pour une PR draft d'inspection, issue finale `failed` (voir 4.7).
4. Flags calculés sur le diff : `protectedPathsTouched`, `largeDiff` (plus de `limits.maxDiffLines` lignes modifiées, défaut 800), `secretsFound` (gitleaks sur le patch). `secretsFound` est bloquant : job `failed` immédiat, aucun push, commentaire sur l'issue avec les fichiers concernés sans le contenu.

### 4.7 Livraison

1. Squash en un commit unique : `git reset --soft <base_sha>` puis commit. Message : `<change_type>(#<n>): <titre de l'issue>`, corps `Closes #<n>` et `Co-Authored-By: Sisyphe <sisyphe[bot]@users.noreply.github.com>`.
2. Push forcé de la branche avec un token d'installation GitHub App (courte durée), obtenu par Sisyphe et jamais exposé à l'agent.
3. PR : titre `[#<n>] <titre de l'issue>`, base `baseBranch`, labels `pr.labels` (défaut `[sisyphe]`), reviewers `pr.reviewers` (défaut : l'auteur de l'issue s'il a accès au repo). Draft si `pr.draft` est vrai, si `verificationFailed`, ou si `protectedPathsTouched` ou `largeDiff`. Si une PR existe déjà pour cette branche (`findPullRequest`, cas d'un job précédent), elle est réutilisée : body remplacé, statut draft ajusté, pas de doublon.
4. Body de la PR, rendu depuis le rapport JSON, sections dans cet ordre : résumé ; changements ; décisions ; tests exécutés par l'agent et résultat de la vérification indépendante ; points d'attention (`risks`, flags) ; suites à donner ; coût (par phase et total), durée, tentatives, modèles ; `Closes #<n>` ; marqueur `<!-- sisyphe:job:<id> -->`. Si le repo a un `.github/PULL_REQUEST_TEMPLATE.md`, il est ajouté tel quel sous la section Sisyphe, non rempli, pour que le relecteur le complète.
5. Sur l'issue : label `sisyphe:done`, ou `sisyphe:failed` si `verificationFailed`, commentaire avec lien PR, coût et durée.
6. Job `done` ou `failed` selon le même critère. Worktree supprimé si `done`, conservé 7 jours si `failed` puis purgé par le daemon.

### 4.8 Annulation

Pendant un job, toutes les 60 s, `isStillActive`. Si l'issue est fermée ou si le label trigger a été retiré : `AbortController` propagé au SDK et aux commandes en cours, worktree supprimé, retrait de `sisyphe:in-progress`, commentaire « job annulé », job `cancelled`. La commande `sisyphe cancel <jobId>` fait la même chose depuis la machine.

### 4.9 Redémarrage et réconciliation

Au démarrage du daemon :

- Jobs `triaging`, `implementing`, `verifying` : le worktree est supprimé et le job repart de zéro (`attempt`, `flags`, `error` remis à zéro) avec un commentaire « redémarré ». Un job n'est requeué qu'une fois (compteur `requeues`) ; au second redémarrage il passe en `failed` avec commentaire et label.
- Jobs `delivering` : `findPullRequest` par branche (PR ouvertes uniquement). PR trouvée : `done` (ou `failed` si la vérification avait échoué), label de statut posé et commentaire de fin avec l'URL de la PR, comme l'aurait fait la livraison. Pas de PR : requeue comme ci-dessus ; la seconde tentative force-pousse le même nom de branche. Erreur API : le job reste en `delivering` et sera réexaminé au prochain démarrage.
- Worktrees sur disque : supprimés sauf ceux des jobs actifs et ceux des jobs `failed` de moins de 7 jours (gardés pour inspection). Le chemin d'un job actif est reconnu même si la base ne l'a pas encore enregistré (il se déduit du repo et du numéro d'issue). Le daemon relance cette purge périodiquement, jamais pendant qu'un job tourne.
- Labels `sisyphe:in-progress` sur GitHub sans job actif : si un job terminé avec PR ouverte existe pour l'issue, le label est corrigé d'après son état ; sinon le label est retiré avec un commentaire « redémarré » et l'issue redevient candidate au poll suivant. C'est GitHub qui fait foi si la base SQLite est perdue : le marqueur de job dans les commentaires permet de retrouver l'historique.
- Chaque job est réconcilié indépendamment : une erreur sur l'un n'empêche pas le traitement des autres, ni la purge, ni la libération des labels.

## 5. Configuration

### 5.1 Machine : `~/.sisyphe/config.yml`

```yaml
github:
  appId: 123456
  installationId: 7890
  privateKeyPath: ~/.sisyphe/github-app.pem
repos:
  - ILokYou/ILokYou-iOS
triggerLabel: sisyphe
pollIntervalSeconds: 60
maxConcurrentJobs: 1
dailyBudgetUsd: 60
sandbox: false
dataDir: ~/.sisyphe
```

`ANTHROPIC_API_KEY` est fournie par l'environnement (plist launchd), jamais écrite dans la config.

### 5.2 Repo : `sisyphe.yml`

```yaml
baseBranch: develop                 # requis
branchPrefix: feature/              # défaut feature/
commands:
  setup: xcodegen generate          # optionnel
  build: xcodebuild build -scheme AlloVoisins -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath "$SISYPHE_CACHE_DIR/DerivedData"   # requis
  test: xcodebuild test -scheme AlloVoisins -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath "$SISYPHE_CACHE_DIR/DerivedData"    # optionnel
  lint: swiftlint --strict          # optionnel
protectedPaths:                     # globs, défaut []
  - "**/*.xcconfig"
  - "fastlane/**"
  - ".github/**"
models:
  triage: claude-sonnet-5
  implement: claude-opus-5
budget:
  triageUsd: 1
  implementUsd: 8
limits:
  maxAttempts: 3
  maxDiffLines: 800
  maxFilesEstimate: 15
timeouts:
  triageMinutes: 10
  implementMinutes: 60
  verifyMinutes: 30
pr:
  labels: [sisyphe]
  reviewers: []
  draft: false
instructions: |
  Texte libre ajouté au system prompt des deux agents.
  Exemple : conventions d'équipe, modules à ne pas toucher, comment lancer un test ciblé.
```

Seuls `baseBranch` et `commands.build` sont requis. Toutes les commandes tournent via `sh -c` dans le worktree avec les variables `SISYPHE_*`.

## 6. Données

Base SQLite `~/.sisyphe/sisyphe.db`.

Table `jobs` : `id`, `repo`, `issue_number`, `issue_title`, `state`, `attempt`, `branch`, `base_sha`, `worktree_path`, `verdict_json`, `report_json`, `flags_json`, `pr_number`, `pr_url`, `pr_state`, `pr_merged_at`, `cost_usd`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `duration_ms`, `error`, `created_at`, `started_at`, `finished_at`, `updated_at`.

Table `phases` : `id`, `job_id`, `name` (`triage`, `implement`, `verify`, `deliver`), `attempt`, `model`, `session_id`, `cost_usd`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `num_turns`, `stop_reason`, `outcome`, `started_at`, `finished_at`.

Fichiers par job dans `~/.sisyphe/jobs/<id>/` : `transcript-<phase>-<attempt>.jsonl` (tous les messages SDK), `setup.log`, `build.log`, `test.log`, `lint.log`, `diff.patch`, `job.json` (snapshot de la ligne `jobs`).

Suivi des PR : toutes les heures, pour les jobs `done` ou `failed` dont la PR est encore ouverte et a moins de 30 jours, mise à jour de `pr_state` et `pr_merged_at`. C'est ce qui alimente le taux de merge, le KPI principal du business case.

Logs du daemon : pino JSON dans `~/.sisyphe/logs/daemon.log`, rotation quotidienne, 14 jours conservés.

## 7. CLI

- `sisyphe setup` : interactif. Crée `~/.sisyphe`, écrit `config.yml`, demande le chemin de la clé GitHub App et la clé API, écrit `~/Library/LaunchAgents/com.sisyphe.daemon.plist` (KeepAlive, RunAtLoad, variables d'env, logs), puis `launchctl load`.
- `sisyphe doctor` : vérifie node, git, gitleaks, le CLI Claude, la clé API (appel minimal), l'accès de la GitHub App à chaque repo, la présence et la validité de `sisyphe.yml` sur la branche de base de chaque repo, la présence sur le PATH du premier mot de chaque commande déclarée. Sortie : une ligne par vérification, code de retour non nul si une vérification échoue.
- `sisyphe start [--once]` : lance le daemon au premier plan (c'est ce que launchd exécute). `--once` fait un cycle de poll, traite les jobs trouvés jusqu'au bout, puis quitte. Utile pour les tests et la démo.
- `sisyphe status` : jobs actifs et les 20 derniers, avec état, coût, durée, lien PR.
- `sisyphe logs <jobId> [--phase <name>] [--raw]` : par défaut un résumé lisible du transcript (outils appelés, fichiers touchés, commandes lancées) ; `--raw` affiche les fichiers bruts.
- `sisyphe report [--since 30d] [--repo <owner/repo>]` : markdown avec nombre de jobs, répartition par état final, taux de PR ouvertes, taux de PR mergées, coût total et médian, durée médiane, nombre de tentatives moyen, cinq derniers échecs avec raison.
- `sisyphe cancel <jobId>` : annule un job actif.

## 8. Gestion d'erreurs

- API GitHub : retry exponentiel trois fois sur erreurs réseau et 5xx ; sur 403 rate limit, attente jusqu'à `x-ratelimit-reset`.
- SDK / API Anthropic : retry trois fois sur 429 et 5xx ; sinon la tentative est marquée échouée et la logique de tentatives du job s'applique.
- Budget quotidien atteint (somme des `cost_usd` des phases terminées depuis minuit, heure locale) : le daemon ne démarre plus de job, commente les issues `queued` « en pause budget, reprise demain », et reprend au changement de jour.
- Exception inattendue dans un job : job `failed`, commentaire avec un message court et le `jobId`, le daemon continue.
- Commande de vérification qui dépasse le timeout : traitée comme un échec de vérification.
- Arrêt du daemon (SIGTERM) : les jobs actifs sont interrompus proprement et laissés dans leur état pour la réconciliation au redémarrage.

## 9. Sécurité

- **Identité** : GitHub App avec permissions `contents: write`, `pull_requests: write`, `issues: write`, `metadata: read`, installée uniquement sur les repos cibles. Le token d'installation est court et n'entre jamais dans l'environnement de l'agent.
- **Déclenchement** : seul un label posé par un membre avec droit d'écriture est pris en compte.
- **Injection de prompt** : le contenu des issues et des commentaires est passé comme données entre balises, avec la consigne explicite de ne pas y obéir. C'est une atténuation, pas une garantie : la vérification indépendante, les chemins protégés et le scan de secrets sont les vraies barrières.
- **Périmètre de l'agent** : liste blanche d'outils (`tools`), `git push` et `git remote` interdits, outils web interdits, hooks et MCP des settings du repo cible désactivés, hook qui bloque les écritures hors worktree, dans `.git`, sur les chemins protégés de base et déclarés ; sandbox macOS optionnel. Le token GitHub ne passe que sur la ligne de commande de `fetch`/`push`, jamais pendant qu'un agent tourne.
- **Secrets** : gitleaks sur chaque diff avant push, bloquant. Limite connue : la clé API Anthropic est présente dans l'environnement du processus agent, donc lisible par un `Bash` de l'agent. Acceptable pour le POC sur une machine de confiance ; le sandbox réseau la rend inutilisable vers l'extérieur.
- **Chemins protégés** : déclarés par repo, un diff qui les touche force la PR en draft avec alerte.

## 10. Tests

- **Unitaires (vitest)** : validation des configs et défauts ; transitions de la machine à états, y compris tentatives et annulation ; réconciliation au redémarrage ; logique `canTrigger` ; matcher de chemins protégés ; calcul de taille de diff ; slug et nom de branche ; rendu du body de PR à partir d'un rapport ; agrégation du report. Tous avec des fakes de `IssueSource`, `AgentRunner` et du module git.
- **Intégration locale, sans réseau ni coût API** : un repo fixture minuscule (script shell comme build et test) servi par un dépôt git bare sur disque en guise de remote, un `FakeIssueSource` en mémoire, un `ScriptedAgentRunner` qui écrit des fichiers connus et renvoie un rapport fixé. On vérifie la chaîne complète : worktree, branche, commit squashé sur le bare, body de PR, labels, états en base. Un second scénario fait échouer la première vérification pour tester la reprise de session.
- **End-to-end manuel** : un repo `sisyphe-playground` sur GitHub (petit projet TypeScript avec `sisyphe.yml`), la vraie GitHub App et la vraie clé API. Fumée obligatoire avant de brancher ILokYou-iOS.

## 11. Installation sur un Mac neuf

1. Xcode depuis l'App Store, ouvrir une fois, accepter la licence, installer un simulateur iPhone. Étape manuelle, hors Sisyphe.
2. Homebrew, puis `brew install node git gitleaks xcodegen` (Node 24 ou plus).
3. `npm install -g sisyphe` (ou clone du repo et `npm link` pendant le POC).
4. Créer la GitHub App une fois pour l'organisation, l'installer sur les repos, télécharger la clé privée.
5. `sisyphe setup`, puis `sisyphe doctor` jusqu'au vert.
6. Ajouter `sisyphe.yml` sur la branche de base du repo cible, créer les labels `sisyphe`, `sisyphe:in-progress`, `sisyphe:blocked`, `sisyphe:done`, `sisyphe:failed` (le daemon les crée s'ils manquent).

Objectif : 15 minutes hors installation de Xcode.

## 12. Plan de démo

1. La veille, poser le label sur trois à cinq vraies petites issues du backlog iOS, dont une volontairement vague.
2. Le matin, montrer : les PR ouvertes avec leur body ; l'issue vague bloquée avec les questions du triage (le système sait quand ne pas coder) ; `sisyphe report` avec coût et durée par issue.
3. Comparer avec l'estimation humaine de ces mêmes issues.

## 13. Hors périmètre v1

- Digest matinal (Slack ou commentaire épinglé) et dashboard web sur la SQLite.
- Source Jira derrière `IssueSource`.
- Traitement des commentaires de review sur les PR de Sisyphe.
- Auto-review du diff par un troisième agent avant ouverture de la PR.
- `sisyphe init` qui génère un `sisyphe.yml` en inspectant le repo.
- Parallélisme par repo (un job iOS et un job Android en même temps).
- Remplissage automatique du template de PR du repo.

## 14. Risques connus

- Build iOS à froid long (20 à 40 minutes). Le cache partagé par repo dans `SISYPHE_CACHE_DIR` est la parade ; à mesurer dès les premiers jobs.
- Le triage bloquera beaucoup d'issues au début. C'est voulu : il pousse à mieux écrire les issues, et c'est un argument de démo.
- Coût par issue estimé entre 3 et 10 dollars avec Opus sur un repo de cette taille. Le report le mesurera ; les plafonds par job et par jour bornent le risque.
- Laptop fermé ou en veille pendant le POC : jobs interrompus, requeués à la reprise par la réconciliation. Le Mac mini règle le problème.
- Un agent qui casse son worktree (dépendances supprimées, projet régénéré différemment) : la tentative suivante repart d'un worktree neuf.
