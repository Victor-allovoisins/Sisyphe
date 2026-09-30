# Sisyphe : livrer selon av-tools, lu sur av-tools

Validé le 2026-09-30 avec Victor. Fait suite à la PR av-tools #53
(`ILokYou/IA-Claude-Marketplace`, v2.29.0) : elle sort les conventions de livraison d'av-tools dans un
fichier de données, `plugins/av-tools/skills/av-shared/reference/delivery-templates.yml`, et y ajoute les
cas où l'on rend un ticket sans humain à qui poser la question.

## 1. Constat

Les skills av-tools reflètent le process de traitement des tickets d'AlloVoisins. Une PR ou un commentaire
Jira de Sisyphe doit y être indiscernable de ceux d'un dev. Aujourd'hui, ce n'est pas le cas :

| Élément | Sisyphe | av-tools |
| --- | --- | --- |
| Sujet de commit | `fix(IOS-886): …` + `Co-Authored-By` | `🐛(IOS-886): …`, aucune mention de Claude ni de co-auteur |
| Titre de PR | `fix(IOS-886): …` | `🐛(IOS-886): …` |
| Corps de PR | Résumé, Changements, Décisions, Tests, Points d'attention, Suites, coût, template du dépôt | `## Summary` (lien du ticket + puces), `## Test plan` |
| Commentaires Jira d'un job livré | un texte 🪨 réécrit par l'agent | « Analyse et correction », puis `Pull Request opened: <url>` |
| Ticket rendu | un texte 🪨 réécrit par l'agent | rien : av-tools pose la question en TUI. Les modèles arrivent avec la #53 |

Charger av-tools tel quel dans l'agent est exclu : ses MCP sont en OAuth, ses skills s'arrêtent sur des
questions TUI et refusent le mode autonome. Sisyphe **porte ses règles**, en les lisant à la source.

## 2. Décisions prises

| Question | Décision |
| --- | --- |
| D'où viennent les formats | Du dépôt av-tools, lus par Sisyphe à chaque job. Aucune copie dans Sisyphe. |
| Quand av-tools ne couvre pas un cas | Le cas est ajouté à av-tools (fait dans la #53), jamais inventé ici. |
| Accès au dépôt privé | L'app GitHub `allo-sisyphe`, avec un jeton réduit à ce dépôt, en lecture seule. |
| Quelle version | La tête de `main`, comme les devs qui installent par le marketplace. Le réglage `avTools.branch` permet de viser une autre branche. |
| Version invalide ou injoignable | Repli sur la dernière version validée, épinglée par Sisyphe. |
| Aucune version jamais validée | Le ticket est rendu **avant le triage**, avec un message Sisyphe. Jamais de livraison dans un autre format. |
| Qui écrit les commentaires Jira | Le pipeline, en rendant les modèles. La phase `jira` ne fait plus que les transitions. |
| Quel suivi est concerné | Jira seulement. Sous suivi GitHub, rien ne change. |
| Messages propres à l'outil | Inchangés : `sisyphe.yml` absent ou invalide, droit d'assignation, redémarrage, budget, et le nouveau « conventions av-tools illisibles ». |

### 2.1 Pourquoi l'app GitHub, et des jetons réduits

Pour les dépôts des apps, Sisyphe fait déjà fetch et push en HTTPS avec un jeton d'installation
(`GitHubIssueSource.getAuthenticatedRemoteUrl`). Ajouter `IA-Claude-Marketplace` à l'installation
`allo-sisyphe` ne demande donc rien de nouveau : pas de clé SSH, pas de `known_hosts`.

Il y a un risque. Le jeton est aujourd'hui créé **sans restriction** (`o.auth({ type: 'installation' })`) :
il couvre tous les dépôts de l'installation, avec toutes ses permissions. Une fois av-tools ajouté, chaque
jeton de Sisyphe pourrait donc écrire sur son `main`, qui n'est pas protégé et part chez tous les devs dès
qu'on y fusionne. `@octokit/auth-app` sait réduire un jeton à sa création (`repositoryNames`, `permissions`).
Sisyphe s'en sert :

- pour av-tools, un jeton limité à `IA-Claude-Marketplace`, avec `contents: read` ;
- pour un dépôt d'app, un jeton limité à ce dépôt, avec les permissions de l'installation.

**Prérequis, vérifié le 2026-09-30 :** l'installation de ce poste ne voit que `ILokYou/ILokYou-iOS`.
Le propriétaire du compte ILokYou doit ajouter `IA-Claude-Marketplace` dans GitHub → Settings →
Applications → allo-sisyphe → Repository access. Il faut ensuite vérifier sur la machine dédiée que c'est
bien la même installation (`sisyphe doctor`, § 3.5).

## 3. Phase A : lire av-tools

Aucun changement visible dans les livrables. Cette phase peut partir avant le merge de la #53 : doctor
dira « fichier absent sur `main` ».

### 3.1 Réglage

Section machine optionnelle, avec ses valeurs par défaut :

```yaml
avTools:
  repo: ILokYou/IA-Claude-Marketplace
  branch: main
  path: plugins/av-tools/skills/av-shared/reference/delivery-templates.yml
```

Elle n'est **requise que si `jira` est configuré**. Doctor le vérifie ; le schéma, lui, reste permissif.
`config/write.ts` doit la reporter à l'écriture comme il reporte `jira` à la main (`write.ts:43-49`), sinon
la page de réglages l'efface.

### 3.2 Miroir et épingle — `src/avtools/source.ts`

`loadAvTools(deps)` rend `{ sha, templates, fresh } | null` :

1. Fetch de `avTools.branch` dans le miroir `<dataDir>/mirrors/ILokYou__IA-Claude-Marketplace.git`, avec le
   jeton réduit du § 2.1. `ensureMirror` convient tel quel : il est indexé par `owner/name` et range la
   branche sous `refs/sisyphe/base/<branche>`.
2. Résolution de la ref en SHA, puis lecture du fichier **à ce SHA**. Deux primitives manquent dans
   `git.ts` : `resolveRef(repo, ref)` et `readFileAtSha(repo, sha, path)`. `readFileAtRef` ne prend qu'une
   branche.
3. Validation (§ 3.3). Si le fichier est valide, le SHA est épinglé sous `refs/sisyphe/avtools/validated`,
   et la fonction rend `fresh: true`.
4. Si le fetch échoue, si le fichier est absent ou s'il est invalide, la fonction relit l'épingle et rend
   `fresh: false`, avec un avertissement dans le journal qui dit pourquoi.
5. S'il n'y a pas d'épingle, elle rend `null`.

L'épingle a sa propre ref parce que les reflogs sont coupés (`core.logAllRefUpdates=false`) : après un
force-push sur `main`, le dernier SHA validé ne serait plus référencé, et `git gc` pourrait l'effacer.

### 3.3 Modèles — `src/avtools/templates.ts`

- **Schéma zod**, qui reprend le contrôle `[I]` d'av-tools :
  - `schema_version` égal à 1 ;
  - les clés de premier niveau connues, et les cinq clés de `gitmoji` ;
  - `commit_rules.forbidden` ;
  - chaque modèle avec exactement `vars` et `text`, un texte non vide, et des types `text` ou `list` ;
  - chaque jeton déclaré et chaque variable utilisée ;
  - chaque jeton de liste seul et non indenté sur sa ligne ;
  - les modèles d'une ligne sans saut de ligne.
- **Clés dupliquées refusées**, comme le fait déjà `yaml` par défaut.
- **Les variables que Sisyphe sait remplir**, modèle par modèle, figées dans le code. Les modèles qu'il rend
  doivent tous exister et déclarer **exactement** ces variables. Sinon la version est invalide et Sisyphe se
  replie sur l'épingle : un modèle qui gagne une variable inconnue ne doit jamais partir à moitié rempli.
- **`render(templates, nom, valeurs)`** suit les règles de l'en-tête du fichier :
  - une variable `text` est insérée telle quelle ;
  - une variable `list` donne une ligne `- élément` par entrée, et une liste vide supprime la ligne ;
  - la substitution se fait en une passe ;
  - tous les sauts de ligne finaux sont retirés.

### 3.4 Pipeline

- **Chargement** : `loadAvTools` tourne dans `runJob` juste après `source.getIssue`, qui dit si le ticket
  vient de Jira (`issue.tracker`), et avant le miroir du dépôt cible et `resolveBaseBranch`. C'est ce qui
  permet à la sortie « plusieurs versions » (§ 4.2) d'être rendue selon av-tools.
- **Une version par job** : les modèles restent en mémoire pour tout le job. Leur SHA est noté dans le job,
  grâce à la migration 5 (`ALTER TABLE jobs ADD COLUMN av_tools_sha TEXT`), avec `Job.avToolsSha` et
  `JobPatch`.
- **`null`** : `finish('blocked')` avec le message Sisyphe `renderAvToolsUnavailableComment`, en 🪨, qui dit
  que les conventions av-tools sont illisibles et que doctor en donne la raison. Le ticket est rendu. Aucun
  agent n'a tourné.
- **Sorties anticipées** : une sortie qui arrive avant le chargement (une exception dans `relaunchFor`, par
  exemple) lit l'épingle. S'il n'y en a pas, elle poste le message de secours 🪨.

### 3.5 Doctor

Un check « av-tools », ajouté quand `jira` est configuré. Il vérifie, dans l'ordre :
1. l'installation voit le dépôt (`checkAccess`) ;
2. le fichier se lit sur la branche (`getFileContent`, sans miroir) ;
3. il est valide pour Sisyphe (§ 3.3).

Sa réponse :
- **ok** : `main @ <sha court>, 15 modèles` ;
- **avertissement** : l'épingle a pris du retard sur la branche, ou le fichier y est absent alors qu'une
  épingle existe ;
- **échec** : pas d'accès, ou aucune version valide nulle part.

## 4. Phase B : rendre selon av-tools

À livrer après le merge de la #53, et seulement sous suivi Jira.

### 4.1 Commit et PR

- **Commit** :
  - le modèle `commit_subject`, avec `gitmoji` tiré de `change_type` (`feat`→`feature`, `fix`, `refactor`,
    `chore`, `docs`) et `description` = le titre nettoyé du ticket ;
  - plus de `Co-Authored-By` : `SISYPHE_AUTHOR` est déjà l'auteur et le committer ;
  - un mot de `commit_rules.forbidden` présent dans le titre est retiré, sans tenir compte de la casse, et
    le retrait est journalisé ;
  - le commit `!build` ne change pas : c'est une convention de la CI, pas d'av-tools.
- **Titre de PR** : le modèle `pr_title`, avec les mêmes valeurs.
- **Corps de PR** : le modèle `pr_body_simple`. Sisyphe ne produit pas de design doc.
  - `changes` = `report.pr_changes`, et `test_plan` = `report.test_plan`.
  - Pour une PR en brouillon, une première puce s'ajoute en tête de `test_plan` : `❌ Vérification
    « <étape> » en échec après N tentative(s)`, ou `⚠️ Diff volumineux : N lignes`.
  - Le template du dépôt, la section Sisyphe (coûts), les points d'attention et le marqueur
    `<!-- sisyphe:job:… -->` disparaissent. Aucun code ne lit le marqueur : il n'est que produit
    (`comments.ts:8`) et nettoyé (`sanitize`).
  - `clampForGitHub` et `sanitizeModelText` s'appliquent comme aujourd'hui.

### 4.2 Commentaires Jira, sortie par sortie

`assignee` vaut le nom affiché du compte Sisyphe, celui que `relaunchFor` résout déjà.

| Sortie | Modèle | Valeurs |
| --- | --- | --- |
| Livré, vérification verte | `jira_review_summary`, puis `jira_pr_opened` | `report.jira_summary` ; `prUrl`. Si les trois listes sont vides, seul le second part (le « Skip » d'av-tools) |
| PR ouverte en brouillon parce que la vérification a échoué (`failed`). Un brouillon dû au seul diff volumineux ou à `pr.draft` reste « livré » | `jira_pr_draft` | `prUrl`, `failed_check` = l'étape en échec, `attempts`. À la réconciliation, l'étape n'est plus connue : `failed_check` vaut alors « vérification » |
| Triage `needs_clarification` | `jira_handback_needs_information` | `reason` = `verdict.note \|\| verdict.summary`, `questions` |
| Triage `too_big` | `jira_handback_too_big` | `reason` = `note \|\| summary`, `split` = `verdict.reasons` |
| Triage `out_of_scope` | `jira_handback_out_of_scope` | `reason` = `note \|\| summary` |
| Triage sans verdict (repli, confiance 0) | `jira_handback_technical_failure` | phrase fixe |
| Plusieurs versions visées | `jira_handback_ambiguous_version` | `reason` = la raison de `resolveBaseBranch` |
| Aucun changement produit | `jira_handback_nothing_to_deliver` | `reason` = `report.summary` |
| Secret ou chemin protégé | `jira_handback_unsafe_change` | `findings` : « secret potentiel : <fichier> », « fichier protégé modifié : <fichier> ». Jamais une valeur |
| Exception, ou abandon après trois redémarrages | `jira_handback_technical_failure` | phrase fixe : « une erreur est survenue pendant le traitement automatique ». Le détail reste dans `jobs/<id>/` |
| Annulé | `jira_cancelled` | — |
| Réconciliation, PR retrouvée au démarrage | comme « livré » ou « brouillon » | le rapport stocké dans le job, rendu au SHA du job, ou à l'épingle si ce SHA n'est plus lisible |

- **Tout texte venu d'un modèle** (verdict, rapport) passe par `sanitizeModelText`.
- **Sous suivi GitHub**, `comments.ts` reste tel quel.

### 4.3 La phase `jira`

- **Le skill `sisyphe-jira`** perd la section « Le commentaire » : il ne fait plus que lire le ticket, faire
  la transition, rendre le ticket et relire.
- **`JiraSyncReportSchema`** perd `comment`, et `JiraOutcome` perd `draft`.
- **`closeTicket`** rend et poste lui-même les commentaires du § 4.2, dans le `finally`, comme aujourd'hui.
  Les invariants du filet ne changent pas : un job non livré ne reste pas assigné à Sisyphe, un job terminé
  laisse toujours un commentaire, et un job livré ne reste pas « en cours ».

### 4.4 Rapport d'implémentation

`ImplementationReportSchema` gagne trois champs. Leurs descriptions reprennent les consignes d'av-tools :

- **`pr_changes: string[]`** : ce qui change, écrit pour un relecteur, pas fichier par fichier. Sans tiret
  en tête, puisque le rendu l'ajoute.
- **`test_plan: string[]`** : la checklist qu'un humain suit pour tester le changement.
- **`jira_summary: { problem, fixed, impact }`** : trois listes, 3 à 8 puces au total. Le texte est
  technique mais accessible, lisible par le support, sans nom de fichier ni de fonction.

`fallbackReport` les laisse vides. Le prompt d'implémentation les annonce.

### 4.5 Jira : le gras

`markdownToAdf` apprend `**texte**`, qui devient un nœud texte avec la marque `strong`. C'est ce que
produit av-tools, vérifié sur BACK-1116 : titres en `<strong>`, puces en `bulletList`, et
`Pull Request opened: <url>` en paragraphe simple, sans lien. Rien d'autre ne change dans la conversion.

## 5. Tests

- **`templates`** :
  - le schéma, avec chaque règle du § 3.3 qui fait échouer un cas, y compris « variable inconnue de
    Sisyphe » ;
  - le rendu : liste vide, passe unique (une valeur contenant `{test_plan}` reste littérale), sauts de ligne
    finaux ;
  - le rendu des six modèles repris, comparé au texte d'av-tools.
- **`source`**, sur un faux distant local :
  - une version valide est épinglée ;
  - un commit invalide par-dessus renvoie vers l'épingle, avec `fresh: false` ;
  - un fetch en échec renvoie vers l'épingle ;
  - sans épingle, la fonction rend `null` ;
  - un force-push ne perd pas l'épingle.
- **doctor** : ok, avertissement (épingle en retard, fichier absent) et échec (pas d'accès, rien de valide).
- **Store** : la migration 5.
- **`to-adf`** : le gras, y compris dans une puce.
- **Intégration Jira** (`test/integration/jira-pipeline.test.ts`) :
  - le sujet de commit exact ;
  - le titre et le corps de PR ;
  - les deux commentaires, dans l'ordre ;
  - le brouillon ;
  - chaque rendu de ticket du § 4.2 ;
  - le ticket rendu avant le triage quand av-tools est illisible.
- **Pièges connus** :
  - `store.test.ts:195-260` reconstruit d'anciennes bases en retirant `issue_key` et en rembobinant
    `user_version` : ces tests doivent tenir compte de la migration 5 ;
  - `FakeIssueSource.getAuthenticatedRemoteUrl` ignore le dépôt demandé : il faut une table dépôt → URL ;
  - `test/helpers/git-fixture.ts` a des chemins figés et aucune aide pour ajouter un commit : il faut un
    second distant et `addCommit` ;
  - des chaînes exactes sont figées dans `deliver.test.ts` (`[#7] Titre`, `!build IOS-887 — Titre`) et
    `render.test.ts` (`Ticket: [IOS-886](…)`, `Closes #7`). Celles du suivi GitHub restent ; celles du suivi
    Jira changent.

## 6. Hors périmètre

- **Le slug de branche d'av-tools** (6 mots, jamais un mot coupé) et le format de branche par équipe
  (`{prefix}{KEY}-{slug}` sur BACK). Ils vont au chantier « règles de décision », avec le préfixe et la
  branche de base par type de ticket, lus dans les `jira-*.yml`.
- **La revue de code avant la PR.**
- **Les artefacts Notion** (CT, design).
- **La restriction des jetons pour les appels REST** (issues, PR) : seuls les jetons passés à git sont
  réduits.
