# Sisyphe : installation multi-machines et service (macOS, Ubuntu)

Validé le 2026-09-10 avec Victor. Complète `2026-09-08-sisyphe-design.md` (CLI, §9) et `2026-09-09-sisyphe-ui-actions-design.md` (UI v2 : remplace son §2.3).

## 1. Objectif

Installer Sisyphe sur une machine neuve, macOS ou Ubuntu, en un clone et un script ; ensuite ne lancer que l'interface et démarrer ou arrêter le daemon depuis elle. Le daemon tourne en service utilisateur (launchd ou systemd) : il survit à la fermeture de l'interface et revient au boot dans l'état où on l'a laissé.

## 2. Distribution : un clone, un script

Le code vit dans le repo privé `ILokYou/sisyphe`. Installation et mise à jour :

```bash
git clone git@github.com:ILokYou/sisyphe.git ~/sisyphe && ~/sisyphe/install.sh
```

`install.sh` (POSIX `sh`, à la racine du repo, exécutable) :

- Détecte l'OS : `uname -s` = `Darwin` → macOS ; `/etc/os-release` avec `ID` ou `ID_LIKE` contenant `ubuntu` ou `debian` → Ubuntu ; autre → message et arrêt. `SISYPHE_INSTALL_OS=darwin|ubuntu` force la détection (tests).
- Installe ce qui manque, dans l'ordre : `git` ; Node ≥ 24 (macOS : `brew install node` ; Ubuntu : script NodeSource `setup_24.x` téléchargé dans un fichier temporaire puis exécuté (`curl -o` puis `sudo bash <fichier>`, jamais un tube vers `sudo` : un téléchargement tronqué ne doit pas s'exécuter à moitié en root ; pas de `-E`, l'environnement non privilégié n'a rien à faire dans un shell root) puis `apt-get install -y nodejs` ; avec `apt-get install -y git`, ce sont les seules commandes exécutées via `sudo`) ; `gitleaks` (macOS : `brew install gitleaks` ; Ubuntu : archive d'une version épinglée, somme vérifiée avec le `checksums.txt` de la même release — garantie d'intégrité contre une corruption, pas d'authenticité : les deux fichiers viennent du même canal non signé, binaire posé dans `~/.local/bin`, ajouté au `PATH` du profil shell si absent) ; la CLI Claude Code (`npm install -g @anthropic-ai/claude-code`) si `claude` est absent. Homebrew absent sur macOS → message avec la commande officielle et arrêt.
- Compile et lie : `npm ci && npm run build && npm link` dans le répertoire du script (le service pointera sur ce clone via le lien global `sisyphe`). Si le préfixe npm global n'est pas accessible en écriture (cas d'Ubuntu avec NodeSource, où il vaut `/usr/lib/node_modules`), le script bascule d'abord sur un préfixe utilisateur (`npm config set prefix "$HOME/.local"`) et ajoute `~/.local/bin` au profil : aucune installation globale sous `sudo`.
- `git pull --ff-only` n'est tenté que si le clone a un dépôt distant et un arbre propre ; sinon le script passe l'étape sans échouer (un clone local sans remote reste utilisable).
- Lance `sisyphe setup` (interactif) sauf `--no-setup`, puis affiche les prochaines étapes : `claude login` si `claude auth status --json` ne renvoie pas `loggedIn: true`, et `sisyphe ui`.
- Relance = mise à jour : `git pull --ff-only` si l'arbre est propre et qu'un distant existe (`--no-pull` pour sauter), puis rebuild ; `sisyphe setup` n'est pas relancé si la config existe (`sisyphe setup --reinstall-service` réécrit l'unité si elle a changé).
- `--dry-run` affiche chaque commande sans l'exécuter ; le script s'arrête à la première erreur (`set -eu`) avec un message qui nomme l'étape.
- Ne s'occupe pas de Xcode ni de `xcodegen` : outils propres aux repos iOS, documentés dans le README, vérifiés par le repo cible lui-même via `sisyphe.yml`.

Le `package.json` garde `engines.node >= 24` ; `private: true` reste (aucune publication npm).

## 3. Gestion du service (`src/service/`)

### 3.1 Interface

```ts
interface ServiceStatus { kind: 'launchd' | 'systemd' | 'none'; installed: boolean; running: boolean; pid: number | null; enabledAtBoot: boolean; detail: string }
interface ServiceManager {
  status(): Promise<ServiceStatus>;
  install(): Promise<{ warnings: string[] }>; // écrit l'unité et la charge, sans démarrer le daemon ; avertissements non bloquants (ex. linger)
  start(): Promise<void>;     // active au boot et démarre maintenant
  stop(): Promise<void>;      // arrête maintenant et désactive au boot
  uninstall(): Promise<void>;
}
```

L'environnement transmis au daemon est construit une seule fois, par `defaultServiceContext` : `PATH` = répertoire du node courant, puis le `PATH` du process, puis `<home>/.local/bin` (où `install.sh` pose gitleaks sur Ubuntu), `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, dédoublonnés : aucun shell n'est hérité sous launchd ni systemd, et le daemon doit retrouver `claude`, `git`, `gitleaks` et les outils du repo, `HOME`, `SISYPHE_HOME` si la variable est définie dans l'environnement (c'est elle qui permet au service de retrouver `config.yml`), et `ANTHROPIC_API_KEY` seulement avec `agentBackend: sdk`. Les trois gestionnaires transmettent exactement ce `ctx.env` : plist, unité et lancement détaché sont identiques.

`createServiceManager({ platform, exec, paths, nodePath, scriptPath, env, client })` choisit l'implémentation : `darwin` → launchd ; `linux` dont le bus utilisateur répond (`systemctl --user show -p Version`, verbe qui échoue sans gestionnaire de session, contrairement à `--version` qui n'ouvre aucune connexion) → systemd ; sinon `none`. `exec` (wrapper execa) est injectable pour tester les commandes émises sans les lancer. `client` est le `ControlClient` de la socket de contrôle (UI v2 §2.2), utilisé pour l'arrêt propre.

### 3.2 launchd (macOS)

- Plist `~/Library/LaunchAgents/com.sisyphe.daemon.plist` (0600), `ProgramArguments` = `<node> <dist>/cli/index.js start`, `EnvironmentVariables` = `ctx.env` tel quel (§3.1), `WorkingDirectory` = dataDir, `StandardErrorPath` = `<logsDir>/launchd.err.log`, `RunAtLoad` **false**, `KeepAlive` = `{ PathState: { "<dataDir>/enabled": true } }`, `ThrottleInterval` 30. launchd démarre le job quand le fichier `enabled` existe et le relance s'il tombe ; fichier absent → il ne le relance pas.
- `install()` : écrit le plist, `launchctl bootout` puis `bootstrap gui/<uid>` (deux essais comme aujourd'hui). Aucun démarrage puisque `enabled` n'existe pas.
- `start()` : crée `<dataDir>/enabled` (vide), puis `launchctl kickstart gui/<uid>/com.sisyphe.daemon`.
- `stop()` : supprime `enabled`, puis `client.send('stop')` ; socket injoignable → `launchctl kill SIGTERM gui/<uid>/com.sisyphe.daemon`.
- `status()` : `launchctl print gui/<uid>/<label>` (exit ≠ 0 → `installed: false`), `running` = `state = running`, `pid` = ligne `pid = N`, `enabledAtBoot` = présence du fichier `enabled`.
- `uninstall()` : `bootout`, suppression du plist et du fichier `enabled`.

### 3.3 systemd (Ubuntu)

- Unité `~/.config/systemd/user/sisyphe.service` (0600) :
  ```ini
  [Unit]
  Description=Sisyphe daemon
  [Service]
  ExecStart=<node> <dist>/cli/index.js start
  WorkingDirectory=<dataDir>
  Environment=PATH=<path>
  Environment=HOME=<home>
  Environment=SISYPHE_HOME=<valeur de l'environnement, si définie>
  Restart=on-failure
  RestartSec=30
  [Install]
  WantedBy=default.target
  ```
  Une ligne `Environment=` par variable, l'affectation entière citée si la valeur contient une espace, une apostrophe, un guillemet ou une barre oblique inverse (forme documentée par systemd) ; `%` doublé en `%%` partout ; `$` doublé en `$$` dans `ExecStart` seulement (aucune expansion dans `Environment=`). **`WorkingDirectory=` n'est jamais cité** : le parseur de systemd ne déguillemette pas ce réglage et rejetterait l'unité entière (chemin non absolu). Pas de `After=network-online.target` : c'est une unité système, rien ne l'amène dans une transaction utilisateur et `After=` seul ne tire aucune unité ; la résilience vient de `Restart=on-failure`.
- `install()` : écrit l'unité (0600, écriture puis `chmod` : le mode d'écriture ne s'applique qu'à la création), `systemctl --user daemon-reload` (échec → erreur citant la commande et conseillant `sisyphe setup --reinstall-service`), puis `loginctl enable-linger` (sans quoi les services utilisateur meurent à la déconnexion) ; refus → avertissement avec `sudo loginctl enable-linger $USER` à lancer une fois, l'installation continue.
- `start()` : `systemctl --user enable --now sisyphe`. `stop()` : `systemctl --user disable --now sisyphe` (un `stop` explicite n'est jamais relancé par `Restart=on-failure`).
- `status()` : `systemctl --user show sisyphe -p ActiveState,SubState,MainPID,UnitFileState` (`clé=valeur` par ligne) → `installed` = `UnitFileState` ≠ vide et ≠ `not-found`, `running` = `ActiveState=active`, `pid` = `MainPID` (0 → null), `enabledAtBoot` = `UnitFileState=enabled`.
- `uninstall()` : `disable --now`, suppression de l'unité, `daemon-reload`.

### 3.4 none

Aucun service installé (`install()` lève « plateforme sans service géré ») : `start()` lance `sisyphe start` détaché (`spawn(process.execPath, [<dist>/cli/index.js, 'start'], { detached: true, stdio: ['ignore', fd, fd], env: ctx.env })` : le même environnement réduit que le plist et l'unité, jamais celui du shell de l'UI ;, `fd` = `<logsDir>/daemon-stdout.log` en ajout, `unref()`) puis attend jusqu'à 5 s que la socket réponde ; `stop()` = `client.send('stop')` ; `status()` = `readLock` (`running`, `pid`), `enabledAtBoot: false`.

## 4. Commandes CLI

- `sisyphe setup` : questions actuelles (backend `cli` par défaut, App GitHub, repos, budget), création des dossiers et de la base (`openDatabase` puis fermeture : les migrations sont jouées ici), puis `ServiceManager.install()` sans démarrer ; termine par « Lancer `sisyphe ui` puis Démarrer ». `--reinstall-service` saute les questions et ne fait qu'`install()`. Plus de `launchctl` ni de plist dans `setup.ts` : tout passe par `src/service/`.
- Sur une plateforme sans service géré, `setup` et `service uninstall` affichent la marche à suivre (`sisyphe service start` lance un daemon détaché qui ne survit pas au redémarrage) et sortent en succès, au lieu d'échouer.
- `sisyphe service status|start|stop|uninstall` : mêmes opérations depuis le terminal (`status` affiche `kind`, `running`, `pid`, `enabledAtBoot`, `detail`).
- `sisyphe doctor` : check « service » via `status()` (avertissement si non installé, ok sinon, avec `enabledAtBoot`) ; sur Linux, check « linger » (`loginctl show-user $USER -p Linger`) en avertissement ; `caffeinate` vérifié sur macOS seulement ; chaque échec de prérequis donne la commande d'installation de l'OS (`brew install …` / `sudo apt-get install …` / lien release gitleaks).
- Les migrations sont désormais jouées par trois commandes (`start`, `setup`, `ui`) et non plus par le seul daemon protégé par son verrou : `openDatabase` ouvre chaque migration en `BEGIN IMMEDIATE` et relit `PRAGMA user_version` dans la transaction, de sorte que deux processus qui migrent en même temps ne se marchent pas dessus (le second constate que la version a bougé et passe).
- `sisyphe ui` : si la base est absente ou en version antérieure au schéma attendu, l'ouvre en écriture une fois (`openDatabase` : création et migrations), la ferme, puis la rouvre en `readOnly` comme aujourd'hui (remplace le refus « base non migrée » de l'UI v2 §2.5 ; `ensureDataDirs` est appelé avant). Config absente → « lancer install.sh ou sisyphe setup ». Reste strictement lecture seule ensuite.
- `sisyphe start` inchangé : c'est lui que le service lance. `caffeinate` n'est tenté que sur macOS (`process.platform === 'darwin'`).
- `src/cli/launchd.ts` disparaît au profit de `src/service/launchd.ts` ; `probeLaunchd` de l'UI v1 est remplacé par `ServiceManager.status()`.

## 5. Intégration UI (amende l'UI v2)

- L'overview expose `service: ServiceStatus` à la place de `launchd` ; le bandeau affiche `kind`, « au boot : oui/non », et l'état du daemon.
- Démarrer = `ServiceManager.start()` ; Arrêter = `ServiceManager.stop()` (et non plus `stop` par la socket seule : sinon launchd ou systemd relanceraient le daemon). Le contrôleur d'actions (UI v2 §2.5) route `start` et `stop` vers le `ServiceManager`, tout le reste vers la socket. `spawn-daemon.ts` de l'UI v2 devient l'implémentation `none` du §3.4.
- `Daemon.start()` ouvre la socket de contrôle **avant** `reconcile()` et `ensureLabels()` : ce prologue interroge GitHub pour chaque repo et peut durer bien plus que quelques secondes, et les commandes reçues entre-temps attendent derrière la porte de sérialisation au lieu de tomber sur une socket absente.
- Après `start()`, l'UI attend jusqu'à 30 s que la socket réponde avant de renvoyer `ok` ; sinon `ok: false` avec la fin du log du service (`launchd.err.log`, `journalctl --user -u sisyphe -n 20`, ou `daemon-stdout.log`). Chaque `ping` a lui-même 2 s de délai, donc le budget doit rester large devant le temps de démarrage réel.

## 6. Sécurité et limites

- `sudo` uniquement pour `apt-get` (Node et git) sur Ubuntu, jamais pour `npm` ; tout le reste s'installe dans le compte utilisateur. Le binaire gitleaks est vérifié par la somme publiée avec la même release (intégrité, pas authenticité).
- Le fichier `enabled`, le plist et l'unité sont en 0600 dans des répertoires de l'utilisateur ; l'interface reste locale (127.0.0.1).
- Avec `agentBackend: sdk`, la clé API est recopiée dans le plist ou l'unité : même exposition que le fichier de config pour le même compte, mais une seconde copie hors de l'arborescence de données ; après rotation de la clé, relancer `sisyphe setup --reinstall-service`. Le backend `cli` (défaut) n'écrit aucun secret.
- Un seul daemon par machine (verrou `daemon.lock`) : le service et un `sisyphe start` manuel s'excluent, le message du verrou indique `sisyphe service stop`.
- Non couvert : Windows, autres distributions Linux (le script s'arrête avec un message), installation de Xcode, mise à jour automatique, exécution de l'interface elle-même en service.

## 7. Tests

- `src/service/launchd.test.ts`, `systemd.test.ts`, `none.test.ts` : `exec` factice qui enregistre les commandes ; on vérifie les commandes exactes de `install`/`start`/`stop`/`uninstall`, le contenu rendu du plist et de l'unité (dont `RunAtLoad false`, `PathState`, `Restart=on-failure`), le parsing de `launchctl print` et de `systemctl show` (fonctions pures), l'avertissement linger quand `loginctl` échoue, la création et la suppression du fichier `enabled` dans un `mkdtemp`.
- `createServiceManager` : sélection par plateforme et disponibilité de `systemctl`.
- `install.sh` : `sh -n` ; exécution `--dry-run` avec `SISYPHE_INSTALL_OS=darwin` puis `ubuntu` et un `PATH` réduit (aucun outil trouvé) → la sortie liste les commandes attendues dans l'ordre ; avec tous les outils présents → seulement build et setup.
- `ui` : dossier de données sans base → la base est créée, migrée et servie ; base v1 → migrée ; config absente → erreur claire.
- Unité systemd : `systemd-analyze verify ~/.config/systemd/user/sisyphe.service` sur une machine Ubuntu, y compris avec un `dataDir` contenant une espace (la validité du fichier ne se vérifie pas depuis macOS).
- Mécanisme launchd validé en réel le 2026-09-10 sur un job jetable (`RunAtLoad false` + `KeepAlive/PathState`) : bootstrap sans `enabled` ne démarre pas ; `enabled` puis `kickstart` démarre ; le job tué alors que `enabled` existe est relancé ; `enabled` supprimé puis job tué, il reste arrêté ; un bootstrap avec `enabled` présent (équivalent du boot) le redémarre seul ; sans `enabled`, il reste arrêté. La réserve de la documentation Apple sur le caractère « race-prone » de `PathState` ne se manifeste dans aucun de ces six cas.
- Validation réelle : sur le Mac de Victor (`install.sh` sur un clone frais, `sisyphe ui`, Démarrer, reboot, le daemon revient ; Arrêter, reboot, il ne revient pas), puis sur un Ubuntu (VM ou conteneur avec systemd) dès qu'une machine est disponible.

## 8. Ordre de réalisation

UI v2 tâches 2 et 3 (commandes du daemon, socket) → ce plan → UI v2 tâches 4 et 5 amendées (le contrôleur d'actions utilise `ServiceManager`).
