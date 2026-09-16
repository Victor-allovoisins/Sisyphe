# signaler-un-bug

Skill d'entrée de Sisyphe, destiné aux personnes non techniques. Il mène un court entretien sur un bug rencontré, puis crée le ticket Jira et l'assigne au compte dédié — c'est l'assignation qui déclenche le traitement.

**Périmètre actuel : l'app iPhone seule** (projet Jira `IOS`). Un signalement sur Android ou sur le site web est rédigé proprement mais pas créé — la personne le copie vers le canal habituel. Pour ouvrir le skill à d'autres projets, éditer les étapes 10 et 11 de `SKILL.md`.

Il est conçu pour tourner sur **claude.ai / l'app Desktop**, avec le connecteur Atlassian actif — pas dans Claude Code : les personnes visées n'ont ni terminal ni clone du dépôt. Le connecteur GitHub de claude.ai ne conviendrait pas : il est en lecture seule, toute création d'issue y échoue en 403.

## Avant la mise en service

1. Vérifier que le connecteur Atlassian de claude.ai peut **créer un ticket et l'assigner** dans le projet `IOS`, pour chaque personne concernée.
2. Le compte Jira dédié est « Agent IA », déjà créé. Il doit être renseigné dans la config machine de Sisyphe (`sisyphe setup`), et le skill le nomme à l'étape 12 — les deux doivent désigner le même compte. Le skill n'en donne que le nom d'affichage : l'adresse et l'`accountId` vivent dans la config machine, hors du dépôt.
3. Confirmer que `sisyphe.yml` est bien commité à la racine de `develop` (la branche par défaut du dépôt iOS). Modèle : `examples/sisyphe.ios.yml`.

## Installation sur claude.ai

Téléverser `SKILL.md` (le skill est autonome, un seul fichier) dans les paramètres Capacités → Skills de l'organisation. Les personnes l'invoquent ensuite en décrivant simplement leur bug.

## Pourquoi ces contraintes

Le skill est écrit à rebours du triage de Sisyphe (`src/agent/prompts.ts`, `src/agent/schemas.ts`), qui classe chaque issue en `ready`, `needs_clarification`, `too_big` ou `out_of_scope`. Trois règles en découlent directement et ne doivent pas être assouplies :

- **Les captures d'écran sont invisibles au triage.** `renderIssueBlock` n'émet que le titre, le corps et les commentaires : aucune image, aucune pièce jointe. Le skill transcrit donc les captures en mots.
- **Aucun lien n'est ouvrable.** Une règle métier doit être citée mot pour mot dans le corps, jamais référencée par une URL Notion.
- **Un bug par ticket.** `limits.maxFilesEstimate` (15 sur iOS) fait basculer en `too_big` tout ticket qui mélange des sujets indépendants.
- **Pas de version cible.** La plupart de ces tickets vont au backlog ; Sisyphe part alors du tronc. Une version renseignée à tort enverrait le correctif sur une branche de release.
