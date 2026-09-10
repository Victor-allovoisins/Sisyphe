# Sisyphe UI v2 : actions depuis l'interface locale

Validé le 2026-09-09 avec Victor. Complète `2026-09-09-sisyphe-ui-design.md` (UI v1, lecture seule) et `2026-09-08-sisyphe-design.md`.

## 1. Objectif

Piloter Sisyphe depuis l'interface locale sans passer par le terminal : annuler un job, relancer un job terminé, créer un job à partir d'une issue, déclencher un cycle de poll, mettre le daemon en pause, l'arrêter et le démarrer. L'interface reste locale (127.0.0.1) et sans authentification ; la base SQLite reste écrite par le daemon seul.

## 2. Architecture : le daemon est le seul écrivain, l'UI est un client

Le daemon ouvre une **socket UNIX de contrôle** et exécute lui-même toutes les actions, en série avec ses cycles. L'UI relaie les clics vers cette socket. Daemon arrêté : seule l'action « Démarrer » est disponible, le reste est grisé.

### 2.1 Socket de contrôle (`src/daemon/control.ts`)

- Chemin : `<dataDir>/control.sock`, mode 0600, propriétaire uniquement. Créée par `daemon.start()` après le verrou `daemon.lock`, supprimée par `daemon.stop()`. Au démarrage, un fichier de socket déjà présent est considéré périmé (le verrou garantit qu'aucun autre daemon ne tourne) et remplacé.
- Protocole : une connexion = une requête = une ligne JSON `{ "cmd": string, ...args }`, une réponse = une ligne JSON `{ "ok": true, "result": ... }` ou `{ "ok": false, "error": string }`, puis fermeture. Requête non JSON, commande inconnue ou arguments invalides → `ok: false`, jamais d'exception non rattrapée. Une requête de plus de 64 Ko est rejetée.
- Commandes :
  - `ping` → `{ pid, paused, running: number, queued: number, startedAt }`.
  - `poll` → déclenche un tick immédiatement ; si un tick est en cours, un second s'enchaîne dès la fin du premier (drapeau `tickRequested`). Répond dès que le tick a démarré.
  - `pause` / `resume` → bascule `paused` ; renvoie l'état résultant. Idempotent.
  - `stop` → répond `{ ok: true }` puis appelle `daemon.stop()` (grâce de 30 s existante) et le process sort.
  - `cancel { jobId }` → le job doit exister et ne pas être terminal (sinon `ok: false`). Retire le label trigger via `source.removeTriggerLabel`, puis : job en cours → `controller.abort(CANCELLED)` ; job `queued` → `store.transition(id, 'cancelled')`. Renvoie le job mis à jour.
  - `retry { jobId }` → le job doit être `failed`, `blocked` ou `cancelled` et l'issue ne doit avoir aucun job actif (sinon `ok: false`). Crée un nouveau job `queued` (`store.create`) **avant** de remettre le label (`source.addTriggerLabel`), pour que le poll ne voie jamais un label sans job. Si la pose du label échoue, le nouveau job passe `cancelled` avec `flags.earlyStop = 'label impossible : <message>'` et la commande renvoie `ok: false`. Renvoie le nouveau job.
  - `enqueue { repo, issueNumber }` → `repo` doit figurer dans `machine.repos`, l'issue doit exister et être ouverte (`source.getIssue`), aucun job actif sur l'issue. Même séquence que `retry` : création puis label. Pas de `canTrigger` : l'opérateur local est de confiance.
- `IssueSource` gagne `addTriggerLabel(ref)` (implémentation GitHub `issues.addLabels`, et `FakeIssueSource`), symétrique de `removeTriggerLabel`.
- Sérialisation : chaque commande passe par la même porte que le tick (`ticking`) : une commande attend la fin du tick en cours et le tick attend la fin de la commande. Ainsi ni le poll ni `watchCancellations` ne s'intercalent entre la création d'un job et la pose de son label.
- `paused` : quand vrai, `startNext()` ne démarre rien ; `pollOnce`, `watchCancellations`, `trackPullRequests` et les jobs en cours continuent. L'état est en mémoire : un redémarrage repart actif.
- Journal : chaque commande qui modifie quelque chose (`cancel`, `retry`, `enqueue`, `pause`, `resume`, `stop`, `poll`) est enregistrée dans la table `actions` (§ 2.4) avec son résultat.

### 2.2 Client (`src/daemon/control-client.ts`)

`ControlClient(paths)` : `send(cmd, args)` ouvre la socket, envoie la ligne, lit la réponse, ferme ; timeout 5 s ; socket absente ou connexion refusée → erreur typée `DaemonUnreachableError`. `isReachable()` = `ping` réussi. Utilisé par l'UI et par `sisyphe cancel` : si le daemon répond, la commande passe par la socket (annulation immédiate et journalisée) ; sinon comportement actuel (retrait du label, annulation au prochain démarrage).

### 2.3 Démarrage et arrêt du daemon depuis l'UI

Remplacé le 2026-09-10 par `2026-09-10-sisyphe-install-service-design.md` §3 à §5 : Démarrer et Arrêter passent par le `ServiceManager` (launchd, systemd, ou lancement détaché quand aucun service n'est installé), pour que le daemon survive à l'interface et revienne au boot dans l'état choisi. Après `start()`, l'UI attend jusqu'à 5 s que la socket réponde ; sinon `ok: false` avec la fin du log du service.

### 2.4 Données

- Migration 2 (append-only dans `src/store/db.ts`) : table `actions (id INTEGER PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, source TEXT NOT NULL CHECK (source IN ('ui','cli')), job_id TEXT, repo TEXT, issue_number INTEGER, outcome TEXT NOT NULL CHECK (outcome IN ('ok','error')), error TEXT)` avec un index sur `at` et un sur `job_id`. `ActionStore` : `record(...)`, `listRecent(limit)`, `listForJob(jobId)`.
- La base ouverte par l'UI reste `readOnly` : elle lit `actions` comme le reste.
- Le champ `source` est fourni par l'appelant dans la requête (`{ cmd, source: 'ui' | 'cli' }`), défaut `cli`.

### 2.5 API HTTP (`src/ui/server.ts`)

- `POST /api/actions/<name>` avec `name ∈ cancel | retry | enqueue | poll | pause | resume | stop | start`, corps JSON (`{ jobId }`, `{ repo, issueNumber }` ou `{}`), réponse `200 { ok: true, result }`, `400` arguments invalides, `403` en-têtes anti-CSRF absents ou mode `--read-only`, `409` refus métier (`ok: false` du daemon, message relayé), `502` daemon injoignable (`DaemonUnreachableError`), `500` autre erreur sans stack.
- Anti-CSRF (Host déjà vérifié en v1) : `Content-Type: application/json` obligatoire, en-tête `X-Sisyphe-Action: 1` obligatoire (un formulaire HTML ne peut envoyer ni l'un ni l'autre sans CORS préalable), et si `Origin` est présent il doit valoir `http://127.0.0.1:<port>`, `http://localhost:<port>` ou `http://[::1]:<port>`. Corps limité à 16 Ko.
- `GET /api/overview` gagne `daemon.paused: boolean | null` (null si injoignable), `control: { reachable: boolean }`, `readOnly: boolean`, `recentActions: Action[]` (20 dernières) et `service: ServiceStatus` (remplace `launchd`). `GET /api/jobs/:id` gagne `actions: Action[]`.
- Les autres GET et le SSE sont inchangés ; le `ping` de l'overview est mémorisé 1 s pour ne pas ouvrir une connexion par requête SSE.
- `sisyphe ui --read-only` : `readOnly: true` dans l'overview, tout POST → 403, aucun bouton affiché.
- Base absente ou non migrée : `uiCommand` la crée et la migre en l'ouvrant une fois en écriture, puis la rouvre en `readOnly` (spec install-service §4) ; l'interface reste en lecture seule ensuite.

### 2.6 Page (`src/ui/page.ts`)

- Bandeau système : `service.kind` et « au boot : oui/non », boutons Démarrer / Arrêter / Pause ou Reprendre / Poll maintenant. Bandeau orange « En pause » quand `daemon.paused`. Daemon injoignable : seul Démarrer est actif, les autres boutons grisés avec `title="daemon arrêté"`.
- Cartes des jobs actifs, tableau Jobs et panneau de détail : bouton Annuler sur un job non terminal ; bouton Relancer sur `failed`, `blocked`, `cancelled`. Formulaire « Nouveau job » en tête de l'onglet Jobs : `<select>` des repos (issus de l'overview) + champ numérique, bouton Créer.
- `confirm()` natif avant Annuler, Relancer, Arrêter. Bouton désactivé pendant l'appel. Toast en bas à droite : succès (vert, 4 s) ou erreur (rouge, message relayé, 8 s). Rafraîchissement par le SSE existant et un `fetch` de la vue courante après succès.
- Bloc « Dernières actions » sur le tableau de bord (heure, action, job ou repo#issue, résultat) ; liste des actions dans le détail d'un job.
- Toujours `textContent` / `createElement`, jamais `innerHTML` ; `fetch` avec les deux en-têtes requis, `credentials: 'omit'`.

## 3. Sécurité et limites

- La socket est dans `dataDir` en 0600 : seul le compte local peut commander le daemon, comme pour la base. Aucune écoute réseau supplémentaire.
- `retry` et `enqueue` contournent `canTrigger` volontairement : c'est l'opérateur de la machine qui agit, pas un tiers via GitHub. Le label est tout de même posé pour que le balayage d'annulation et les autres outils voient un état cohérent.
- Non couvert : accès distant, multi-utilisateur, reprise de l'état `paused` après redémarrage, actions groupées.

## 4. Tests

- `control.test.ts` : serveur sur socket temporaire avec fakes (store en mémoire, `FakeIssueSource`) : chaque commande en succès et en refus (job terminal pour `cancel`, job actif pour `retry`, repo hors config pour `enqueue`, issue fermée), échec de pose de label → job `cancelled` + `ok: false`, requête non JSON, commande inconnue, socket périmée remplacée, sérialisation avec le tick (une commande lancée pendant un tick attend sa fin), `paused` bloque `startNext`, journal `actions` rempli.
- `control-client.test.ts` : timeout, socket absente → `DaemonUnreachableError`.
- `server.test.ts` : chaque route POST avec un client factice (200, 409 relayé, 502), 403 sans `X-Sisyphe-Action`, sans `Content-Type` JSON, avec `Origin` étranger, en `--read-only` ; 400 corps invalide ; overview enrichie.
- `page.test.ts` : présence des boutons et du formulaire, zéro `innerHTML`, en-tête `X-Sisyphe-Action` dans le script.
- `spawn-daemon.test.ts` : refus si verrou vivant ; attente de `ping` bornée (faux binaire).
- `cancel` CLI : passe par la socket quand `ping` répond, repli sinon.
