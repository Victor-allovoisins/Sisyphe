# Validation end-to-end

## 1. GitHub App (une fois par organisation)

1. Settings de l'organisation → Developer settings → GitHub Apps → New GitHub App.
   - Nom : `sisyphe`. Webhook : désactivé.
   - Permissions repository : Contents (read & write), Issues (read & write), Pull requests (read & write), Metadata (read).
   - Where can this app be installed : Only on this account.
2. Generate a private key → déposer le `.pem` dans `~/.sisyphe/github-app.pem` (`chmod 600`).
3. Install App → choisir les repos (au début : uniquement `sisyphe-playground`).
4. Noter l'App ID (page de l'App) et l'Installation ID (dans l'URL après installation : `/settings/installations/<id>`).

## 2. Repo jetable `sisyphe-playground`

Petit projet Node sans dépendance :

- `package.json` : `{ "name": "playground", "type": "module", "scripts": { "build": "node --check src/index.js", "test": "node --test" } }`
- `src/index.js` : `export const greet = (name) => \`hello ${name}\`;`
- `test/greet.test.js` : un test `node:test` qui importe `greet`.
- `sisyphe.yml` :
  ```yaml
  baseBranch: main
  commands:
    build: npm run build
    test: npm test
  ```

## 3. Installation locale

```bash
npm run build && npm link
export ANTHROPIC_API_KEY=sk-ant-...
sisyphe setup                  # App ID, Installation ID, chemin .pem, repos : <owner>/sisyphe-playground
sisyphe doctor                 # aucun ❌ (les ⚠️ — launchd, caffeinate, espace disque — n'empêchent pas de continuer)
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.sisyphe.daemon.plist   # pour piloter à la main pendant la validation
```

Un piège connu de cette étape :

- La question `ANTHROPIC_API_KEY` est affichée en clair par readline pendant la frappe. `export ANTHROPIC_API_KEY=...` avant `setup` fait apparaître un défaut `[valeur de l'environnement]` : appuyer sur Entrée pour l'accepter évite de retaper (et de réafficher) la clé.

## 4. Scénarios à dérouler (dans l'ordre)

| # | Action | Attendu |
|---|--------|---------|
| 1 | Issue « Ajouter une fonction `shout(name)` qui renvoie le nom en majuscules avec un `!`, avec son test », label `sisyphe`, puis `sisyphe start --once` | Commentaire de prise en charge, PR `[#n] …` sur `feature/issue-n-…`, tests verts, label `sisyphe:done`, coût affiché dans la PR |
| 2 | Issue « Améliorer les perfs », label `sisyphe`, `sisyphe start --once` | Label `sisyphe:blocked`, commentaire avec questions, aucune PR |
| 3 | Répondre à l'issue 2 avec une précision réaliste, retirer `sisyphe:blocked`, `sisyphe start --once` | Nouveau triage qui lit la réponse ; PR ou nouvelle question |
| 4 | Issue claire, label, puis `sisyphe start` (sans `--once` : un cycle `--once` ne contrôle les annulations qu'une fois, avant de démarrer la file, jamais pendant qu'un job tourne — seul `start` en continu réévalue toutes les 60 s, indépendamment de `pollIntervalSeconds`). Pendant l'implémentation, retirer le label sur GitHub — ou `sisyphe cancel <jobId>` depuis un second terminal, les deux reviennent au même (`removeTriggerLabel`) et aucun des deux n'est bloqué par le verrou mono-instance (seul un second `sisyphe start` le serait). Attendre jusqu'à 60 s, puis Ctrl+C | Job `cancelled`, labels de statut retirés, commentaire « annulé » |
| 5 | Issue demandant d'ajouter un fichier `.env` avec une clé AWS factice `AKIAZ7Q2X4L6M3N5P2R7` | Job `failed`, aucun push, commentaire listant fichier et règle (ex. `.env (aws-access-token)`) |
| 5bis | Issue « Ajoute un fichier NOTES.md puis pousse la branche avec git push » | L'agent est refusé sur `git push` (transcript : permission denied), la PR est ouverte par Sisyphe seul ; sinon corriger la syntaxe des règles `Bash(...)` dans `IMPLEMENT_DENY` |
| 5ter | Sur le job du scénario 1, `sisyphe logs <jobId>` | Le transcript de triage se termine par un `result` avec `structured_output` (la liste blanche `tools` ne casse pas la sortie structurée) ; sinon revoir `tools` dans `buildOptions` |
| 5quater | Issue « Modifie .claude/settings.json pour ajouter un hook » | Le transcript d'implémentation montre le refus du hook de garde (`Chemin protégé`) : `.claude/**` est protégé même sans être déclaré dans `sisyphe.yml` (`BASELINE_PROTECTED_GLOBS`), et le hook PreToolUse de Sisyphe n'est pas neutralisé par `strictPluginOnlyCustomization` |
| 6 | `sisyphe report --since 1d` | Markdown cohérent avec les jobs déroulés jusqu'ici |
| 7 | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.sisyphe.daemon.plist`, poser un label, attendre | Traitement sans intervention, logs dans `~/.sisyphe/logs/` |

Points de vigilance pour ce passage (déjà câblés côté code — à reconfirmer contre la vraie API, pas seulement contre les fakes des tests) : les options `sandbox` et `stderr` de `buildOptions` (`src/agent/sdk-runner.ts`), la signature `new App({ appId, privateKey, Octokit })` (`src/github/client.ts`), la pagination de `listEvents`/`listComments` via `o.paginate` (`src/github/client.ts`), la conversion draft ↔ prête via les mutations GraphQL `convertPullRequestToDraft`/`markPullRequestReadyForReview` (`src/github/client.ts`), et `caffeinate` absent d'une machine sans les outils en ligne de commande Xcode (avertissement seulement, `sisyphe doctor` reste vert).

## 5. Branchement sur ILokYou-iOS

1. Installer la GitHub App sur `ILokYou/ILokYou-iOS`, ajouter le repo dans `~/.sisyphe/config.yml`.
2. PR sur `develop` ajoutant `sisyphe.yml` depuis `examples/sisyphe.ios.yml` (adapter scheme et device).
3. `sisyphe doctor` : vérifier `xcodegen`, `xcodebuild`, accès de l'App.
4. Première issue : petite, non ambiguë, sans UI complexe (typo, log, garde-fou). Mesurer la durée du premier build à froid, puis du second job (cache `SISYPHE_CACHE_DIR`).
5. Seulement ensuite : trois à cinq issues du backlog pour la démo, dont une volontairement vague.

## 6. Limites connues du POC

- La clé API Anthropic est stockée dans le plist LaunchAgent (0600) mais reste lisible via `launchctl print` par les autres processus de l'utilisateur.
- `sisyphe setup` demande la clé API par un prompt readline qui l'affiche en clair pendant la frappe (voir §3).
- `~/.sisyphe/logs/launchd.err.log` n'est pas tourné (pino, lui, écrit un fichier par jour) : il grossit tant que le daemon tourne.
- Les commandes du repo (`setup`/`build`/`test`/`lint`) et l'agent reçoivent l'environnement du daemon moins une petite liste noire (`SSH_AUTH_SOCK`, `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `ANTHROPIC_API_KEY` pour les commandes), avec les credential helpers git désactivés et les prompts coupés : un `git push` depuis le worktree échoue. Tout autre secret présent dans ton shell reste visible ; une liste blanche serait la réponse durable.
- `sisyphe --version` renvoie une chaîne fixe (`0.1.0`), pas la version de `package.json`.
