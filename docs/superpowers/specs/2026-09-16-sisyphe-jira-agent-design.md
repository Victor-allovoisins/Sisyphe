# Sisyphe : le workflow Jira confié à l'agent, et le lien PR ↔ ticket

Validé le 2026-09-16 avec Victor. Complète `2026-09-08-sisyphe-design.md` et la bascule GitHub Issues → Jira déjà livrée sur `main`.

## 1. Objectif

Deux manques, constatés sur IOS-886, le premier ticket Jira traité de bout en bout par Sisyphe.

**Le workflow est figé.** Le pipeline TypeScript connaît quatre issues possibles — `in-progress`, `done`, `blocked`, `failed` — et les applique aux huit endroits où il touche au ticket. Un workflow Jira réel en demande davantage : le statut d'arrivée dépend de ce qui s'est passé (lint rouge, secret trouvé, diff vide, PR ouverte), et la formulation du commentaire aussi. Ce jugement appartient à l'agent, pas à une table de correspondance.

**Le ticket ignore sa PR.** Relevé le 2026-09-16 sur le champ `customfield_10000` (« Développement ») :

| Ticket | Traité par | Panneau Développement |
| --- | --- | --- |
| IOS-877 | une humaine | `pullrequest: MERGED`, `build: 5`, via `oAuth-com.github.integration.production` |
| IOS-886 | Sisyphe | `{}` |

L'app GitHub for Jira est installée et fonctionne. Elle ne trouve rien parce que Sisyphe n'écrit jamais la clé `IOS-886` : la branche vaut `feature/<slug>_886`, le commit `fix(#886): …`, le titre de PR `[#886] …`. Le `Closes #886` du corps de PR est pire qu'inutile — sous suivi Jira il ne désigne rien, ou bien une issue GitHub sans rapport qu'il fermera à la fusion si la base est la branche par défaut.

## 2. Décisions prises

| Question | Décision |
| --- | --- |
| Qui décide du statut d'arrivée | L'agent, via un skill. Le daemon garde un filet de fin de job. |
| Par quel transport | Une commande `sisyphe jira`, pas le MCP Atlassian. |
| Où vivent les skills | Dans le repo Sisyphe, chargés comme plugin local. |
| Qui écrit la clé dans la PR | Le TypeScript, pas l'agent. |

### 2.1 Pourquoi pas le MCP Atlassian

C'était le choix initial : mêmes outils que les skills av-tools, donc réutilisables presque tels quels. Il est écarté pour une raison de terrain. Le serveur `mcp.atlassian.com/v2/mcp` s'authentifie en OAuth ; le jeton d'accès vit quelques heures et son *refresh token* est invalidé dès qu'une session bouge ailleurs. Sur un poste de développeur cela se voit et se répare en une commande. Sur une machine dédiée sans personne devant, cela donne un daemon qui traite des tickets pendant trois jours puis cesse de les transitionner, sans que rien ne le signale. Le filet sauverait les tickets ; Sisyphe tournerait en dégradé invisible.

Le jeton d'API du compte dédié, lui, est déjà configuré (`jira.apiTokenPath`), ne demande aucun navigateur et ne se révoque pas tout seul.

## 3. Architecture

### 3.1 Une quatrième phase, `jira`

Les trois phases actuelles sont `triage`, `implement`, `deliver`. On en ajoute une, `jira`, qui tourne **à chaque fin de job** : livré, bloqué, échoué, annulé. Elle reçoit le résultat — verdict de triage, étapes de vérification, drapeaux, URL de PR, secrets trouvés — décide du statut d'arrivée, l'atteint, et rédige le commentaire.

Ses outils : `Bash(sisyphe jira:*)` et rien d'autre. Ni `Read`, ni `Edit`, ni `Glob`, ni `Grep`. Elle ne voit pas le dépôt ; elle ne peut pas y toucher. Un tour, quelques centimes.

Les prises en main du début — s'assigner le ticket, passer « En développement » — restent au daemon : à ce moment-là aucun agent ne tourne encore, et il n'y a rien à décider.

Les huit appels `setStatus`/`comment` du pipeline disparaissent au profit de cette phase, à l'exception de la prise en main initiale.

### 3.2 Le filet du daemon

Après la phase `jira`, le daemon relit le ticket et fait respecter deux invariants, en corrigeant si besoin :

1. **Aucun ticket orphelin.** Un ticket ne reste jamais assigné au compte dédié hors d'un statut de travail. S'il l'est, le daemon le rend à celui qui l'a confié — le comportement actuel de `setStatus(ref, null)`.
2. **Aucun job muet.** Un job terminé laisse toujours un commentaire. Si la phase `jira` n'en a pas posé, le daemon pose le commentaire scripté d'aujourd'hui.

Ce filet couvre l'agent tué au timeout, à court de budget, planté, ou qui a simplement fini sans rien faire. Il couvre aussi le cas où `sisyphe jira` est indisponible.

### 3.3 La commande `sisyphe jira`

Le client Jira de Sisyphe sait déjà lire un ticket et ses commentaires, chercher en JQL, lister et enchaîner les transitions (`walkTo`, `src/jira/transitions.ts`), commenter, assigner et lire le changelog. La CLI l'expose, elle ne le réécrit pas.

**Écriture — verbes fixes :**

```
sisyphe jira transition IOS-886 "En relecture"
sisyphe jira comment IOS-886 -          # corps lu sur stdin
sisyphe jira assign IOS-886 --back      # rend le ticket à celui qui l'a confié
```

**Lecture — verbes fixes et passe-plat :**

```
sisyphe jira show IOS-886
sisyphe jira transitions IOS-886
sisyphe jira get /rest/api/3/issue/IOS-886/changelog
```

`get` accepte n'importe quel chemin de l'API Jira en lecture seule. La lecture devient aussi souple que le MCP : tout ce que l'API sait dire, l'agent peut l'aller chercher, y compris ce qu'on n'avait pas prévu. L'écriture reste bornée à trois verbes, parce que c'est là que le coût d'une injection se paie : un `PUT` arbitraire réécrirait les champs, les versions, ou supprimerait le ticket.

Le jeton ne quitte jamais `~/.sisyphe` : la CLI le lit elle-même, il n'entre pas dans l'environnement de l'agent.

Un verbe d'écriture qui manquerait plus tard, c'est dix lignes de CLI et une ligne de skill.

### 3.4 Le skill

`skills/sisyphe-jira/SKILL.md`, dans le repo, chargé par `plugins: [{ type: 'local', path: <repo>/skills }]`. `install.sh` clone déjà le repo : rien à installer en plus, aucun accès réseau au moment du job, et la version du skill est liée à la version de Sisyphe — un daemon en production ne voit pas ses skills changer sous ses pieds.

Il porte le pattern de transition d'av-tools (`av-shared/reference/transition-pattern.md`) : apparier sur `to.name` et jamais sur le nom de la transition, comparaison insensible à la casse et aux accents, jamais de saut d'étape, cinq sauts au maximum. Une différence de fond : le pattern d'av-tools se termine sur `AskUserQuestion` quand il est coincé. En autonome il n'y a personne à interroger — une impasse se solde par « je rends la main », et le filet du daemon fait le reste.

Les statuts ne sont pas recopiés dans le skill : ils vivent déjà dans `config.yml` (`statusesInOrder`, `inProgressStatus`, `doneStatus`). `jira-<team>.yml` d'av-tools reste la source qui sert à les y écrire au `setup`, jamais une seconde copie consultée à l'exécution.

### 3.5 Backends

`plugins` et `skills` n'existent que sur les backends `sdk` et `claude-code`. Sous `codex` et `opencode`, la phase `jira` ne tourne pas et le pipeline garde le chemin scripté d'aujourd'hui. Le filet étant déjà le chemin scripté, la dégradation est propre.

## 4. Le lien PR ↔ ticket

Écrit en TypeScript, pas par l'agent : c'est du nommage, pas du jugement, et cela doit marcher même quand la phase `jira` échoue. Aucun appel à l'API Jira — l'app GitHub for Jira fait le travail dès que la clé est visible.

Sous suivi Jira uniquement ; sous suivi GitHub tout reste tel quel.

| Élément | Aujourd'hui | Demain |
| --- | --- | --- |
| Branche | `feature/<slug>_886` | inchangée — la convention iOS exclut la clé |
| Commit | `fix(#886): …` + `Closes #886` | `fix(IOS-886): …`, sans `Closes` |
| Titre de PR | `[#886] …` | `fix(IOS-886): …` — convention av-tools |
| Corps de PR | `Closes #886` en dernier | `Ticket: [IOS-886](https://<site>/browse/IOS-886)` en tête, pas de `Closes` |

La branche ne porte pas la clé et n'a pas à la porter : l'app indexe aussi les commits poussés et les titres de PR.

**Plomberie requise.** `Job` ne connaît que `repo` et `issueNumber`, mais `DeliverInput` porte déjà l'`Issue` complète, donc `issue.tracker?.key` est disponible au moment de la livraison. Il suffit de le passer aux trois fonctions qui fabriquent les libellés — `commitMessage`, `prTitle`, `renderPrBody` — qui ne reçoivent aujourd'hui que le `Job`. Rien à stocker, aucune migration.

## 5. Le point à lever en premier

Le chargement d'un plugin local par le SDK, avec `settingSources: []`. C'est le seul inconnu qui porte le reste : si `plugins: [{ type: 'local', path }]` et `skills: ['sisyphe-jira']` ne suffisent pas à rendre le skill visible dans ces conditions d'isolement, toute la section 3.4 change de forme — le contenu du skill deviendrait un bloc du prompt de la phase `jira`, ce qui marche aussi mais se partage moins bien.

À vérifier par un essai court avant d'écrire le reste : un plugin minimal, un skill qui ne fait qu'une chose, et la confirmation que l'agent l'invoque. Même vérification sur le backend `claude-code`, où le chargement passe par `--plugin-dir`.

**Sonde du 2026-09-16 : les deux backends chargent bien un plugin local sous isolement.** Plugin jetable (`.claude-plugin/plugin.json` + `skills/probe-skill/SKILL.md`), lancé depuis un répertoire vide hors du dépôt. Côté SDK (0.3.263, `settingSources: []`, `plugins: [{ type: 'local', path }]`, `skills: ['probe:probe-skill']`), le message `init` liste le plugin et le skill, l'agent émet `Skill{skill:'probe:probe-skill'}` et répond `MARMOTTE` ; inchangé en ajoutant `managedSettings: { strictPluginOnlyCustomization: ['hooks','mcp'] }`, c'est-à-dire dans les conditions exactes de Sisyphe. Côté CLI (`claude -p --setting-sources '' --strict-mcp-config --plugin-dir <dir>`), même `init`, même invocation, même réponse. La §3.4 tient donc en l'état.

Deux précisions pour la suite. La forme vérifiée du nom de skill est la forme qualifiée `<plugin>:<skill>` ; la §3.4 écrit `skills: ['sisyphe-jira']`, à requalifier du nom du plugin. Et la restriction des skills : côté SDK l'option `skills` filtre bien ce que le modèle voit — avec `skills: ['probe:probe-skill']` l'agent déclare `dataviz` inexistant — mais le champ `skills` du message `init` liste les skills découverts sans tenir compte du filtre, identique avec et sans l'option : ne pas s'en servir comme preuve. Côté CLI il n'existe pas de drapeau équivalent (`--disable-slash-commands` coupe tout, rien ne restreint au cas par cas), en revanche la syntaxe de permissions d'outil atteint bien un skill nommé : `--disallowedTools 'Skill(probe:probe-skill)'` a fait refuser l'invocation, refus visible dans `permission_denials`.

## 6. Tests

- **`transitions.ts`** : inchangé, déjà couvert. Le skill reprend son algorithme, il ne le remplace pas.
- **CLI `sisyphe jira`** : un test par verbe contre un faux client ; le passe-plat `get` doit refuser tout ce qui n'est pas un GET.
- **Phase `jira`** : le pipeline appelle bien la phase à chacune des quatre issues, avec le contexte du résultat, et un faux runner.
- **Filet** : les deux invariants, chacun avec son cas de déclenchement — agent muet, agent tué, `sisyphe jira` indisponible.
- **Nommage** : `commitMessage`, `prTitle`, `renderPrBody` portent la clé sous suivi Jira et le numéro sous suivi GitHub ; aucun `Closes` sous Jira.
- **Skill** : sa présence dans le paquet et son chargement effectif par le runner (le point de la section 5).

## 7. Hors périmètre

- **La batterie de tests intégrale sur un ticket trivial.** IOS-886 — une couleur de texte — a payé trente minutes : `runVerification` lance tout ce que `sisyphe.yml` déclare, sans regarder la taille du diff, et le prompt d'implémentation demande en plus à l'agent de lancer les mêmes commandes avant de conclure. Sujet réel, traité séparément.
- **Les toasts et messages d'erreur du daemon** qui disent encore `acme/demo#42` (`daemon.ts:524`, `:531`).
- **Le formulaire « Nouveau job » de l'UI**, qui demande un numéro d'issue (`page.ts:248`, `actions.ts:133`).
- **`cli/format.ts:31`**, qui affiche `repo#N` en CLI.
- **Les jobs créés avant la bascule Jira**, dont le `issueNumber` désigne une issue GitHub : ils afficheront des liens Jira qui ne pointent nulle part. Le store n'a pas de marqueur de traqueur par job, donc rien ne les distingue sans migration.
