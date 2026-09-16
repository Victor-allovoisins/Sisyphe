---
name: signaler-un-bug
description: Utiliser quand quelqu'un raconte un bug, une anomalie ou un problème rencontré sur AlloVoisins (app iPhone, app Android, site web) et qu'il faut en faire un ticket GitHub. Se déclenche sur « j'ai un bug », « ça ne marche pas », « il y a un souci sur l'app », « signaler un problème », « créer un ticket », « ça plante quand je… ».
---

# Signaler un bug

## Le but

Transformer le récit d'une personne non technique en une issue GitHub qu'un agent de correction peut traiter **sans jamais poser de question**.

Un robot (Sisyphe) relit chaque ticket et le classe : `ready`, `needs_clarification`, `too_big`, `out_of_scope`. Seul `ready` déclenche une correction. Tout ce qui suit sert à décrocher `ready` du premier coup.

Trois contraintes gouvernent tout le reste. L'agent qui corrigera :

- **ne voit que du texte.** Les captures d'écran, les pièces jointes et les liens ne lui parviennent pas. Une image jointe à l'issue est invisible pour lui.
- **ne connaît que le code du dépôt.** Ni vos règles métier, ni vos comptes de test, ni le jargon interne.
- **ne peut poser aucune question** pendant son travail. Ce qui manque au ticket manquera pour de bon.

## La contrainte de temps

Cette personne a le choix entre te parler et créer le ticket à la main. Si ça traîne, elle ira à la main et le ticket sera mauvais.

**Deux échanges, trois au pire.** Et le plus souvent **un seul** : un bug d'apparence bien décrit n'appelle aucune question. Ce qui manque encore après une relance part dans le ticket sous « Ce qu'on n'a pas pu déterminer » — jamais en tour de questions supplémentaire.

Le réflexe qui fait tout : **relis son message avant d'écrire le tien**, et raye chaque question dont la réponse y est déjà.

## Déroulé

### 1. Écouter

Laisse la personne raconter. Si elle a ouvert avec « j'ai un bug » et rien d'autre : « Raconte-moi ce qui s'est passé. »

Ne pose aucune question à ce stade. Tu vas toutes les grouper à l'étape 3.

### 2. Écarter ce qui n'est pas une tâche de code

Avant toute chose, vérifie que ça vaut un ticket. **Ne crée rien** et oriente ailleurs si c'est :

| Ce que tu entends | Ce que c'est | Où ça va |
|---|---|---|
| « mon compte est bloqué », « je n'ai pas reçu le mail », « on m'a débité deux fois » | un cas utilisateur, pas un défaut du logiciel | le support |
| « il faudrait supprimer cette annonce », « ce membre est un faux » | de la modération de contenu | modération |
| « il faudrait qu'on puisse aussi faire X » (sujet large) | une demande produit | le chef de produit |
| « c'est lent chez moi » sans rien de plus | souvent du réseau, pas reproductible | creuse d'abord : est-ce reproductible, ailleurs, sur un autre réseau ? |

En revanche une **petite évolution bien cadrée** (« ce bouton devrait dire Annuler et pas Retour ») est légitime : traite-la exactement comme un bug, avec le comportement actuel et le comportement voulu.

Dis-le franchement et brièvement : « Ça, ce n'est pas un bug du code — c'est plutôt pour le support, ils pourront débloquer ton compte. » Pas de sermon.

### 3. Un bug = un ticket

Si la personne enchaîne plusieurs symptômes sans lien (« et puis aussi le bouton machin… »), ne fabrique pas un ticket fourre-tout : il sera classé `too_big` et rien ne sera corrigé.

Dis-le : « Il y a deux choses différentes là-dedans. On fait le premier maintenant, et on enchaîne sur le second juste après ? » Puis traite-les l'un après l'autre.

Deux symptômes qui viennent visiblement de la même cause (l'écran est vide **et** le compteur affiche 0) restent un seul ticket.

### 4. Ne demander que ce qui manque

**D'abord, fais la liste de ce que tu as déjà.** Beaucoup de signalements arrivent avec l'essentiel. Reposer une question dont la réponse est dans le message précédent est la meilleure façon de faire abandonner quelqu'un.

**Ensuite, déduis tout ce qui peut l'être** et annonce-le en **une seule ligne à la fin**, au lieu d'en faire des questions :

> Je pars du principe : app iPhone, ton compte habituel, version publique. Dis-moi si c'est faux.

Il ne reste alors qu'un ou deux vrais trous. C'est eux, et eux seuls, que tu demandes.

#### Calibrer sur la taille du bug

**Bug d'apparence** — couleur, libellé, faute d'orthographe, icône, alignement, élément coupé. Il te faut trois choses : **l'écran**, **l'élément précis**, **ce qu'il devrait être**. Souvent la personne a déjà tout dit : alors ne demande **rien** et passe directement à la rédaction. Une capture d'écran remplace les trois. Pas d'étapes de reproduction, pas de contexte de compte — ça n'entre pas en jeu.

**Bug de comportement** — ça plante, ça ne part pas, ça affiche la mauvaise donnée, ça ne se met pas à jour. Là il te faut vraiment les étapes et le comportement attendu, parce que c'est tout ce dont l'agent dispose.

#### Comment écrire les questions

- **Trois questions maximum.** Deux, c'est mieux. Si tu en comptes quatre, c'est qu'il y en a une que tu peux déduire.
- **Une ligne par question, pas de parenthèse explicative.** Une question qui a besoin d'être expliquée est mal posée.
- **Ne demande jamais ce qui ne changera pas le correctif.** Le modèle d'iPhone, la version exacte, le type de compte : utiles parfois, jamais bloquants. Ils vont dans la ligne d'hypothèses, pas dans une question.
- **Interdiction absolue : ne jamais proposer de valeur pour les étapes ni pour le comportement attendu.** Ce sont les deux seuls éléments dont le triage a réellement besoin et les deux seuls que tu ne peux pas deviner. Si tu les pré-remplis, la personne validera ta version et le ticket sera faux.

#### Exemples

Bug d'apparence, tout est déjà dit — **ne demande rien**, rédige :

> Compris. Juste pour être sûr de viser le bon écran : ce bandeau, il apparaît sur l'accueil ou ailleurs ?

Bug de comportement :

```
Deux questions et c'est parti.

1. Les étapes depuis l'ouverture de l'app, pour retomber dessus ?
2. Qu'est-ce que tu as vu, et qu'est-ce que tu attendais à la place ?

Je pars du principe : app iPhone, ton compte habituel, version publique — dis-moi si c'est faux. Une capture aide toujours.
```

### 5. Les captures d'écran

L'agent ne les verra pas. Toi si.

Quand la personne en envoie une, **transcris-la en mots** dans le ticket : le message d'erreur **mot pour mot**, les valeurs affichées, ce qui est vide ou grisé, ce qui devrait être là et ne l'est pas. Ne mets jamais « voir la capture » dans le corps du ticket — c'est un cul-de-sac pour l'agent.

Joins quand même l'image à l'issue : elle sert aux humains qui reliront.

### 6. La relance unique

Sur un bug d'apparence, il n'y a normalement rien à relancer : passe à la rédaction.

Sur un bug de comportement, relis les réponses et relance **une seule fois**, uniquement sur ce qui bloque vraiment :

- les étapes ne permettent pas à quelqu'un qui n'a jamais ouvert l'app de rejouer la scène ;
- le comportement attendu est une négation (« ça devrait pas faire ça ») sans dire ce qui devrait arriver ;
- un message d'erreur est évoqué mais pas cité ;
- il manque de quoi savoir quelle app est concernée.

Ne relance jamais pour du confort (« tu aurais la version exacte ? ») quand ça n'empêche pas de corriger.

Après cette relance, tu arrêtes de demander. Ce qui manque encore va dans la section « Ce qu'on n'a pas pu déterminer ».

### 7. La règle métier — seulement si nécessaire

Le cas qui bloque le plus souvent : la personne dit « ça n'aurait pas dû être possible » sans savoir énoncer la règle. L'agent, lui, ne connaît pas la règle non plus.

**Uniquement dans ce cas**, fais **une** recherche Notion sur le sujet concerné. Si tu trouves un passage net, **cite-le mot pour mot** dans le ticket et nomme la page. Sinon, écris la version de la personne telle quelle et passe à la suite.

- Une recherche, pas trois. On ne fait pas attendre la personne.
- **Jamais un lien Notion seul** : l'agent ne peut pas l'ouvrir. Le texte de la règle doit être dans le corps du ticket.
- **N'invente jamais une règle.** Une règle fausse envoie l'agent corriger un comportement correct.

**Si la règle trouvée contredit ce que la personne attendait, il n'y a pas de bug.** Dis-le-lui simplement — « en fait c'est prévu comme ça : *<la règle>* » — et ne crée pas de ticket. C'est le cas le plus fréquent sur les sujets d'abonnement, de quota et de périmètre.

**Si tu ne trouves pas la règle et que la personne ne sait pas l'énoncer, ne crée pas le ticket non plus.** Un ticket dont le comportement attendu se résume à « il faudra confirmer la règle » sera classé `needs_clarification` d'office : la seule chose qui manque est justement celle dont l'agent a besoin. Dis à la personne d'aller faire confirmer la règle par le chef de produit, et propose de reprendre le ticket ensuite — tu garderas tout ce qui a déjà été collecté.

En revanche, quand le comportement attendu tient debout **sans** la règle chiffrée (« l'écran d'abonnement aurait dû s'afficher à l'étape 4 » suffit, même si le seuil exact est inconnu), le ticket est valable : décris le blocage attendu, et n'écris rien sur le seuil.

### 8. Rédiger le ticket

**Titre** : le symptôme, à l'endroit où il arrive, en une ligne. Pas de « Bug » ni de « Problème » en préfixe.

- Bon : `La photo de profil disparaît après l'enregistrement du profil`
- Mauvais : `Bug profil` · `Problème avec les photos` · `URGENT ça marche pas`

**Corps d'un bug d'apparence** — forme courte, c'est tout ce qu'il faut :

```markdown
## Ce qui ne va pas

Sur l'écran d'accueil, le texte du bandeau de réabonnement s'affiche en jaune.

## Où

- Surface : app iPhone
- Écran : accueil, bandeau de réabonnement affiché après connexion
- Élément : le texte du bandeau (« Votre abonnement a expiré »)

## Ce qui devrait se passer

Le texte doit être en orange 70, la couleur utilisée pour ce bandeau.

---
Ticket rédigé avec Claude à partir du signalement de @<personne>.
```

Ni étapes, ni contexte de compte : ils n'apportent rien sur un défaut d'apparence, et le triage n'en a pas besoin pour localiser une couleur.

**Corps d'un bug de comportement** : le gabarit complet ci-dessous. **Toute section vide est supprimée**, pas laissée avec « N/A ».

```markdown
## Ce qui ne va pas

Une phrase.

## Où

- Surface : app iPhone
- Écran ou parcours : …
- Version et appareil : …

## Pour reproduire

1. …
2. …
3. …

## Ce qui se passe

… (message d'erreur cité mot pour mot s'il y en a un)

## Ce qui devrait se passer

…

## Contexte du compte

… (particulier/pro, rôle, abonnement, et **environnement : app publique ou recette/TestFlight**)

## Règle métier concernée

> citation mot pour mot

Source : <titre de la page Notion>

## Ce qu'on n'a pas pu déterminer

- … (détails secondaires uniquement — jamais le comportement attendu, voir l'étape 9)

---
Ticket rédigé avec Claude à partir du signalement de @<personne>.
```

Écris dans la langue de la personne, sans jargon.

**N'écris aucune hypothèse technique.** Pas de nom de fichier, pas de nom de fonction, pas de « ça vient sûrement du cache ». Tu n'as pas lu le code, et une fausse piste envoie l'agent au mauvais endroit — il sait chercher tout seul.

### 9. Se relire avant de créer

Relis ton propre corps de ticket et corrige-le toi-même, sans redemander à la personne :

- [ ] Quelqu'un qui n'a jamais ouvert l'app peut-il rejouer les étapes telles qu'elles sont écrites ?
- [ ] « Ce qui devrait se passer » est-il une phrase affirmative, et non une négation ?
- [ ] Les messages d'erreur sont-ils cités mot pour mot, pas résumés ?
- [ ] Reste-t-il un « voir la capture », un lien, ou une image non transcrite ?
- [ ] Reste-t-il un nom de fichier, une hypothèse technique, du jargon interne non expliqué ?
- [ ] Chaque détail d'interface vient-il de la personne, sans précision que tu aurais ajoutée ? Elle peut se tromper d'élément (« la roue était sur le bouton » alors qu'elle était ailleurs) : écris ce qu'elle a dit, sans le rendre plus net qu'il ne l'est.
- [ ] Est-ce bien un seul sujet ?
- [ ] Les sections vides ont-elles été supprimées ?

### 10. Vérifier que c'est bien l'app iPhone

**Pour l'instant, seule l'app iPhone est traitée automatiquement.** Dépôt : `ILokYou/ILokYou-iOS`.

Si la personne décrit un problème sur **Android** ou sur le **site web**, ne crée pas de ticket. Dis-le franchement :

> Pour l'instant on ne traite automatiquement que l'app iPhone. Ton signalement est clair, mais il faut le passer par le canal habituel — je te le mets au propre si tu veux le copier-coller.

Puis affiche quand même le titre et le corps rédigés : le travail d'entretien n'est pas perdu, elle les colle où elle a l'habitude.

Un doute sur la surface se lève en une question, jamais plus : « c'était sur ton iPhone ou sur ton ordinateur ? »

Note enfin que la cause d'un bug vu dans l'app peut être côté serveur — ce n'est pas ton problème. Décris le symptôme tel qu'il a été vu, crée le ticket sur `ILokYou/ILokYou-iOS`, et laisse le triage trancher. S'il constate que la cause est ailleurs, il le dira en commentaire.

Une seule exception à signaler : si la personne dit avoir vu **le même symptôme aussi sur le site ou sur Android**, ajoute cette ligne dans « Où », elle vaut de l'or pour le diagnostic :

```
Constaté aussi sur : site web (même symptôme).
```

### 11. Créer l'issue

Montre le titre et le corps, demande « je crée ? », attends le oui.

Puis crée l'issue sur `ILokYou/ILokYou-iOS` avec le label **`sisyphe`**. C'est ce label qui déclenche le traitement : sans lui, il ne se passe rien.

Si la création échoue (droits manquants sur le dépôt), ne perds pas le travail : affiche le titre et le corps dans un bloc à copier, et dis à la personne de les coller sur GitHub en ajoutant le label `sisyphe` elle-même.

### 12. Dire où la suite se passera

Cette personne t'a parlé dans un chat. Elle n'ira pas d'elle-même relire un fil GitHub. Termine toujours par :

> C'est créé : <lien>. Si l'agent a besoin d'une précision, il écrira en commentaire sur ce ticket et tu recevras une notification GitHub. Reviens me voir avec sa question, on y répondra ensemble.

Sans cette phrase, une demande de précision reste sans réponse et le ticket meurt.

## Erreurs fréquentes

| Erreur | Pourquoi c'est grave | À faire |
|---|---|---|
| Pré-remplir les étapes ou le comportement attendu | La personne valide ta version : le ticket décrit ton hypothèse, pas son bug | Les laisser vides, toujours |
| Laisser « voir la capture » | L'agent ne voit aucune image : le ticket devient inexploitable | Transcrire la capture en mots |
| Mettre un lien Notion ou Jira à la place du texte | L'agent ne peut ouvrir aucun lien | Citer le passage mot pour mot |
| Ajouter « ça vient sûrement de… » | Envoie l'agent sur une fausse piste et lui fait perdre sa tentative | Décrire le symptôme, rien d'autre |
| Enchaîner un troisième tour de questions | La personne décroche et repart créer ses tickets à la main | Écrire ce qui manque dans « Ce qu'on n'a pas pu déterminer » |
| Grouper plusieurs bugs | Classé `too_big`, rien n'est corrigé | Un ticket par bug |
| Oublier le label `sisyphe` | Le ticket dort indéfiniment | Toujours poser le label |
| Résumer un message d'erreur | Le texte exact est souvent la seule piste de recherche | Le citer mot pour mot |

## Signaux d'alerte — reprends l'étape correspondante

- Tu t'apprêtes à poser une sixième question → étape 6, tu as déjà fait ta relance.
- Tu écris « probablement », « sans doute », « il semble que » dans le corps → tu formules une hypothèse, retire-la.
- Tu as écrit « l'utilisateur » dans les étapes → réécris avec ce que la personne a fait, concrètement.
- Tu n'as pas demandé le comportement attendu parce qu'« il est évident » → il ne l'est jamais pour l'agent. Demande.
