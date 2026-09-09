# Sisyphe UI : interface locale en lecture seule

Validé le 2026-09-09 avec Victor. Complète la spec `2026-09-08-sisyphe-design.md`.

## 1. Objectif

Voir d'un coup d'œil ce que fait Sisyphe : jobs en cours et fil des actions de l'agent, historique des jobs, KPIs de coût et de durée, état du système. Utile au quotidien pour Victor et lisible en réunion. Lecture seule : aucune action sur les jobs ni sur GitHub depuis l'interface (v2 éventuelle).

## 2. Décisions

- **Commande** `sisyphe ui [--port <n>]` (défaut 7777). Serveur `node:http` natif, lié à `127.0.0.1` uniquement ; refuse de démarrer si le port est pris. Pas d'authentification (local). En-têtes `Content-Security-Policy: default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'` (page unique embarquée), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`.
- **Données** : la SQLite de Sisyphe ouverte en **lecture seule** (`new DatabaseSync(path, { readOnly: true })`, WAL : aucune gêne pour le daemon) ; les dossiers `jobs/<id>/` (transcripts, logs de vérification, `diff.patch`, `gitleaks.json`) ; le fichier de verrou `daemon.lock` ; `launchctl print` pour l'agent launchd (macOS seulement, avertissement sinon). Aucun appel réseau, ni GitHub ni Anthropic. La config machine est lue pour `repos`, `dailyBudgetUsd`, `triggerLabel`, `agentBackend`.
- **Page unique** embarquée dans le module TypeScript (`src/ui/page.ts` exporte le HTML), CSS et JS vanilla, aucune dépendance ni build front. Tout texte issu de la base ou des fichiers est injecté via `textContent` ; jamais de `innerHTML` avec des données. Les liens (issue, PR) sont construits à partir de `repo`, `issueNumber`, `prUrl` après vérification que `prUrl` commence par `https://github.com/`.
- **Temps réel** : `GET /api/events` (SSE) pousse un événement `snapshot` toutes les 2 s contenant le tableau de bord (état système, budget, jobs actifs avec leur fil d'actions récent). Le reste est servi en JSON à la demande.
- **Charte** : fond sombre, typographie système, chiffres clés en grand, couleurs d'état alignées sur les labels GitHub (`in-progress` bleu, `done` vert, `blocked` orange, `failed` rouge, `cancelled` gris, `queued` neutre). Une seule page, navigation par onglets (Tableau de bord, Jobs, KPIs) et un panneau de détail de job. Pas de mode démo.

## 3. API JSON (toutes en GET, `application/json; charset=utf-8`)

- `/api/overview` → `{ now, daemon: { running: boolean, pid: number | null }, launchd: { loaded: boolean | null, lastExitCode: number | null, detail: string }, budget: { spentTodayUsd, dailyBudgetUsd, ratio }, backend: 'sdk' | 'cli', repos: string[], counts: { active, queued, done, blocked, failed, cancelled }, active: ActiveJob[] }`. `ActiveJob = Job & { phase: { name, attempt, startedAt } | null, elapsedMs, feed: string[] }` où `feed` = 30 dernières lignes de `summarizeTranscript` du transcript le plus récent du job.
- `/api/jobs?state=<état>&repo=<owner/repo>&limit=<n>` (défaut 100, max 500) → `{ jobs: Job[] }` triés du plus récent au plus ancien (`created_at` desc).
- `/api/jobs/:id` → `{ job, phases: Phase[], issueUrl, files: string[], transcript: { phase, attempt, lines: string[] } | null (résumé du transcript le plus récent, 400 lignes max), verify: { name, tail: string[] }[] (40 dernières lignes de chaque `setup.log`/`verify-*.log`), diff: { additions, deletions, bytes } | null, secrets: { file, ruleId, line }[] }`. 404 si l'id est inconnu ; l'id accepte un préfixe non ambigu (réutiliser `resolveJob`).
- `/api/report?since=<7d|24h|ISO>` (défaut 30d) → `ReportStats & { perDay: { day: 'YYYY-MM-DD', jobs, costUsd, done, failed, blocked }[] }` calculé sur les jobs depuis `since` (jour local).
- `/api/events` → SSE, `event: snapshot`, `data: <JSON de /api/overview>` toutes les 2 s ; premier événement immédiat ; `retry: 2000`.
- Toute autre route → 404 JSON. Erreur interne → 500 JSON `{ error }` sans stack.

## 4. Sécurité et limites

- Lecture seule stricte : la connexion SQLite est `readOnly`, aucune écriture fichier, aucun appel sortant. Le serveur n'écoute que sur l'interface locale ; un `--host` n'existe pas.
- Les transcripts peuvent contenir du texte contrôlé par l'auteur d'une issue : ils passent par `summarizeTranscript` (déjà borné et nettoyé par `safeText`) et sont injectés en texte. `gitleaks.json` n'est rendu que par `fichier · règle · ligne`, jamais `Match` ni `Secret`.
- Les fichiers de job sont lus avec un plafond (`tail` de `src/util/text.ts`) ; un dossier absent donne des listes vides, pas une erreur.
- Non couvert en v1 : actions (annuler, relancer, lancer un cycle), multi-utilisateur, accès distant, historique des rapports.

## 5. Tests

Unitaires sur la couche de données (`src/ui/data.ts`) avec la base en mémoire et un dossier de job semé ; tests du serveur (`src/ui/server.ts`) sur un port éphémère avec `fetch` : codes, JSON, en-têtes de sécurité, premier événement SSE, 404 et préfixe ambigu, refus d'un port occupé, et un test qui vérifie que la page HTML ne contient aucune interpolation de donnée côté serveur (la page est statique, les données arrivent par l'API).
