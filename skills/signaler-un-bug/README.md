# signaler-un-bug

Skill d'entrée de Sisyphe, destiné aux personnes non techniques. Il mène un court entretien sur un bug rencontré, puis crée l'issue GitHub avec le label `sisyphe`.

**Périmètre actuel : l'app iPhone seule** (`ILokYou/ILokYou-iOS`). Un signalement sur Android ou sur le site web est rédigé proprement mais pas créé — la personne le copie vers le canal habituel. Pour ouvrir le skill à d'autres dépôts, éditer l'étape 10 de `SKILL.md`.

Il est conçu pour tourner sur **claude.ai / l'app Desktop**, avec le connecteur GitHub actif — pas dans Claude Code : les personnes visées n'ont ni terminal ni clone du dépôt.

## Avant la mise en service

1. Vérifier que le connecteur GitHub de claude.ai peut **créer des issues et poser des labels** sur `ILokYou/ILokYou-iOS`, pour chaque personne concernée.
2. Confirmer que `sisyphe.yml` est bien commité à la racine de `develop` (la branche par défaut du dépôt iOS) — sans lui, le label ne déclenche rien. Modèle : `examples/sisyphe.ios.yml`.

## Installation sur claude.ai

Téléverser `SKILL.md` (le skill est autonome, un seul fichier) dans les paramètres Capacités → Skills de l'organisation. Les personnes l'invoquent ensuite en décrivant simplement leur bug.

## Pourquoi ces contraintes

Le skill est écrit à rebours du triage de Sisyphe (`src/agent/prompts.ts`, `src/agent/schemas.ts`), qui classe chaque issue en `ready`, `needs_clarification`, `too_big` ou `out_of_scope`. Trois règles en découlent directement et ne doivent pas être assouplies :

- **Les captures d'écran sont invisibles au triage.** `renderIssueBlock` n'émet que le titre, le corps et les commentaires : aucune image, aucune pièce jointe. Le skill transcrit donc les captures en mots.
- **Aucun lien n'est ouvrable.** Une règle métier doit être citée mot pour mot dans le corps, jamais référencée par une URL Notion.
- **Un bug par ticket.** `limits.maxFilesEstimate` (15 sur iOS) fait basculer en `too_big` tout ticket qui mélange des sujets indépendants.
