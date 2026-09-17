# Sisyphe : vérification ciblée, et deux dettes de la bascule Jira

Validé le 2026-09-17 avec Victor. Complète `2026-09-16-sisyphe-jira-agent-design.md`, dont il reprend trois points laissés hors périmètre.

## 1. Trois sujets

### 1.1 Une couleur de texte coûte trente minutes

IOS-886 demandait de changer une couleur de libellé. Le job a tourné trente minutes.

`runVerification` exécute `ORDER.filter((name) => i.config.commands[name])` — tout ce que le `sisyphe.yml` du dépôt déclare, dans l'ordre `setup`, `build`, `test`, `lint`, sans jamais regarder la taille du diff, `files_likely_touched` ni `change_type`. Sur iOS, `build` et `test` passent tous deux par `xcodebuild` sur simulateur : c'est là que part le temps.

Et la batterie tourne **deux fois**. Le prompt d'implémentation exige de l'agent qu'il lance `build, test, lint` avant de conclure (`prompts.ts`, `verifyStepsSentence`), puis `runVerification` relance exactement les mêmes commandes. Une reprise après échec paie une troisième fois.

### 1.2 Le ticket dit « réassignez-le à `acc-sisyphe-ios` »

`relaunchFor` (`src/jobs/relaunch.ts`) construit `{ kind: 'assignee', who: project.accountId }`, et `relaunch()` imprime cet identifiant tel quel dans le commentaire posté sur le ticket. Un `accountId` Jira ne veut rien dire pour la personne qui a signalé le bug, et c'est elle qui lit ce message. Depuis la livraison de la phase `jira`, ce texte part aussi dans le brouillon donné à l'agent, avec consigne de n'en rien perdre.

### 1.3 Les jobs d'avant la bascule pointent dans le vide

`jiraLinksOf(machine)` déduit le traqueur d'un job de la configuration **actuelle** : si le dépôt est aujourd'hui suivi sur Jira, tous ses jobs affichent un lien Jira. Or un job créé avant la bascule porte un numéro d'issue GitHub dans les mêmes champs `repo`/`issue_number`. Son lien pointe vers un ticket Jira qui n'existe pas.

La table `jobs` n'a aucun marqueur de traqueur ; rien ne distingue les deux populations.

## 2. Décisions prises

| Question | Décision |
| --- | --- |
| Qui choisit les vérifications | L'agent, **au triage** — avant d'avoir écrit du code. |
| Qui peut revenir dessus | Sisyphe, et seulement pour élargir. |
| Plancher par défaut | Aucun, hors `setup`. Chaque dépôt peut se poser le sien. |
| Comment distinguer les jobs Jira des jobs GitHub | Une colonne `issue_key`, écrite à la création. |

### 2.1 Pourquoi au triage et pas dans le rapport d'implémentation

C'est le modèle qui choisit ce qui va le contrôler : le moment où il le choisit décide de son enjeu. Dans le rapport d'implémentation, il juge son propre travail et a intérêt à conclure vite. Au triage, il n'a encore rien écrit — le périmètre de vérification est une lecture du ticket, pas une défense de son code.

## 3. La vérification ciblée

### 3.1 Ce que le triage déclare

`TriageVerdictSchema` gagne :

```ts
verification: z.object({
  steps: z.array(z.enum(['build', 'test', 'lint'])).describe("Les vérifications que ce changement mérite. Vide : aucune au-delà de setup."),
  why: z.string().describe('En une phrase, pourquoi ce périmètre suffit — lu par un relecteur humain, pas par une machine.'),
}),
```

`setup` n'y figure pas : il n'est jamais sautable, c'est lui qui rend le worktree constructible.

Le champ est rempli pour tous les verdicts, y compris ceux qui ne sont pas `ready` — un verdict non `ready` n'atteint pas la vérification, et exiger le champ partout évite un schéma conditionnel que le modèle remplirait mal.

### 3.2 Ce que Sisyphe en fait

Le périmètre retenu est l'intersection de ce que le triage demande et de ce que le dépôt déclare dans `commands`. Le dépôt reste maître de ce qui existe ; l'agent choisit parmi.

**Quatre faits le ramènent à la batterie complète**, vérifiés au moment de la vérification et non au triage :

1. le diff dépasse `limits.maxDiffLines` (`flags.largeDiff`) ;
2. un chemin protégé est touché ;
3. le diff touche des fichiers hors de `files_likely_touched` — le changement n'est pas celui que le triage avait prévu ;
4. **c'est une reprise** (`attempt > 1`) — quelque chose a déjà cassé, le périmètre annoncé n'est plus crédible.

L'agent peut restreindre à partir d'une lecture ; les faits peuvent toujours élargir. Jamais l'inverse.

Le critère 3 mérite d'être nommé pour ce qu'il est : `files_likely_touched` est une prévision, et un écart y est fréquent et légitime. Il n'invalide pas le travail — il invalide le *périmètre de vérification* déduit d'une prévision devenue fausse.

### 3.3 Le plancher du dépôt

`sisyphe.yml` gagne un champ optionnel :

```yaml
verify:
  alwaysRun: [build]   # défaut : []
```

Vide par défaut. Sur iOS, `build` coûte presque autant que `test` : un plancher à `[build]` ne ferait économiser qu'une moitié, et l'équipe qui veut cette garantie peut se la donner elle-même.

### 3.4 L'agent ne relance que ce qui est retenu

`implementPrompt` construit sa phrase « exécute les commandes … avant de conclure » à partir du périmètre retenu, pas de tout ce que le dépôt déclare. Sans cela, le double passage subsiste précisément sur les étapes qu'on croyait avoir économisées.

### 3.5 Ce qui a été sauté se voit

Les étapes non retenues apparaissent déjà dans `VerifyResult.steps` avec le statut `skipped`, que le corps de PR rend. Il faut y ajouter **la raison** : le `why` du triage quand le périmètre a été restreint, et le fait déclencheur quand Sisyphe a élargi.

Un relecteur qui lit « test sauté : changement de libellé, aucun comportement modifié » peut être en désaccord. Il ne peut pas l'ignorer.

Le statut `skipped` existant sert aujourd'hui aux étapes abandonnées faute de temps (`exitCode: 124`). Les deux cas ne doivent pas se confondre : une étape non retenue n'est pas une étape avortée.

## 4. Le nom affiché dans la consigne de relance

`relaunchFor` rend le nom affiché du compte dédié au lieu de son `accountId`. `JiraIssueTracker` sait déjà interroger un compte ; le nom est résolu une fois et mémorisé pour la durée du processus — c'est une donnée qui ne change jamais en pratique, et l'échec de sa résolution ne doit pas empêcher de poster un message.

Repli quand la résolution échoue : le texte s'écrit sans nommer personne (« réassignez le ticket au compte Sisyphe »), plutôt que d'imprimer un identifiant qui ne parle à personne.

## 5. Le traqueur d'origine d'un job

La table `jobs` gagne `issue_key TEXT` (nullable), écrite à la création depuis `issue.tracker?.key`.

- **Non nulle** : le job vient d'un ticket Jira, on le sait de source sûre, et la clé est exacte même si la configuration du dépôt change ensuite.
- **Nulle** : issue GitHub, ou job antérieur à cette migration. Lien GitHub.

`issueUrlOf` cesse de déduire le traqueur de `machine.jira` et lit `job.issueKey`. La déduction actuelle répond à « ce dépôt est-il sur Jira aujourd'hui ? » alors que la question est « ce job l'était-il ? ».

Aucune reprise des lignes existantes : elles restent nulles, donc GitHub, ce qui est juste pour toutes celles créées avant la bascule. Une ligne Jira créée entre la bascule et cette migration affichera un lien GitHub mort au lieu d'un lien Jira valide — sur un poste où la population concernée se compte sur les doigts d'une main, une reprise heuristique par date coûterait plus qu'elle ne rapporte.

La clé porte aussi une simplification : `src/deliver/deliver.ts` reconstruit aujourd'hui son `TicketRef` depuis `issue.tracker` et `machine.jira.site`, et la phase `jira` reçoit la clé par un chemin encore différent. À l'implémentation, vérifier si `job.issueKey` peut devenir la source unique — sans forcer, si le gain n'est pas net.

## 6. Tests

- **Périmètre retenu** : l'intersection triage × `commands` ; chacun des quatre faits d'élargissement, isolément ; le plancher `alwaysRun` ; un triage qui ne demande rien ne lance que `setup`.
- **Prompt d'implémentation** : sa phrase ne nomme que les étapes retenues.
- **Corps de PR** : une étape sautée porte sa raison, et la raison d'une étape non retenue se distingue de celle d'une étape avortée faute de temps.
- **`relaunchFor`** : le nom affiché est utilisé ; la résolution qui échoue donne un texte sans identifiant.
- **`issue_key`** : écrite à la création sous Jira, nulle sous GitHub ; `issueUrlOf` suit le job et non la configuration ; une ligne existante sans clé continue de rendre un lien GitHub après migration.

## 7. Hors périmètre

- La parallélisation des étapes de vérification.
- Un `testFast` déclaré par le dépôt : écarté au profit du choix par l'agent, qui couvre le même besoin sans demander au dépôt de savoir découper sa suite.
- La reprise des jobs Jira créés entre la bascule et cette migration (§5).
