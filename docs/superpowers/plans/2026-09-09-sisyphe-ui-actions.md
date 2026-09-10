# Sisyphe UI v2 (actions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** piloter Sisyphe depuis l'UI locale : annuler, relancer, créer un job, poll immédiat, pause/reprise, arrêt et démarrage du daemon.

**Architecture:** le daemon reste le seul écrivain de la base et exécute toutes les actions ; il expose une socket UNIX de contrôle (`<dataDir>/control.sock`, une ligne JSON par requête) ; l'UI relaie des `POST /api/actions/<name>` vers cette socket via un client TS, et lance elle-même `sisyphe start` pour l'action Démarrer. Spec : `docs/superpowers/specs/2026-09-09-sisyphe-ui-actions-design.md`.

**Tech Stack:** Node 24+ (`node:net` pour la socket, `node:http`, `node:sqlite`), TypeScript strict ESM, vitest, HTML/CSS/JS vanilla embarqués. Aucune dépendance ajoutée.

Ce plan décrit des contrats et des tests, pas du code verbatim : l'implémenteur écrit le code en TDD en s'appuyant sur les modules existants nommés ci-dessous. Chaque tâche finit par `npm test`, `npx tsc --noEmit` et un commit.

---

### Task 1 : `addTriggerLabel` et journal des actions

**Files:**
- Modify: `src/github/source.ts` (interface), `src/github/client.ts` (+ test), `test/fakes/fake-issue-source.ts` (+ test)
- Modify: `src/store/db.ts` (migration 2), `src/store/store.test.ts`
- Create: `src/store/actions.ts`, `src/store/actions.test.ts`

- [ ] **Step 1 : `IssueSource.addTriggerLabel(ref)`**. GitHub : `issues.addLabels` avec `[triggerLabel]` via `this.call`, en passant par le même chemin de retry que `removeLabel` (idempotent côté GitHub). Fake : ajoute le label s'il manque, pousse `'addTriggerLabel'` dans `calls`, et pose `labeledBy = 'sisyphe[bot]'` pour refléter ce que verrait `canTrigger`. Tests : client (payload envoyé), fake (label présent après appel, idempotent).
- [ ] **Step 2 : migration 2** dans `MIGRATIONS` (append-only) : table `actions (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('ui','cli')), job_id TEXT, repo TEXT, issue_number INTEGER, outcome TEXT NOT NULL CHECK (outcome IN ('ok','error')), error TEXT)`, index `actions_at ON actions(at)` et `actions_job ON actions(job_id)`. Test : `user_version` passe à 2 sur une base existante en version 1 sans toucher aux tables `jobs`/`phases` ; le test « fige le littéral des énumérations » couvre les deux nouveaux CHECK.
- [ ] **Step 3 : `ActionStore(db)`** : `record({ action, source, jobId?, repo?, issueNumber?, outcome, error? }): ActionRow` (horodatage `new Date().toISOString()` injectable via `now`), `listRecent(limit): ActionRow[]` (desc, plafond 200), `listForJob(jobId): ActionRow[]` (asc). Type exporté `ActionName = 'cancel' | 'retry' | 'enqueue' | 'poll' | 'pause' | 'resume' | 'stop' | 'start'` et `ActionRow` en camelCase. Tests sur base mémoire.
- [ ] **Step 4 :** `npm test`, `npx tsc --noEmit`, commit `feat(store): actions journal and addTriggerLabel`.

### Task 2 : commandes dans le `Daemon`

**Files:**
- Modify: `src/daemon/daemon.ts`, `src/daemon/daemon.test.ts` (ou le fichier de tests existant du daemon ; réutiliser `test/helpers/harness.ts`, `FakeIssueSource`, `ScriptedAgentRunner`)
- Modify: `src/jobs/pipeline.ts` (`PipelineDeps.actions: ActionStore`), `src/app.ts` (construction de `ActionStore`), `test/helpers/harness.ts`

- [ ] **Step 1 : porte de sérialisation.** Remplacer le booléen `ticking` par une petite file `serial<T>(fn: () => Promise<T>): Promise<T>` (promesse chaînée : chaque appel attend le précédent). `tick()` et chaque commande passent par `serial`. Ajouter `tickRequested`: `requestTick()` déclenche `tick()` tout de suite via `serial` (donc après le tick en cours s'il y en a un) et renvoie la promesse du tick.
- [ ] **Step 2 : `paused`.** Champ privé + `pause(): DaemonStatus`, `resume(): DaemonStatus`, `status(): DaemonStatus` où `DaemonStatus = { pid, paused, running, queued, startedAt }`. `startNext()` renvoie `null` quand `paused` ; `resume()` enchaîne un `requestTick()` (sans l'attendre) pour démarrer les jobs en file tout de suite. `watchCancellations`, `trackPullRequests`, `pollOnce` ne regardent pas `paused`.
- [ ] **Step 3 : `cancelJob(jobId, source)`.** Sous `serial` : job introuvable ou terminal → `ok: false` avec message ; sinon `source.removeTriggerLabel`, puis `controller.abort(CANCELLED)` si `running.has(id)` sinon `store.transition(id, 'cancelled')` (relire l'état juste avant, comme dans `watchCancellations`). Journalise dans `actions` (`outcome` selon le résultat). Renvoie `CommandResult = { ok: true, result: Job } | { ok: false, error }`.
- [ ] **Step 4 : `retryJob(jobId, source)`** : job doit être `failed | blocked | cancelled`, aucun `findActiveByIssue` ; `store.create` avec le même repo/issue/titre, puis `source.addTriggerLabel` ; échec du label → `store.transition(newId, 'cancelled', { flags: { ...flags, earlyStop: 'label impossible : <message>' } })` et `ok: false`. Journalise (`jobId` = nouveau job).
- [ ] **Step 5 : `enqueueIssue({ repo, issueNumber }, source)`** : `repo` ∉ `machine.repos` → refus ; `source.getIssue` (erreur → refus avec message) ; issue `closed` → refus ; job actif → refus ; puis même séquence que `retryJob` avec le titre de l'issue.
- [ ] **Step 6 : tests** avec le harness : `pause` bloque le démarrage d'un job `queued` puis `resume` le libère ; `requestTick` pendant un tick lent (source dont `listCandidates` attend une promesse contrôlée) s'exécute après lui, une fois ; `cancelJob` sur un job en cours aborte le pipeline (état final `cancelled`, label retiré) et sur un `queued` le passe `cancelled` ; refus sur job terminal ; `retryJob` crée un job `queued`, remet le label, refuse si un job actif existe ou si l'état est `done` ; échec de label → nouveau job `cancelled` + `ok: false` ; `enqueueIssue` refuse repo inconnu, issue fermée, doublon ; chaque commande écrit une ligne `actions` avec la bonne `source`.
- [ ] **Step 7 :** `npm test`, `npx tsc --noEmit`, commit `feat(daemon): pause, immediate tick and job commands`.

### Task 3 : socket de contrôle, client, `sisyphe cancel`

**Files:**
- Create: `src/daemon/control.ts`, `src/daemon/control.test.ts`, `src/daemon/control-client.ts`, `src/daemon/control-client.test.ts`
- Modify: `src/config/paths.ts` (`controlSocketPath: join(root, 'control.sock')`), `src/daemon/daemon.ts` (`start()` ouvre, `stop()` ferme), `src/cli/commands/cancel.ts` (+ test)

- [ ] **Step 1 : serveur** `startControlServer({ path, daemon, log }): Promise<{ close(): Promise<void> }>` sur `node:net`. Supprime un fichier de socket existant avant `listen` (le verrou garantit l'absence d'autre daemon), `chmod 0600` après `listen`. Par connexion : accumule jusqu'au premier `\n` (max 64 Ko sinon réponse d'erreur et fermeture), `JSON.parse` en try, valide `{ cmd, source? }` avec zod (`source` défaut `'cli'`), route vers `daemon.status()` (`ping`), `daemon.requestTick()` (`poll`, répond `{ ok: true }` dès que le tick a démarré, sans attendre sa fin), `pause`, `resume`, `cancelJob`, `retryJob`, `enqueueIssue`, et `stop` (répond `{ ok: true }`, `end()`, puis `daemon.stop()` hors du gestionnaire ; le process sort via le chemin existant de `startCommand`). Toute exception → `{ ok: false, error: message }`. Un délai d'inactivité de 5 s ferme une connexion muette. `close()` ferme le serveur, détruit les connexions ouvertes et supprime le fichier.
- [ ] **Step 2 : client** `ControlClient(socketPath)` : `send<T>(cmd, args = {}, source: 'ui' | 'cli'): Promise<CommandResult<T>>`, timeout 30 s par défaut (une commande peut attendre la fin du tick en cours), 2 s pour `ping`/`isReachable()`, injectables ; `ENOENT`/`ECONNREFUSED`/timeout → `DaemonUnreachableError` ; réponse non JSON → `Error`. `isReachable()` = `ping` réussi. `stop` : la réponse arrive avant l'arrêt, ne pas attendre la fermeture du process.
- [ ] **Step 3 : câblage** : `Daemon.start()` ouvre la socket après `reconcile`/`ensureLabels` (chemin `paths.controlSocketPath`, désactivable par `opts.control: false` pour les tests qui n'en veulent pas) ; `stop()` la ferme en premier. `runOnce()` n'ouvre rien. `startCommand` : `stop` reçu par la socket suit le même chemin que SIGTERM (sortie 0 après `daemon.stop()`).
- [ ] **Step 4 : `sisyphe cancel`** : envoie `cancel` (`source: 'cli'`) directement et affiche la réponse ; repli sur le comportement actuel (retrait du label) uniquement sur `DaemonUnreachableError` (pas de `ping` préalable : un aller-retour de moins et pas de fenêtre entre le ping et la commande). Test avec un faux serveur de socket dans un `mkdtemp`.
- [ ] **Step 5 : tests** `control.test.ts` : socket dans un `mkdtemp` (chemin court : macOS limite à 104 octets, préférer `os.tmpdir()`), daemon réel sur fakes : `ping`, `pause`/`resume`, `poll` (le fake source voit un `listCandidates` de plus), `cancel`/`retry`/`enqueue` en succès et refus, requête non JSON, commande inconnue, requête trop longue, socket périmée remplacée, mode du fichier 0600, `close()` supprime le fichier. `control-client.test.ts` : socket absente → `DaemonUnreachableError`, serveur muet → timeout (utiliser un timeout court injecté).
- [ ] **Step 6 :** `npm test`, `npx tsc --noEmit`, commit `feat(daemon): unix control socket and client`.

### Task 4 : routes POST, anti-CSRF, démarrage et arrêt via le service

**Prérequis :** le plan `2026-09-10-sisyphe-install-service.md` est réalisé (`ServiceManager` dans `src/service/`, `sisyphe ui` autonome qui crée et migre la base).

**Files:**
- Create: `src/ui/actions.ts` (contrôleur des actions), `src/ui/actions.test.ts`
- Modify: `src/ui/server.ts` (+ test), `src/ui/data.ts` (+ test), `src/cli/commands/ui.ts` (+ test), `src/cli/index.ts` (`--read-only`)

- [ ] **Step 1 : `UiData.overview()`** ajoute `daemon.paused: boolean | null`, `control: { reachable: boolean }`, `readOnly: boolean`, `recentActions: ActionRow[]` (20) et `service: ServiceStatus` (remplace `launchd`). `UiDataDeps` gagne `actions: ActionStore`, `control: { ping(): Promise<DaemonStatus | null> }` (injectable ; l'implémentation réelle mémorise le résultat 1 s), `service: { status(): Promise<ServiceStatus> }` (injectable, mémorisé 5 s, remplace `launchd`) et `readOnly`. `jobDetail` ajoute `actions: ActionRow[]`.
- [ ] **Step 2 : contrôleur** `runAction(name, body, deps)` : valide `name` et le corps avec zod (`cancel`/`retry` : `{ jobId }` ; `enqueue` : `{ repo, issueNumber }` ; autres : `{}`). `start` → `service.start()` puis boucle `ping` toutes les 250 ms jusqu'à 5 s ; pas de réponse → `ok: false` avec la fin du log du service (`launchd.err.log`, `journalctl --user -u sisyphe -n 20` ou `daemon-stdout.log` selon `service.kind`). `stop` → `service.stop()`. Autres → `client.send(name, args, 'ui')`. Traduction : succès → `200 { ok: true, result }` ; `ok: false` → `409` ; `DaemonUnreachableError` → `502` ; zod → `400` ; autre → `500`.
- [ ] **Step 3 : serveur** : accepter `POST` uniquement sur `/api/actions/<name>` ; refus `403` si `readOnly`, si `content-type` ne commence pas par `application/json`, si `x-sisyphe-action !== '1'`, ou si `origin` est présent et n'est pas `http://127.0.0.1:<port>`, `http://localhost:<port>`, `http://[::1]:<port>` ; corps lu avec plafond 16 Ko (413 au-delà). Les autres méthodes non GET restent en 405 avec `Allow: GET, POST` sur cette route.
- [ ] **Step 4 : CLI** : option `--read-only` sur `ui` ; `uiCommand` construit `ActionStore`, `ControlClient(paths.controlSocketPath)`, `createServiceManager(...)` et passe `readOnly`. Message de démarrage : « Sisyphe UI : http://… » (« lecture seule » seulement avec l'option).
- [ ] **Step 5 : tests** : `actions.test.ts` (traduction des codes, validation, `start` avec un service factice et un `ping` qui répond au troisième essai, `start` qui n'aboutit pas → 409 avec le log) ; `server.test.ts` (chaque route POST avec un client et un service factices : 200, 409, 502 ; 403 pour chaque en-tête manquant et pour `Origin` étranger ; 403 en `readOnly` ; 400 corps invalide ; 413 ; overview enrichie) ; `data.test.ts` (nouveaux champs, `paused: null` quand injoignable, `service` injecté).
- [ ] **Step 6 :** `npm test`, `npx tsc --noEmit`, commit `feat(ui): action routes, csrf guards and service start/stop`.

### Task 5 : page, vérification manuelle, docs

**Files:**
- Modify: `src/ui/page.ts`, `src/ui/page.test.ts`, `docs/ui/*.png`, `README.md`, `docs/playground.md` (§ commandes), `docs/superpowers/specs/2026-09-08-sisyphe-design.md` (ligne `ui`, mention de la socket de contrôle), `docs/superpowers/specs/2026-09-09-sisyphe-ui-design.md` (note « v2 : voir …-ui-actions-design.md »)

- [ ] **Step 1 : page** : `api(name, body)` = `fetch('/api/actions/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sisyphe-Action': '1' }, credentials: 'omit', body })` qui renvoie `{ ok, result | error }` quel que soit le code. Bandeau système : `service.kind` et « au boot : oui/non », Démarrer (visible quand `!service.running && !control.reachable`), Arrêter, Pause/Reprendre (libellé selon `daemon.paused`), Poll maintenant ; bandeau orange « En pause » ; boutons `disabled` + `title="daemon arrêté"` quand injoignable ; tout masqué si `readOnly`. Cartes actives, lignes du tableau et panneau de détail : Annuler (non terminal) / Relancer (`failed`, `blocked`, `cancelled`). Formulaire « Nouveau job » (select repos + `<input type=number min=1>`) en tête de l'onglet Jobs. `confirm()` avant Annuler, Relancer, Arrêter ; bouton désactivé pendant l'appel ; toasts (succès 4 s, erreur 8 s avec le message). Bloc « Dernières actions » (tableau de bord) et liste des actions dans le détail. Toujours `textContent` / `createElement`.
- [ ] **Step 2 : tests page** : boutons et formulaire présents (`data-action="cancel"`, etc.), `X-Sisyphe-Action` dans le script, `credentials: 'omit'`, toujours zéro `innerHTML`.
- [ ] **Step 3 : vérification manuelle** : `npm run build`, `sisyphe ui` contre la base réelle avec le daemon éteint (Démarrer visible) puis allumé (pause, poll, annulation sur un job de test si disponible, arrêt) ; `sisyphe ui --read-only` sans aucun bouton ; captures mises à jour dans `docs/ui/`.
- [ ] **Step 4 : docs** puis `npm test`, commit `feat(ui): action buttons, new job form, actions journal`.

## Auto-revue du plan

- Couverture spec : §2.1 (Task 2 + 3), §2.2 (Task 3), §2.3 (remplacé par le plan install-service, utilisé en Task 4 Step 2), §2.4 (Task 1), §2.5 (Task 4), §2.6 (Task 5), §4 tests répartis par tâche.
- Noms cohérents : `ActionStore`/`ActionRow`/`ActionName` (Task 1) utilisés en Tasks 2, 4, 5 ; `DaemonStatus`, `CommandResult` (Task 2) utilisés en Tasks 3, 4 ; `ControlClient`, `DaemonUnreachableError` (Task 3) utilisés en Task 4 ; `paths.controlSocketPath` (Task 3) utilisé en Task 4.
