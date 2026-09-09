# Sisyphe UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `sisyphe ui` sert une interface web locale en lecture seule : tableau de bord temps réel, historique des jobs avec détail, KPIs.

**Architecture:** couche de données pure (`src/ui/data.ts`) au-dessus de la SQLite en lecture seule et des dossiers de jobs ; serveur `node:http` (`src/ui/server.ts`) avec routes JSON, SSE et une page HTML embarquée (`src/ui/page.ts`) ; commande CLI `ui`. Spec : `docs/superpowers/specs/2026-09-09-sisyphe-ui-design.md`.

**Tech Stack:** Node 24+ (`node:http`, `node:sqlite` readOnly), TypeScript strict ESM, vitest, HTML/CSS/JS vanilla embarqués. Aucune dépendance ajoutée.

Ce plan décrit des contrats et des tests, pas du code verbatim : l'implémenteur écrit le code en TDD en s'appuyant sur les modules existants nommés ci-dessous.

---

### Task 1 : couche de données `src/ui/data.ts`

**Files:**
- Create: `src/ui/data.ts`, `src/ui/data.test.ts`

Réutiliser : `JobStore` et `PhaseStore` (`src/store/jobs.ts`, `src/store/phases.ts`, `costSince`), `startOfLocalDay` (`src/jobs/scheduler.ts`), `summarizeTranscript` (`src/cli/format.ts`), `parseGitleaksReport` (`src/verify/secrets.ts`), `tail` (`src/util/text.ts`), `jobDir` (`src/config/paths.ts`), `buildReport`/`parseSince` (`src/report/report.ts`), `resolveJob` (`src/cli/resolve-job.ts`), le parsing de `launchctl print` déjà écrit dans `src/cli/commands/doctor.ts` (extraire une fonction pure réutilisable si elle ne l'est pas), la lecture du pid dans `daemon.lock` (`src/daemon/lock.ts` : exporter une fonction `readLock(paths): { pid, alive } | null` si absente).

- [ ] **Step 1 : tests** (`data.test.ts`, base en mémoire via `openDatabase(':memory:')`, dossier de job semé dans un `mkdtemp`) :
  - `overview()` : `daemon.running` faux sans fichier de verrou, vrai avec un verrou portant le pid courant, faux avec un pid mort ; `budget.spentTodayUsd` égal à la somme des phases terminées aujourd'hui ; `counts` par état ; `active` contient les jobs non terminaux avec `phase` (dernière phase ouverte) et `feed` (30 dernières lignes résumées du transcript le plus récent) ; `launchd` injectable (fonction passée en option) pour ne jamais appeler `launchctl` dans les tests.
  - `listJobs({ state, repo, limit })` : filtres, tri décroissant, plafond 500.
  - `jobDetail(idOrPrefix)` : phases, `files`, `transcript` (résumé plafonné à 400 lignes), `verify` (tail 40 lignes de `setup.log` et `verify-*.log`), `diff` (+/- et octets depuis `diff.patch`), `secrets` (fichier · règle · ligne depuis `gitleaks.json`, jamais `Match`/`Secret`) ; dossier absent → listes vides ; id inconnu → `null` ; préfixe ambigu → erreur explicite.
  - `report(since)` : `ReportStats` + `perDay` (regroupement par jour local sur `createdAt`).
- [ ] **Step 2 : implémentation** en fonctions pures prenant `{ store, phases, paths, machine, launchd?, now? }`.
- [ ] **Step 3 : `npm test`, `npx tsc --noEmit`, commit** `feat(ui): read-only data layer`.

### Task 2 : serveur `src/ui/server.ts`

**Files:**
- Create: `src/ui/server.ts`, `src/ui/server.test.ts`

- [ ] **Step 1 : tests** (serveur démarré sur le port 0, base en mémoire, `fetch`) : `GET /` renvoie `text/html` avec les en-têtes CSP, nosniff, no-store ; `/api/overview`, `/api/jobs?state=done`, `/api/jobs/:id` (200, 404, 409 sur préfixe ambigu), `/api/report?since=7d` (400 sur `since` invalide) ; `/api/events` renvoie `text/event-stream` et un premier `event: snapshot` en moins d'une seconde ; route inconnue → 404 JSON ; méthode non GET → 405 ; démarrage sur un port occupé → rejet avec un message clair ; `close()` ferme aussi les connexions SSE ouvertes.
- [ ] **Step 2 : implémentation** : `startUiServer({ data, page, port, host: '127.0.0.1', intervalMs = 2000 })` → `{ port, close() }`. Routage sans dépendance (`new URL(req.url, 'http://localhost')`). Erreurs → 500 JSON sans stack, journalisées via pino si un logger est fourni. Le SSE envoie `retry: 2000`, un snapshot immédiat puis un par intervalle ; timer `unref` ; un ensemble de réponses ouvertes fermé par `close()`.
- [ ] **Step 3 : `npm test`, `npx tsc --noEmit`, commit** `feat(ui): local http server with json api and sse`.

### Task 3 : page `src/ui/page.ts`

**Files:**
- Create: `src/ui/page.ts`, `src/ui/page.test.ts`

- [ ] **Step 1 : tests** : la chaîne exportée `PAGE_HTML` contient `<!doctype html>`, un `<title>Sisyphe</title>`, aucun `${` ni `innerHTML` avec une variable (vérifier que toute occurrence de `innerHTML` est absente ou n'affecte que des littéraux), et référence les trois onglets et l'`EventSource('/api/events')`.
- [ ] **Step 2 : implémentation** : une page, trois onglets (Tableau de bord, Jobs, KPIs) et un panneau de détail. Tableau de bord : bandeau système (daemon, launchd, backend, repos), jauge du budget du jour, cartes des jobs actifs avec phase, temps écoulé, coût, et fil des actions (défilement automatique en bas). Jobs : filtres repo/état, tableau (état coloré, repo#issue lien, titre, coût, durée, tentatives, PR lien) ; clic → détail (phases, transcript résumé, sortie de vérification, diff, secrets, erreur). KPIs : chiffres du rapport avec sélecteur de période (7d, 30d, 90d), graphe SVG en barres par jour (jobs) avec une seconde série (coût). Rendu uniquement via `textContent`/`createElement` ; liens vérifiés (`https://github.com/`). Fond sombre, couleurs d'état comme les labels GitHub, lisible de loin (chiffres clés ≥ 32 px). Rafraîchissement : SSE pour le tableau de bord, `fetch` pour Jobs, KPIs et détail ; bouton « Actualiser » sur Jobs.
- [ ] **Step 3 : vérification manuelle** : `node dist/cli/index.js ui` contre la base réelle (lecture seule), captures d'écran des trois onglets ajoutées à `docs/ui/` (PNG, poids raisonnable), `npm test`, commit `feat(ui): single-page dashboard`.

### Task 4 : commande CLI et docs

**Files:**
- Create: `src/cli/commands/ui.ts`
- Modify: `src/cli/index.ts`, `README.md`, `docs/playground.md` (§ commandes), `docs/superpowers/specs/2026-09-08-sisyphe-design.md` (liste des commandes, une ligne)

- [ ] **Step 1** : `uiCommand({ port })` : charge la config machine et `dataPaths`, ouvre la base en `readOnly` (erreur claire si absente : « aucune base, lancer sisyphe start une fois »), construit `data`, démarre le serveur, affiche l'URL, gère SIGINT/SIGTERM (fermeture propre). Pas de `createApp` (pas de client GitHub ni d'agent).
- [ ] **Step 2** : enregistrement dans `index.ts` (`ui --port <n>`), docs, `npm run build`, `node dist/cli/index.js ui --help`, commit `feat(cli): sisyphe ui command`.
