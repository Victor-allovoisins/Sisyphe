# Sisyphe

Daemon qui prend les issues GitHub labellisées `sisyphe`, les fait trier puis implémenter par un agent Claude, vérifie lui-même build et tests, et ouvre une pull request documentée avec son coût et sa durée. Le matin, on relit des PR.

- Spec : `docs/superpowers/specs/2026-09-08-sisyphe-design.md`
- Plan : `docs/superpowers/plans/2026-09-08-sisyphe.md`
- Validation : `docs/playground.md`

## GitHub App (à faire avant l'installation)

Une App GitHub `sisyphe[bot]`, permissions Contents (read & write), Issues (read & write), Pull requests (read & write), Metadata (read), installée uniquement sur les repos cibles (spec §9). Marche à suivre complète : `docs/playground.md` §1.

À faire d'abord : l'installation se termine par un `sisyphe setup` interactif qui réclame l'App ID, l'Installation ID et le chemin de la clé privée `.pem`. Sans ces trois valeurs sous la main, lancer `./install.sh --no-setup`, créer l'App, puis `sisyphe setup`.

## Installation

```bash
git clone git@github.com:ILokYou/sisyphe.git ~/sisyphe
~/sisyphe/install.sh
```

Le repo est privé : le clone suppose une clé SSH enregistrée sur GitHub (`ssh -T git@github.com` doit répondre) et un compte membre de l'organisation `ILokYou` avec accès au repo.

`install.sh` (POSIX `sh`, macOS et Ubuntu) installe ce qui manque — `git`, Node ≥ 24, `gitleaks`, la CLI Claude Code —, compile le clone, pose le lien global `sisyphe`, puis lance `sisyphe setup`. Options : `--dry-run` (affiche chaque commande sans rien exécuter), `--no-setup`, `--no-pull`. Le script s'arrête à la première erreur en nommant l'étape fautive, et revérifie après coup chaque outil qu'il vient d'installer.

Le seul `sudo` est celui d'`apt-get` sur Ubuntu (`git`, `curl`, `ca-certificates`, puis Node par le dépôt NodeSource) : gitleaks est posé dans `~/.local/bin`, et npm bascule sur un préfixe utilisateur (`~/.local`) si le préfixe global n'est pas accessible en écriture. Aucune installation npm sous `sudo`. La version de gitleaks est épinglée dans le script et son archive vérifiée avec le `checksums.txt` de la même release : cela garantit l'intégrité du téléchargement, pas son authenticité — les deux fichiers viennent du même canal non signé.

Prérequis par système :

- **macOS** : Homebrew (le script s'arrête avec la commande officielle s'il manque). Pour un repo cible iOS, en plus et hors périmètre du script : Xcode installé et ouvert une fois, un simulateur, et `brew install xcodegen` — ces outils-là sont vérifiés par le repo cible via son `sisyphe.yml`.
- **Ubuntu** (ou dérivé Debian) : rien de plus, le script se charge du reste.

`sisyphe setup` demande le backend agent, écrit dans la config machine sous `agentBackend` :

- `cli` : la CLI Claude Code installée localement (`claude -p`), donc l'abonnement claude.ai. C'est la réponse proposée par défaut à la question de `sisyphe setup` (le défaut du schéma, pour une config écrite à la main, reste `sdk`). Prérequis : `claude auth status --json` renvoie `loggedIn: true`. Le sandbox n'est pas supporté par ce backend.
- `sdk` : le Agent SDK, qui exige une clé API Anthropic (console) dans `ANTHROPIC_API_KEY` — `export ANTHROPIC_API_KEY=sk-ant-...` avant `sisyphe setup`.

À la fin, le script rappelle les dernières étapes : `claude login` si la session Claude Code n'est pas ouverte, `exec $SHELL -l` pour recharger le `PATH` du terminal courant, puis `sisyphe ui`.

Les données vivent sous `~/.sisyphe` (redéfinissable via `SISYPHE_HOME`).

## Mise à jour

Relancer le même script :

```bash
~/sisyphe/install.sh
```

Il fait `git pull --ff-only` (seulement si le clone a un dépôt distant et un arbre de travail propre ; un pull impossible — branche sans suivi distant, historique divergent — ne fait pas échouer l'installation, le build se fait sur l'état local), rebuild, et ne rejoue pas l'entretien de `sisyphe setup` quand la config existe déjà : il lance `sisyphe setup --reinstall-service`, qui ne demande rien, ne démarre rien, et réécrit l'unité de service au cas où elle aurait changé d'une version à l'autre. `sisyphe doctor` signale un agent launchd resté à une version antérieure.

## Service

Le daemon tourne en service utilisateur — launchd sur macOS, systemd `--user` sur Ubuntu. `sisyphe setup` installe l'unité sans démarrer le daemon ; ensuite le service survit à la fermeture de l'interface et revient au boot dans l'état où on l'a laissé : démarré s'il tournait, arrêté sinon.

```bash
sisyphe service status      # kind, running, pid, enabledAtBoot
sisyphe service start       # démarre maintenant et active au boot
sisyphe service stop        # arrête maintenant et désactive au boot
sisyphe service uninstall
```

Les boutons Démarrer et Arrêter de l'interface (`sisyphe ui`) pilotent ces deux mêmes opérations — c'est le service qui est démarré ou arrêté, jamais un processus détaché de la page. Sur une plateforme sans gestionnaire de service, `sisyphe service start` lance un daemon détaché qui, lui, ne survit pas au redémarrage.

## Côté repo cible

Un fichier `sisyphe.yml` à la racine de la branche par défaut (exemple iOS : `examples/sisyphe.ios.yml`). Poser le label `sisyphe` sur une issue déclenche le traitement. Retirer le label annule. Les labels `sisyphe:in-progress`, `sisyphe:blocked`, `sisyphe:done`, `sisyphe:failed` sont posés par Sisyphe ; les retirer relance.

## Commandes

`sisyphe start [--once]`, `status`, `logs <jobId> [--phase triage|implement|setup|verify] [--raw]`, `report [--since 30d] [--repo owner/repo]`, `ui [--port 7777] [--read-only]`, `cancel <jobId>`, `doctor`, `setup [--reinstall-service]`, `service <status|start|stop|uninstall>`.

### Interface web

`sisyphe ui` sert une page locale sur `http://127.0.0.1:7777` : tableau de bord temps réel (daemon, service, budget du jour, jobs actifs et fil des actions de l'agent), historique des jobs avec panneau de détail (phases, transcript résumé, sorties de vérification, diff, secrets détectés) et KPIs par période. La page crée et migre sa base au besoin, puis l'ouvre en `readOnly` : elle n'écrit rien d'autre et ne fait aucun appel réseau.

Elle pilote aussi Sisyphe. Barre système du tableau de bord : Démarrer (visible tant que rien ne tourne), Pause ou Reprendre, Poll maintenant, Arrêter — grisés avec un « daemon arrêté » en infobulle quand la socket de contrôle ne répond pas, et un bandeau orange signale l'état en pause. Chaque job porte Annuler tant qu'il n'est pas terminé, Relancer s'il est en échec, bloqué ou annulé (carte du tableau de bord, ligne du tableau Jobs, panneau de détail). Un formulaire « Nouveau job » en tête de l'onglet Jobs crée un job depuis un repo configuré et un numéro d'issue. Annuler, Relancer et Arrêter demandent confirmation ; le résultat arrive en toast (succès 4 s, erreur 8 s avec le message du daemon) et le bloc « Dernières actions » — comme la liste d'actions du détail d'un job — garde la trace de ce qui a été déclenché, depuis l'interface comme depuis la CLI.

Les actions (annuler, relancer, créer un job, poll, pause, reprise, démarrer, arrêter) passent par `POST /api/actions/<nom>`, réservé au navigateur local (en-tête `X-Sisyphe-Action`, `Content-Type` JSON et `Origin` vérifiée) ; Démarrer et Arrêter passent par le service, jamais par la seule socket. `sisyphe ui --read-only` refuse toute action et n'affiche aucun bouton ni formulaire. Captures : `docs/ui/`.

## Développement

`npm test`, `npm run typecheck`. Les tests d'intégration tournent sans réseau : remote git bare local, `FakeIssueSource`, `ScriptedAgentRunner`.
