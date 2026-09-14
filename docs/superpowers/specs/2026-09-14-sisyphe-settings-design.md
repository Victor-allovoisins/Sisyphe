# Sisyphe : page de réglages, limites facultatives, nettoyage des worktrees

Validé le 2026-09-14 avec Victor. Complète `2026-09-08-sisyphe-design.md`, `2026-09-09-sisyphe-ui-actions-design.md` et `2026-09-10-sisyphe-install-service-design.md`.

## 1. Objectif

Régler Sisyphe depuis son interface locale au lieu d'éditer `config.yml` à la main : modifier la configuration machine, voir le diagnostic, l'occupation disque, l'environnement et l'état des dépôts, et récupérer la place prise par le cache de build. Rendre le budget facultatif, parce qu'il n'a pas de sens comme garde-fou financier sous abonnement. Enfin, ne plus laisser traîner le clone de travail d'un job en échec.

## 2. Architecture

- **L'interface écrit `config.yml`, pas le daemon.** Exception assumée à la règle « le daemon est seul écrivain », qui ne porte que sur la base de données : la configuration doit être modifiable daemon arrêté, ce qui est l'état normal juste après une installation. Écriture atomique (fichier temporaire dans le même dossier puis `rename`), mode 0600, et copie de la version précédente en `config.yml.bak` avant remplacement.
- **Rien n'est écrit sans validation.** Le corps reçu est validé par `MachineConfigSchema`, plus deux vérifications locales : la clé privée existe et est lisible, et `dataDir` n'est pas modifié. Un refus renvoie la liste des champs fautifs et laisse l'ancien fichier en place.
- **Commande `reload` sur la socket de contrôle.** Le daemon relit `config.yml`, applique ce qui peut l'être à chaud et renvoie `{ applied: string[], needsRestart: string[] }`. Sont rechargeables à chaud, parce qu'ils sont relus à chaque décision : `dailyBudgetUsd`, `maxConcurrentJobs`, et `pollIntervalSeconds` qui reprogramme son minuteur. Tout le reste — `github.*`, `repos`, `triggerLabel`, `sandbox`, `agentBackend`, `dataDir` — exige un redémarrage, parce que le client GitHub, le runner d'agent et les chemins sont construits au démarrage. Un `reload` sur une config devenue invalide ne change rien et renvoie une erreur : le daemon continue avec la configuration qu'il avait.
- **Daemon arrêté** : l'interface écrit quand même, et la page indique que les modifications prendront effet au démarrage.

## 3. Réglages modifiables

Tous les champs de `config.yml` sauf `dataDir` : `github.appId`, `github.installationId`, `github.privateKeyPath`, `repos` (ajout et retrait), `triggerLabel`, `pollIntervalSeconds`, `maxConcurrentJobs`, `dailyBudgetUsd`, `sandbox`, `agentBackend`.

`dataDir` est affiché en lecture seule : le modifier depuis la page déplacerait la base que l'interface est en train de lire et la socket qu'elle interroge. Il se change par `sisyphe setup`.

Le contenu de la clé privée n'est ni lu, ni affiché, ni transmis : seul son chemin circule.

**Budget facultatif.** Le schéma accepte désormais trois formes pour `dailyBudgetUsd` : un nombre, `null`, ou l'absence du champ. **La valeur brute est conservée telle quelle dans `MachineConfig`** ; la résolution se fait au moment de l'usage, par un unique `effectiveDailyBudget(machine): number | undefined` : un nombre vaut plafond, `null` vaut « aucun plafond, explicitement », l'absence vaut 60 en mode `sdk` et aucun plafond en mode `cli`.

Ce choix, garder le brut et résoudre à l'usage, n'est pas cosmétique. Résoudre dès la lecture avait deux conséquences fâcheuses : `sisyphe setup`, qui recopie la configuration existante, aurait gravé dans le fichier un plafond de 60 que l'utilisateur n'avait jamais saisi dès qu'il passait une config `sdk` sans plafond en mode `cli` ; et « aucun plafond » devenait inexprimable pour une config `sdk`, puisque l'absence du champ y vaut 60. Avec la valeur brute, toute écriture — `setup` comme la page de réglages — préserve exactement ce que l'utilisateur a choisi, et vider le champ depuis la page écrit `null`, qui traverse le YAML sans ambiguïté.

Le coût reste calculé, journalisé et affiché dans tous les cas, y compris sans plafond. `canStartJob` ne vérifie le budget que lorsque `effectiveDailyBudget` renvoie un nombre, et le bandeau de pause budgétaire n'est jamais émis sans plafond. L'interface affiche la dépense du jour suivie de « aucune limite », sans jauge de remplissage.

## 4. Blocs d'information

- **Diagnostic** : les contrôles de `doctor` rendus dans la page (nom, état ✅ ⚠️ ❌, détail), relancés par un bouton, jamais au chargement automatique.
- **Espace disque** : taille de `cache`, `mirrors`, `work`, `logs`, `jobs` et total, calculées à la demande ; bouton « Vider le cache de build » qui supprime le contenu de `cache/` et renvoie la place libérée. Ce cache est reconstruit au prochain build : c'est du temps, pas des données.
- **Environnement** : versions de Sisyphe, node, la CLI Claude, git, gitleaks ; chemins du fichier de config, du dossier de données, de la socket et des logs.
- **Dépôts** : pour chaque dépôt surveillé, l'accès de l'App GitHub et la validité de son `sisyphe.yml` sur la branche par défaut.

Conséquence assumée : les blocs Diagnostic et Dépôts interrogent GitHub. La règle « l'interface ne fait aucun appel réseau » de la v1 est levée ; c'était une simplification, pas une barrière de sécurité. L'interface reste liée à 127.0.0.1 et n'expose rien vers l'extérieur.

## 5. API

- `GET /api/settings` → `{ config, dataDir, hotReloadable: string[], restartRequired: string[], readOnly }`. `config` est la configuration telle qu'écrite sur disque, sans aucun secret.
- `POST /api/actions/settings` avec la configuration complète → validation, écriture, puis `reload` si la socket répond → `200 { ok: true, result: { applied, needsRestart } }` ; `400` sur un corps invalide, avec le détail par champ ; `409` si l'écriture échoue ; `403` en lecture seule.
- `POST /api/actions/purge-cache` → vide `cache/` → `{ freedBytes }`. Refusé pendant qu'un job tourne, pour ne pas casser un build en cours.
- `GET /api/diagnostics` → `{ checks, versions, paths }`, calculé à la demande, mémorisé 30 s.
- `GET /api/disk` → `{ entries: [{ name, path, bytes }], totalBytes }`, calculé à la demande, mémorisé 30 s.
- Les deux actions passent par les mêmes garde-fous que les autres : `Content-Type` JSON, en-tête `X-Sisyphe-Action`, `Origin` local, corps plafonné, refus en lecture seule.
- Nouvelles entrées de journal : `settings`, `reload` et `purge`. La colonne `action` n'a pas de contrainte SQL, aucune migration n'est nécessaire.

## 6. Page

Quatrième onglet « Réglages ». Formulaire groupé en Exécution, Agent et GitHub ; erreurs de validation sous le champ fautif ; Enregistrer inactif tant que rien n'a changé. Après un enregistrement touchant un réglage non rechargeable, un bandeau nomme les champs concernés et propose Redémarrer. Les quatre blocs sont dessous. En lecture seule, l'onglet est consultable mais les champs sont désactivés, sans Enregistrer, sans purge et sans Redémarrer. Toujours `textContent`, jamais `innerHTML`.

## 7. Worktree supprimé en cas d'échec

Aujourd'hui le clone de travail est supprimé quand le job aboutit, est bloqué au triage, ne produit aucun changement ou est annulé, mais conservé en cas d'échec et purgé seulement au démarrage suivant du daemon. Il sera désormais supprimé aussi en cas d'échec, immédiatement, sur les trois chemins concernés : vérification en échec après ouverture de PR, secrets détectés, et exception non rattrapée. Le chemin jumeau de la réconciliation, qui fait passer un job `delivering` à `failed` après un redémarrage, est traité de la même façon, sinon il resterait le seul producteur de worktrees abandonnés. Le dossier de job (`jobs/<id>/`), qui porte les transcripts, les logs de vérification et le diff, n'est pas touché : c'est lui qui sert au post-mortem, pas le clone.

## 8. Sécurité et limites

- La page peut modifier l'App GitHub : une erreur de saisie empêche le daemon de démarrer. D'où le refus d'écrire une configuration invalide, la sauvegarde `.bak`, et le fait que le daemon en cours garde sa configuration quand un `reload` échoue.
- Aucun secret ne transite : ni la clé privée, ni la clé API, dont la présence relève de l'environnement du service.
- La purge du cache est refusée pendant qu'un job tourne.
- Non couvert : édition du `sisyphe.yml` des dépôts, qui est versionné et relève de la revue de code ; édition de `dataDir` ; historique des configurations au-delà du `.bak`.

## 9. Tests

- Écriture : validation refusant chaque champ fautif, écriture atomique, mode 0600, `.bak` créé, `dataDir` refusé en modification, clé illisible refusée.
- Budget : absent avec `cli` → aucun plafond et aucun commentaire de pause ; absent avec `sdk` → 60 ; valeur explicite → plafond appliqué ; vidé depuis la page → aucun plafond.
- `reload` : champs à chaud appliqués (budget pris en compte à la décision suivante, minuteur reprogrammé), champs structurels listés dans `needsRestart`, config invalide → erreur et configuration conservée.
- Routes : `GET /api/settings` sans secret, `POST` valide et invalide, refus en lecture seule, purge refusée pendant un job, mémorisation 30 s de diagnostics et disque.
- Page : présence de l'onglet, des champs, du bandeau de redémarrage, désactivation complète en lecture seule, zéro `innerHTML`.
- Worktree : les trois chemins d'échec suppriment le clone et conservent le dossier de job.
