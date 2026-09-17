# Sisyphe

Daemon qui prend des tickets — issues GitHub portant le label `sisyphe`, ou tickets Jira assignés à son compte —, les fait trier puis implémenter par un agent (Claude, Codex ou opencode selon le backend), vérifie lui-même build et tests, et ouvre une pull request documentée avec son coût et sa durée. Le matin, on relit des PR.

- Spec : `docs/superpowers/specs/2026-09-08-sisyphe-design.md`
- Plan : `docs/superpowers/plans/2026-09-08-sisyphe.md`
- Validation : `docs/playground.md`

## GitHub App (à faire avant l'installation)

Une App GitHub `sisyphe[bot]`, permissions Contents (read & write), Issues (read & write), Pull requests (read & write), Metadata (read), installée uniquement sur les repos cibles (spec §9). Marche à suivre complète : `docs/playground.md` §1.

À faire d'abord : l'installation se termine par un `sisyphe setup` interactif qui réclame l'App ID, l'Installation ID et le chemin de la clé privée `.pem`. Sans ces trois valeurs sous la main, lancer `./install.sh --no-setup`, créer l'App, puis `sisyphe setup`.

## Jira (à faire avant l'installation, si le suivi passe par Jira)

Trois choses à préparer, sans quoi `sisyphe setup` ne pourra pas aller au bout :

1. **Un compte Jira dédié**, membre du projet visé, avec le droit d'être assigné et de transitionner les tickets. C'est lui qu'on assigne pour déclencher un traitement, et c'est sous son nom qu'apparaissent les commentaires.
2. **Un jeton API émis depuis ce compte**. Se connecter à Atlassian **avec ce compte**, puis `id.atlassian.com` → Sécurité → Créer un jeton API. Émis depuis un autre compte, Sisyphe commenterait sous une identité et travaillerait sur les tickets d'une autre.

`sisyphe setup` s'occupe du reste : il demande où ranger le jeton, et si le fichier n'existe pas encore, il propose de le coller et l'écrit en `0600`. La configuration n'en garde que le **chemin** — le jeton n'est jamais écrit dans `config.yml`, ni affiché par l'interface, ni transmis au navigateur.

Détail de la section `jira` : plus bas, « Suivi des tickets sur Jira ».

## Installation

```bash
git clone git@github.com:Victor-allovoisins/Sisyphe.git ~/sisyphe
~/sisyphe/install.sh
```

Le clone suppose une clé SSH enregistrée sur GitHub (`ssh -T git@github.com` doit répondre) et, si le dépôt est passé en privé, un accès en lecture dessus.

`install.sh` (POSIX `sh`, macOS et Ubuntu) installe ce qui manque — `git`, Node ≥ 24, `gitleaks`, la CLI Claude Code —, compile le clone, pose le lien global `sisyphe`, puis lance `sisyphe setup`. Options : `--dry-run` (affiche chaque commande sans rien exécuter), `--no-setup`, `--no-pull`. Le script s'arrête à la première erreur en nommant l'étape fautive, et revérifie après coup chaque outil qu'il vient d'installer.

Le seul `sudo` est celui d'`apt-get` sur Ubuntu (`git`, `curl`, `ca-certificates`, puis Node par le dépôt NodeSource) : gitleaks est posé dans `~/.local/bin`, et npm bascule sur un préfixe utilisateur (`~/.local`) si le préfixe global n'est pas accessible en écriture. Aucune installation npm sous `sudo`. La version de gitleaks est épinglée dans le script et son archive vérifiée avec le `checksums.txt` de la même release : cela garantit l'intégrité du téléchargement, pas son authenticité — les deux fichiers viennent du même canal non signé.

Prérequis par système :

- **macOS** : Homebrew (le script s'arrête avec la commande officielle s'il manque). Pour un repo cible iOS, en plus et hors périmètre du script : Xcode installé et ouvert une fois, un simulateur, et `brew install xcodegen` — ces outils-là sont vérifiés par le repo cible via son `sisyphe.yml`.
- **Ubuntu** (ou dérivé Debian) : rien de plus, le script se charge du reste.

`sisyphe setup` demande le backend agent, écrit dans la config machine sous `agentBackend` :

- `claude-code` : la CLI Claude Code installée localement (`claude -p`), donc l'abonnement claude.ai. C'est la réponse proposée par défaut à la question de `sisyphe setup` (le défaut du schéma, pour une config écrite à la main, reste `sdk`). Authentification : la session de la CLI (`claude auth status --json` renvoie `loggedIn: true`), aucune clé API. L'alias `cli` reste lu comme `claude-code`. Le sandbox n'est pas supporté par ce backend.
- `sdk` : le Agent SDK, qui exige une clé API Anthropic (console) dans `ANTHROPIC_API_KEY` — `export ANTHROPIC_API_KEY=sk-ant-...` avant `sisyphe setup`. Seul backend qui supporte `sandbox: true` ; la clé n'est injectée que pour lui.
- `codex` : la CLI OpenAI Codex (`codex exec`), pour l'abonnement ChatGPT. **Expérimental** : l'invocation (prompt sur stdin, sandbox, `thread.started`/`error`/`turn.failed`) est validée contre la vraie CLI, mais le chemin de succès (`item.completed`, `turn.completed.usage`) reste non validé — quota ChatGPT épuisé jusqu'au 2026-09-19, à reconfirmer ensuite (voir `docs/playground.md`). Authentification : la session de la CLI (`codex login status`, « Logged in using ChatGPT ») ; `OPENAI_API_KEY` est retiré de l'environnement du run pour éviter la bascule silencieuse sur l'API facturée. La CLI doit être installée et joignable sur le `PATH` du service.
- `opencode` : la CLI opencode (`opencode run`), multi-fournisseur. Authentification : `opencode auth login`, identifiants listés par `opencode auth list` ; les clés fournisseur de l'environnement ne sont pas retirées. La CLI doit être installée et joignable sur le `PATH` du service.

Deux champs machine optionnels `agentModels: { triage, implement }` surchargent le modèle pour `codex`/`opencode` ; absents, chaque CLI applique son propre défaut. `sdk`/`claude-code` continuent d'utiliser `models.triage`/`models.implement` de `sisyphe.yml` (noms Claude).

Limites à connaître, par backend :

- **Budget et tours** : `maxBudgetUsd` et `maxTurns` ne s'appliquent qu'à `sdk`/`claude-code`. Pour `codex`/`opencode`, seul le timeout de Sisyphe (kill du groupe de processus) borne un run — ni plafond de budget, ni plafond de tours.
- **Coût** : `sdk`/`claude-code` rapportent le coût réel de la CLI ; `codex` reporte toujours **0** (abonnement) et `opencode` le reporte au mieux (0 si le flux ne le fournit pas). Les KPI et `report` en tiennent compte sans se casser.
- **Chemins protégés** : `sdk`/`claude-code` les bloquent a priori (hook) ; `codex`/`opencode` s'appuient sur leur bac à sable / permissions et sur le contrôle a posteriori. `opencode` refuse `edit` et `read` par motif (`OPENCODE_PERMISSION`), mais `grep`/`glob` restent autorisés : un contenu protégé peut encore être approché par recherche, le contrôle a posteriori restant le filet. Dans tous les cas, un chemin protégé touché fait **échouer le job** — aucun push, aucune PR.
- **Environnement** : les clés fournisseur ne sont pas toutes retirées. `sdk` est le seul à recevoir `ANTHROPIC_API_KEY` ; `codex` retire `OPENAI_API_KEY` ; `opencode` laisse les clés fournisseur telles quelles (son store `opencode auth` est la voie attendue).

`sisyphe setup` demande ensuite si le suivi des tickets passe par Jira, et le cas échéant le site, le compte, le chemin du jeton et un projet par dépôt.

À la fin, le script rappelle les dernières étapes : la connexion de la CLI choisie (`claude login`, `codex login`, `opencode auth login`), `exec $SHELL -l` pour recharger le `PATH` du terminal courant, puis `sisyphe ui`.

Les données vivent sous `~/.sisyphe` (redéfinissable via `SISYPHE_HOME`).

## Mise à jour

Relancer le même script :

```bash
~/sisyphe/install.sh
```

Une seule commande suffit : le script met à jour, recompile **et redémarre le daemon**. Il n'y a rien à faire après.

Dans l'ordre, il :

1. relève si le daemon tourne, avant tout le reste — après le build, la commande `sisyphe` pointerait sur un `dist/` en cours de réécriture ;
2. fait `git pull --ff-only`, seulement si le clone a un dépôt distant et un arbre de travail propre. Un pull impossible — branche sans suivi distant, historique divergent — ne fait pas échouer l'installation : le build se fait sur l'état local, en le disant ;
3. recompile et repose le lien global ;
4. ne rejoue pas l'entretien de `sisyphe setup` quand la config existe déjà. Il lance `sisyphe setup --reinstall-service`, qui ne demande rien et réécrit l'unité de service au cas où elle aurait changé d'une version à l'autre ;
5. **redémarre le service s'il tournait**, et seulement dans ce cas : une mise à jour ne démarre pas un daemon qu'on avait laissé arrêté.

Le redémarrage est indispensable et facile à oublier : le daemon exécute `dist/`, qu'un rebuild ne change pas pour un processus déjà lancé. Un `git pull` seul ne met rien à jour.

Un job en cours au moment du redémarrage n'est pas perdu : la réconciliation le remet en file au démarrage suivant, jusqu'à deux fois, après quoi il passe en échec avec un commentaire sur le ticket. `sisyphe status` dit ce qui tourne avant de lancer la mise à jour.

`sisyphe doctor` signale un agent launchd resté à une version antérieure.

## Service

Le daemon tourne en service utilisateur — launchd sur macOS, systemd `--user` sur Ubuntu. `sisyphe setup` installe l'unité sans démarrer le daemon ; ensuite le service survit à la fermeture de l'interface et revient au boot dans l'état où on l'a laissé : démarré s'il tournait, arrêté sinon.

```bash
sisyphe service status      # kind, running, pid, enabledAtBoot
sisyphe service start       # démarre maintenant et active au boot
sisyphe service stop        # arrête maintenant et désactive au boot
sisyphe service uninstall
```

Les boutons Démarrer et Arrêter de l'interface (`sisyphe ui`) pilotent ces deux mêmes opérations — c'est le service qui est démarré ou arrêté, jamais un processus détaché de la page. Sur une plateforme sans gestionnaire de service, `sisyphe service start` lance un daemon détaché qui, lui, ne survit pas au redémarrage.

## Suivi des tickets sur Jira

Par défaut, Sisyphe lit des issues GitHub. Une section `jira` dans la config machine bascule le **suivi des tickets** sur Jira ; la **forge reste GitHub** dans tous les cas — clone, branche et pull request, qu'aucun traqueur ne sait héberger.

```yaml
jira:
  site: allovoisins.atlassian.net
  email: bot@exemple.tld                # compte porteur du jeton, signataire des commentaires
  apiTokenPath: ~/.sisyphe/jira-token.txt
  projects:
    - key: IOS
      accountId: 712020:...               # sisyphe setup le résout depuis une adresse
      repo: ILokYou/ILokYou-iOS
      candidateStatuses: [Nouveau, En analyse]
      statusesInOrder: [Nouveau, En analyse, A développer, En développement, En relecture, Developpement fini]
      inProgressStatus: En développement
      doneStatus: En relecture
```

`sisyphe setup` construit cette section par questions. Il demande le **compte une seule fois** — c'est la clé de projet qui route vers le dépôt, pas l'assigné — et résout son `accountId` depuis une adresse ou un nom d'affichage, que personne ne connaît par cœur. La clé attendue est celle qui préfixe les tickets (`IOS` pour `IOS-885`), pas le nom du projet. Un dépôt sans projet Jira reste sur les issues GitHub : la bascule se fait dépôt par dépôt.

Ce qui change, côté usage :

- **Le déclencheur est l'assignation**, pas un label. On confie un ticket à Sisyphe en le lui assignant, sur un des `candidateStatuses`. Pouvoir assigner un ticket du projet *est* l'autorisation : il n'y a pas de contrôle de droits séparé.
- **Un même compte peut servir plusieurs projets** : c'est la clé de projet qui route vers le dépôt, pas l'assigné. Mettre le même `accountId` sur `IOS` et sur un autre projet est donc légitime.
- **Le porteur du jeton (`email`) et l'assigné (`accountId`) doivent être le même compte**, sans quoi Sisyphe commenterait sous une identité et travaillerait sous une autre.
- **Sisyphe fait avancer le ticket dans votre workflow**, de proche en proche — jamais en sautant une colonne, jamais au-delà de 5 transitions. Il ne ferme pas un ticket : il le pose sur `doneStatus` (« En relecture ») quand la PR est ouverte, comme le ferait un développeur.
- **Bloqué ou en échec, il rend la main** : le ticket est réassigné à la personne qui le lui avait confié, avec un commentaire. Il cesse d'être candidat sans changer de colonne, et le redevient dès qu'on le lui réassigne. C'est le seul signal de reprise.
- **La branche de base vient du ticket.** La `fixVersion` désigne une branche de release (`releaseBranchPattern`, `release/{version}` par défaut) ; si elle n'est pas encore coupée, Sisyphe part du `baseBranch` du `sisyphe.yml`. Un ticket **sans version est un ticket de backlog** — le cas le plus courant — et part du tronc. Seul un ticket visant plusieurs versions est rendu : là il y a vraiment un choix à faire.
- **Les captures d'écran restent invisibles à l'agent.** Une pièce jointe ADF devient un marqueur explicite dans le texte du ticket, pour qu'il sache qu'il lui manque quelque chose plutôt que de croire le ticket complet.

`sisyphe doctor` vérifie le compte, l'accès à chaque projet et la cohérence des statuts configurés.

## Ce que Sisyphe écrit sur le ticket Jira

Sous suivi Jira, avec un backend qui sait charger un plugin local (`sdk` ou `claude-code` — voir « Les
backends », plus bas), chaque job se termine par un tour d'agent dédié à la clôture du ticket.

- **La phase `jira`** : dernière phase de chaque job, quelle que soit l'issue (livré, bloqué, échoué,
  annulé). Un seul passage d'agent (20 tours maximum, 1 $ de budget), qui reçoit le sort du job — statut
  d'arrivée, coût, durée, tentatives, drapeaux (secrets, chemins protégés, diff volumineux, arrêt précoce) —
  mais pas le texte du ticket lui-même : pour l'avoir en contexte, l'agent doit le lire avec `sisyphe jira
  show`. Il décide du statut d'arrivée sur Jira et rédige le commentaire de fin. Son seul outil est la
  commande `sisyphe jira` ; un garde-fou Bash refuse tout ce qui ne commence pas exactement par `sisyphe
  jira ` (pas d'enchaînement, pas de saut de ligne). `sisyphe doctor` vérifie la présence du plugin sur le
  disque, sur ces deux mêmes backends — absent, l'agent chargerait le skill sans le trouver et improviserait
  une réponse plausible, en silence.

- **Le filet** : le daemon ne fait pas confiance à ce que l'agent affirme avoir fait, et ne compte pas non
  plus sur la bonne fin de la phase `jira`. Quoi qu'il arrive à celle-ci — rapport vide, rapport mensonger,
  exception — il vérifie deux choses contre l'état réel de Jira, et les corrige au besoin :
  1. un job non livré ne laisse jamais le ticket assigné au compte dédié : le daemon relit l'assigné sur Jira
     et, s'il s'agit encore du compte dédié, réassigne le ticket à qui l'avait confié. Rien de ce que l'agent
     déclare ne fait sauter cette relecture, et une relecture en erreur penche vers le rendu : rendre un
     ticket déjà rendu est sans conséquence, ne pas rendre celui qui aurait dû l'être est la panne ;
  2. un job terminé laisse toujours un texte posté en commentaire — celui rédigé par l'agent s'il y en a un,
     sinon le message qu'aurait posté l'ancien chemin scripté. Le daemon *tente* toujours de le poster : une
     panne Jira au moment de commenter finit en avertissement dans les logs, pas en exception qui priverait
     le job du reste de sa clôture ;
  3. un job livré laisse toujours le ticket sur le statut de relecture : personne d'autre ne l'y met, et une
     phase `jira` muette le laissait sinon en développement jusqu'au prochain démarrage du daemon.
     L'assignation, elle, ne bouge pas — un travail soumis à relecture n'est pas un travail abandonné.

- **La commande `sisyphe jira`**, six verbes :
  - `show <clé>` : titre, statut, type, versions visées, corps et commentaires du ticket, en JSON.
  - `transitions <clé>` : les transitions possibles depuis l'état courant (id et statut d'arrivée).
  - `transition <clé> <statut>` : fait avancer le ticket vers ce statut, de proche en proche.
  - `comment <clé>` : poste un commentaire (corps lu sur l'entrée standard).
  - `assign <clé> --back` ou `--bot` : rend le ticket à qui l'a confié, ou se l'assigne.
  - `get <chemin>` : lecture brute de n'importe quel chemin `/rest/api/`, pour ce que les cinq verbes
    au-dessus ne couvrent pas.

  La lecture (`get`) est libre sur tout `/rest/api/` : elle ne fait qu'apporter de la donnée en plus, sans
  rien déclencher. L'écriture, elle, est bornée à cinq verbes fixes, parce qu'une fois le ticket lu, l'agent
  a en contexte son texte — titre, description, commentaires —, écrit par des tiers. Une commande d'écriture
  arbitraire y serait exposée à une instruction glissée dans ce texte ; les verbes fixes, eux, ne peuvent
  faire qu'une chose chacun.

- **Le lien avec la PR** : la clé du ticket apparaît dans le sujet du commit et dans le titre de la PR
  (`type(CLÉ-123): titre`), ce qui suffit à l'app GitHub for Jira pour remplir le panneau « Développement »
  du ticket — elle s'appuie sur le commit et le titre, pas sur le nom de branche. Le nom de branche ne porte
  donc pas la clé (convention AlloVoisins : préfixe, titre en snake_case, numéro seul — `517` pour `IOS-517`)
  et n'a pas à la porter. Sous suivi Jira, le corps de la PR s'ouvre sur un lien vers le ticket et ne porte pas de
  `Closes #N` : ce numéro y désignerait une issue GitHub sans rapport, qu'une fusion sur la branche par
  défaut fermerait pour de bon.

- **Les backends** : `codex` et `opencode` ne savent pas charger de plugin local. Sous ces deux backends,
  Sisyphe garde le chemin scripté d'avant cette phase : c'est le daemon, et non un agent, qui décide alors
  du statut Jira et du commentaire de fin.

## Côté repo cible

Un fichier `sisyphe.yml` à la racine de la branche par défaut (exemple iOS : `examples/sisyphe.ios.yml`). Il porte les commandes de build et de test, les chemins protégés, les budgets et les limites — et, si le suivi passe par Jira, `releaseBranchPattern` (`release/{version}` par défaut), qui dit comment une version de ticket devient un nom de branche.

Le déclencheur dépend du traqueur :

- **Issues GitHub** : poser le label `sisyphe` déclenche, le retirer annule. Les labels `sisyphe:in-progress`, `sisyphe:blocked`, `sisyphe:done`, `sisyphe:failed` sont posés par Sisyphe ; les retirer relance.
- **Tickets Jira** : assigner le ticket au compte dédié déclenche, le réassigner à quelqu'un d'autre annule. Aucun label n'entre en jeu.

## Écrire les tickets : le skill `signaler-un-bug`

`skills/signaler-un-bug/` est un skill Claude destiné aux personnes non techniques. Il mène un court entretien sur le bug rencontré, rédige le ticket et l'assigne au compte dédié.

Il existe parce que le triage est sans recours : l'agent ne voit **aucune image**, ne peut ouvrir **aucun lien**, et ne peut **poser aucune question**. Un ticket trop maigre est renvoyé à son auteur sans qu'aucun travail ait eu lieu. Le skill est écrit à rebours de ces trois contraintes — il transcrit les captures en mots, cite les règles métier au lieu de les lier, et n'accepte qu'un bug par ticket.

Il tourne sur **claude.ai ou l'app Desktop**, avec le connecteur Atlassian actif — pas dans Claude Code, puisque les personnes visées n'ont ni terminal ni clone. Le connecteur GitHub ne conviendrait pas : il est en lecture seule, toute création d'issue y échoue en 403.

Installation et prérequis : `skills/signaler-un-bug/README.md`.

## Commandes

`sisyphe start [--once]`, `status`, `logs <jobId> [--phase triage|implement|setup|verify] [--raw]`, `report [--since 30d] [--repo owner/repo]`, `ui [--port 7777] [--read-only]`, `cancel <jobId>`, `doctor`, `setup [--reinstall-service]`, `service <status|start|stop|uninstall>`.

### Interface web

`sisyphe ui` sert une page locale sur `http://127.0.0.1:7777` : tableau de bord temps réel (daemon, service, budget du jour, jobs actifs et fil des actions de l'agent), historique des jobs avec panneau de détail (phases, transcript résumé, sorties de vérification, diff, secrets détectés), KPIs par période et onglet Réglages. La page crée et migre sa base au besoin, puis l'ouvre en `readOnly` : elle n'écrit rien — sauf `config.yml`, via l'onglet Réglages — et n'émet d'appels réseau que depuis les blocs Diagnostic et Dépôts, à la demande.

Elle pilote aussi Sisyphe. Barre système du tableau de bord : Démarrer (visible tant que rien ne tourne), Pause ou Reprendre, Poll maintenant, Arrêter — grisés avec un « daemon arrêté » en infobulle quand la socket de contrôle ne répond pas, et un bandeau orange signale l'état en pause. Chaque job porte Annuler tant qu'il n'est pas terminé, Relancer s'il est en échec, bloqué ou annulé (carte du tableau de bord, ligne du tableau Jobs, panneau de détail). Un formulaire « Nouveau job » en tête de l'onglet Jobs crée un job depuis un repo configuré et un numéro d'issue. Annuler, Relancer et Arrêter demandent confirmation ; le résultat arrive en toast (succès 4 s, erreur 8 s avec le message du daemon) et le bloc « Dernières actions » — comme la liste d'actions du détail d'un job — garde la trace de ce qui a été déclenché, depuis l'interface comme depuis la CLI.

L'onglet Réglages édite `config.yml` depuis la page : Exécution (intervalle de poll, jobs simultanés, budget quotidien — un champ vide vaut « aucune limite »), Agent (backend parmi `sdk`, `claude-code`, `codex`, `opencode`, modèles de surcharge `agentModels` pour codex/opencode, sandbox), GitHub (App, installation, chemin de la clé, label, dépôts) et Jira (site, compte porteur du jeton, chemin du jeton, et les projets — ajout, retrait, statuts déclencheurs, ordre du workflow, statuts de travail). Comme pour la clé GitHub, seul le **chemin** du jeton circule : son contenu n'est ni lu, ni affiché, ni transmis à la page. Ajouter un projet ne demande jamais d'`accountId` : on saisit une adresse, le serveur interroge Jira et résout le compte. Les deux statuts de travail sont des menus construits depuis l'ordre du workflow saisi, ce qui interdit d'en désigner un qui n'y figure pas. Retirer le dernier projet retire la section et repasse le dépôt sur les issues GitHub. `dataDir` est affiché verrouillé ; il se change par `sisyphe setup`. Rien n'est écrit sans validation : les erreurs s'affichent sous le champ fautif, l'ancien `config.yml` est conservé en `.bak`, et Enregistrer reste inactif tant que rien n'a changé. Les champs relus à chaque décision (budget, concurrence, intervalle) s'appliquent à chaud par une commande `reload` ; les champs structurels (App, dépôts, label, backend, sandbox, `dataDir`) n'ont d'effet qu'après un redémarrage, rappelé par un bandeau tant que le daemon tourne sur l'ancienne configuration. Daemon arrêté, l'enregistrement aboutit quand même et l'interface propose Démarrer, jamais Redémarrer. Les quatre blocs dessous — Diagnostic (contrôles de `doctor`, relancés par un bouton), Espace disque (taille des dossiers, total, bouton Vider le cache de build), Environnement (versions et chemins) et Dépôts (accès de l'App et validité du `sisyphe.yml`) — se chargent au premier affichage de l'onglet. En lecture seule, les champs sont désactivés, sans Enregistrer, sans purge ni Redémarrer.

Les actions (annuler, relancer, créer un job, poll, pause, reprise, démarrer, arrêter, enregistrer les réglages, vider le cache) passent par `POST /api/actions/<nom>`, réservé au navigateur local (en-tête `X-Sisyphe-Action`, `Content-Type` JSON et `Origin` vérifiée) ; Démarrer et Arrêter passent par le service, jamais par la seule socket. `sisyphe ui --read-only` refuse toute action et n'affiche aucun bouton ni formulaire. Captures : `docs/ui/`.

## Développement

`npm test`, `npm run typecheck`. Les tests d'intégration tournent sans réseau : remote git bare local, `FakeIssueSource`, `ScriptedAgentRunner`.
