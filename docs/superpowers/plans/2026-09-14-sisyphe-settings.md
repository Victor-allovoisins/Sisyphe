# Sisyphe Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** régler Sisyphe depuis son interface locale (configuration machine, diagnostic, disque, environnement, dépôts), rendre le budget facultatif, et supprimer le clone de travail d'un job en échec.

**Architecture:** l'interface écrit `config.yml` elle-même (écriture atomique validée, sauvegarde `.bak`) parce que la configuration doit être modifiable daemon arrêté ; une commande `reload` sur la socket fait relire le fichier au daemon, qui applique à chaud le budget, la concurrence et l'intervalle, et signale le reste comme exigeant un redémarrage ; quatre blocs d'information calculés à la demande et mémorisés 30 s ; un quatrième onglet dans la page embarquée. Spec : `docs/superpowers/specs/2026-09-14-sisyphe-settings-design.md`.

**Tech Stack:** Node 24+, TypeScript strict ESM, zod, yaml, vitest, HTML/CSS/JS vanilla embarqués. Aucune dépendance ajoutée.

Ce plan décrit des contrats et des tests, pas du code verbatim : l'implémenteur écrit le code en TDD en s'appuyant sur les modules nommés. Chaque tâche finit par `npm test`, `npx tsc --noEmit` et un commit.

---

### Task 1 : budget facultatif et nettoyage du worktree en échec

**Files:**
- Modify: `src/config/machine.ts` (+ test), `src/jobs/scheduler.ts` (+ test), `src/daemon/daemon.ts`, `src/jobs/pipeline.ts`, `test/integration/pipeline.test.ts`

- [ ] **Step 1 : budget optionnel.** `dailyBudgetUsd` devient `z.number().positive().max(1000).optional()`. Pour ne rien désactiver en silence, la résolution se fait après le parse : champ absent et `agentBackend === 'sdk'` → 60 ; absent et `cli` → `undefined` (aucun plafond) ; valeur présente → conservée. `MachineConfig['dailyBudgetUsd']` devient `number | undefined`. Tests : les trois cas, plus une valeur explicite à 0 refusée par `positive()`.
- [ ] **Step 2 : `canStartJob` sans plafond.** Quand `dailyBudgetUsd` est `undefined`, aucune vérification de budget et jamais `reason: 'budget'`. Test : dépense très supérieure à tout plafond, `ok: true`.
- [ ] **Step 3 : pas de commentaire de pause sans plafond.** `Daemon.announceBudgetPause` n'est atteignable que par `reason: 'budget'`, donc rien à changer dans son corps ; ajouter un test qui le prouve (config sans plafond, job en file, dépense élevée : le job démarre et aucun commentaire n'est posté).
- [ ] **Step 4 : worktree supprimé en cas d'échec.** Dans `runJob`, appeler `cleanup()` sur les trois chemins qui ne le font pas : l'échec de vérification après ouverture de PR (aujourd'hui `if (final === 'done') await cleanup();`), la détection de secrets, et le `catch` final non annulé. Le dossier `jobs/<id>/` n'est pas touché. Tests : pour chacun des trois chemins, le dossier du worktree n'existe plus et le dossier de job existe toujours.
- [ ] **Step 5 :** `npm test`, `npx tsc --noEmit`, commit `feat(config): optional daily budget, always clean the worktree`.

### Task 2 : écriture de la configuration

**Files:**
- Create: `src/config/write.ts`, `src/config/write.test.ts`

Réutiliser : `MachineConfigSchema`, `MachineConfigError` (`src/config/machine.ts`), `machineConfigPath` (`src/config/paths.ts`), `stringify` de `yaml`, `write0600` (`src/service/files.ts`).

- [ ] **Step 1 : validation.** `validateMachineConfigInput(raw: unknown, current: MachineConfig): { ok: true; config: MachineConfig } | { ok: false; issues: { path: string; message: string }[] }`. Applique `MachineConfigSchema`, puis deux règles supplémentaires : `dataDir` doit être identique à celui de `current` (sinon une issue sur `dataDir` : « non modifiable depuis l'interface, utiliser sisyphe setup »), et `github.privateKeyPath` doit pointer sur un fichier lisible (`access(path, R_OK)`), sinon une issue sur ce champ. Les messages de zod sont repris tels quels, chemin par chemin.
- [ ] **Step 2 : écriture atomique.** `writeMachineConfig(path: string, config: MachineConfig): Promise<void>` : si le fichier existe, le copier en `<path>.bak` (0600) ; sérialiser en YAML ; écrire dans `<path>.tmp-<pid>` du même dossier en 0600 ; `rename`. Le chemin de la clé est écrit tel qu'il a été fourni, sans expansion de `~`, pour rester lisible.
- [ ] **Step 3 : tests** dans un `mkdtemp` : config valide écrite puis relue à l'identique par `loadMachineConfig` ; `.bak` créé et contenant l'ancienne version ; mode 0600 sur les deux ; `dataDir` modifié → refus ; clé illisible → refus ; YAML relu par `parseMachineConfig` sans perte ; aucun fichier temporaire résiduel.
- [ ] **Step 4 :** `npm test`, `npx tsc --noEmit`, commit `feat(config): validated atomic config writer`.

### Task 3 : commande `reload` du daemon

**Files:**
- Modify: `src/daemon/daemon.ts` (+ test dans `test/integration/daemon-commands.test.ts`), `src/daemon/control-types.ts`, `src/daemon/control.ts` (+ test), `src/store/actions.ts`

- [ ] **Step 1 : `ActionName`** gagne `settings`, `reload` et `purge`. La colonne `action` n'a aucune contrainte SQL : aucune migration. Test : les trois valeurs s'enregistrent et se relisent.
- [ ] **Step 2 : `Daemon.reload(source)`** : relit `machineConfigPath()` avec `loadMachineConfig`. En cas d'erreur, renvoie `{ ok: false, error }` sans rien changer. Sinon compare champ à champ avec la configuration courante et met à jour en place, sur `this.d.machine`, les seuls champs rechargeables : `dailyBudgetUsd`, `maxConcurrentJobs`, `pollIntervalSeconds` — ce dernier reprogramme le minuteur de poll (annuler l'ancien `setInterval`, en poser un nouveau, remplacer l'entrée dans `this.timers`). Renvoie `{ ok: true, result: { applied: string[], needsRestart: string[] } }` où `needsRestart` liste les champs structurels dont la valeur a changé (`github.appId`, `github.installationId`, `github.privateKeyPath`, `repos`, `triggerLabel`, `sandbox`, `agentBackend`, `dataDir`). Journalise l'action `reload`. Passe par la porte de sérialisation comme les autres commandes.
- [ ] **Step 3 : socket.** `reload` ajouté à `CONTROL_COMMANDS` et au schéma zod (aucun argument), routé vers `daemon.reload(source)`.
- [ ] **Step 4 : tests.** Avec le harness : un fichier de config écrit dans le dossier temporaire, `reload` applique un nouveau budget (un job qui était bloqué par le budget démarre ensuite), signale `repos` dans `needsRestart` sans le changer, et sur un YAML invalide renvoie une erreur en conservant la configuration précédente. Un test de socket vérifie le routage et la ligne de journal.
- [ ] **Step 5 :** `npm test`, `npx tsc --noEmit`, commit `feat(daemon): reload command with hot and restart-required fields`.

### Task 4 : données de la page de réglages

**Files:**
- Create: `src/ui/settings.ts`, `src/ui/settings.test.ts`
- Modify: `src/ui/data.ts` (+ test)

Réutiliser : `buildChecks` et le rendu des contrôles (`src/cli/commands/doctor.ts`, `src/cli/checks.ts`) — extraire une fonction pure qui renvoie les contrôles sous forme de données plutôt que de les afficher, si ce n'est pas déjà le cas ; `dataPaths` ; `realExec`.

- [x] **Step 1 : `settingsView(configPath, paths)`** (et non `(machine, paths)` : une config déjà parsée a ses chemins développés, la page effacerait les `~` au premier enregistrement ; le fichier est relu par `parseMachineConfigAsWritten`) → `{ config, dataDir, hotReloadable, restartRequired }` où `config` est la configuration sérialisable telle qu'écrite (jamais de secret), `hotReloadable` et `restartRequired` les listes de noms de champs de la tâche 3. Test : aucun secret dans la sortie, les deux listes couvrent exactement les champs du schéma.
- [x] **Step 2 : `diagnostics(deps)`** → `{ checks: { name, status: 'ok' | 'warn' | 'fail', detail }[], versions: { sisyphe, node, claude, git, gitleaks }, paths: { config, data, socket, logs } }`. Les versions viennent d'un `exec` injectable (`--version`), une version illisible donne `null` plutôt qu'une erreur. Mémorisé 30 s avec une horloge injectable, la promesse en vol partagée. Test : une seule exécution pour deux appels concurrents, expiration après 30 s, outil absent → `null`.
- [x] **Step 3 : `diskUsage(paths)`** → `{ entries: { name, path, bytes }[], totalBytes }` pour `cache`, `mirrors`, `work`, `logs`, `jobs`. Parcours récursif avec `stat`, dossier absent → 0 octet, jamais d'exception. Mémorisé 30 s comme ci-dessus. Test sur une arborescence semée dans un `mkdtemp`, avec un dossier absent.
- [x] **Step 4 : `purgeCache(paths)`** → supprime le contenu de `cache/` sans supprimer le dossier, renvoie `{ freedBytes }` mesuré avant suppression. Test : contenu supprimé, dossier conservé, octets rendus cohérents.
- [x] **Step 5 :** `npm test`, `npx tsc --noEmit`, commit `feat(ui): settings data layer`.

### Task 5 : routes et contrôleur

**Files:**
- Modify: `src/ui/actions.ts` (+ test), `src/ui/server.ts` (+ test), `src/cli/commands/ui.ts`

- [ ] **Step 1 : routes GET.** `/api/settings` → `settingsView` plus `readOnly` ; `/api/diagnostics` → `diagnostics` ; `/api/disk` → `diskUsage`. Mêmes en-têtes et mêmes règles que les GET existantes.
- [ ] **Step 1bis : deux pièges à éviter.** Le fichier à écrire est `machineConfigPath()`, jamais un chemin sous `paths.root` : `config.yml` est ancré sur la racine par défaut, et écrire ailleurs produirait un fichier que le daemon ne lit jamais, avec une écriture et un rechargement qui se déclarent tous deux en succès. Par ailleurs, un champ structurel modifié est signalé à chaque rechargement tant que le daemon n'a pas redémarré, mais rien ne le rappelle une fois le bandeau écarté, et deux enregistrements rapprochés donnent un second bandeau vide : accumuler les champs en attente côté daemon et les exposer dans `status()` pour que la page puisse afficher un rappel persistant.
- [ ] **Step 2 : action `settings`.** Corps = la configuration complète. `validateMachineConfigInput` ; en cas de refus, `400` avec `{ error, issues }`. Sinon `writeMachineConfig`, puis, si la socket répond, `client.send('reload', {}, 'ui')` ; le résultat renvoyé est `{ applied, needsRestart }`, ou `{ applied: [], needsRestart: <tous les champs modifiés> }` quand le daemon est arrêté. Une erreur d'écriture donne `409`.
- [ ] **Step 3 : action `purge-cache`.** Refusée avec `409` quand un job est actif (`store.countByState().active > 0`) ; sinon `purgeCache` et `{ freedBytes }`. Journalisée par le daemon si la socket répond, sinon non journalisée — le dire dans le commentaire.
- [ ] **Step 4 : tests.** Chaque route GET (forme, absence de secret) ; l'action `settings` en succès, en refus de validation, daemon arrêté, et écriture impossible ; l'action `purge-cache` refusée pendant un job ; les deux actions refusées en lecture seule et sans les en-têtes anti-CSRF.
- [ ] **Step 5 :** `npm test`, `npx tsc --noEmit`, commit `feat(ui): settings, diagnostics and disk routes`.

### Task 6 : onglet Réglages

**Files:**
- Modify: `src/ui/page.ts`, `src/ui/page.test.ts`, `README.md`, `docs/playground.md`

- [ ] **Step 1 : onglet et formulaire.** Quatrième onglet « Réglages ». Champs groupés en Exécution (`pollIntervalSeconds`, `maxConcurrentJobs`, `dailyBudgetUsd` avec un champ vide valant « aucune limite »), Agent (`agentBackend`, `sandbox`), GitHub (`appId`, `installationId`, `privateKeyPath`, `triggerLabel`, `repos` en liste avec ajout et retrait). `dataDir` affiché désactivé avec la mention « se change par sisyphe setup ». Enregistrer inactif tant que rien n'a changé ; erreurs de validation affichées sous le champ concerné à partir de `issues`.
- [ ] **Step 2 : bandeau de redémarrage.** Après un enregistrement dont `needsRestart` n'est pas vide, un bandeau nomme les champs et propose Redémarrer, qui enchaîne les actions `stop` puis `start` existantes.
- [ ] **Step 3 : blocs.** Diagnostic (bouton Relancer, une ligne par contrôle avec sa pastille), Espace disque (une ligne par dossier, total, bouton Vider le cache de build avec `confirm()`), Environnement (versions et chemins), Dépôts (accès et validité du `sisyphe.yml`). Chargés au premier affichage de l'onglet, pas au chargement de la page.
- [ ] **Step 4 : lecture seule.** L'onglet reste consultable, tous les champs et boutons d'action désactivés ou masqués, comme le bandeau système.
- [ ] **Step 5 : tests page.** Présence de l'onglet, des champs, du bandeau, des quatre blocs ; désactivation complète en lecture seule ; toujours zéro `innerHTML` ; le corps du script se compile avec `new Function`.
- [ ] **Step 6 : vérification manuelle et docs.** `npm run build`, `sisyphe ui` : modifier l'intervalle, vérifier l'application à chaud, modifier le label, vérifier le bandeau de redémarrage, lancer le diagnostic, mesurer le disque, vider le cache ; `sisyphe ui --read-only` sans aucun contrôle actif. Documenter l'onglet dans `README.md` et `docs/playground.md`.
- [ ] **Step 7 :** `npm test`, commit `feat(ui): settings tab`.

## Auto-revue du plan

- Couverture spec : §2 (tâches 2 et 3), §3 (tâches 1 et 2), §4 (tâche 4), §5 (tâche 5), §6 (tâche 6), §7 (tâche 1 step 4), §8 (réparti), §9 (tests de chaque tâche).
- Noms cohérents : `validateMachineConfigInput` et `writeMachineConfig` (tâche 2) utilisés en tâche 5 ; `Daemon.reload` et les listes `applied`/`needsRestart` (tâche 3) utilisées en tâches 4, 5 et 6 ; `settingsView`, `diagnostics`, `diskUsage`, `purgeCache` (tâche 4) utilisés en tâche 5 ; `ActionName` étendu en tâche 3 avant son usage en tâche 5.
- Dépendances : la tâche 3 suppose la tâche 1 faite (le budget optionnel change la signature comparée au reload) ; la tâche 5 suppose les tâches 2, 3 et 4 ; la tâche 6 suppose la 5.
