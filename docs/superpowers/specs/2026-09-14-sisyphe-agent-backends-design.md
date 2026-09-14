# Sisyphe : backends agent claude-code, codex et opencode

Validé le 2026-09-14 avec Victor. Complète `2026-09-08-sisyphe-design.md` (§ backend agent) et `2026-09-14-sisyphe-settings-design.md` (onglet Réglages).

## 1. Objectif

Permettre de choisir l'outil qui exécute l'agent, depuis `agentBackend` et le menu BACKEND de l'onglet Réglages : **sdk** (Agent SDK Anthropic, clé API), **claude-code** (l'actuel `cli`, abonnement Claude Code), **codex** (OpenAI Codex CLI) et **opencode** (opencode CLI). Chaque outil doit pouvoir faire les trois phases — triage, implémentation, retry — et rendre la sortie structurée attendue par le pipeline.

Motivation : exploiter les abonnements/CLI déjà en place sur la machine plutôt qu'une clé API facturée, sans retirer le backend SDK.

## 2. Décisions

- **Enum** : `agentBackend: 'sdk' | 'claude-code' | 'codex' | 'opencode'`. La valeur historique `cli` reste **lue** comme alias de `claude-code` ; elle n'est jamais réécrite telle quelle. Aucune migration de base : `agentBackend` vit dans `config.yml`.
- **Modèles** : nouveau champ machine optionnel `agentModels: { triage?: string; implement?: string }`, utilisé par codex et opencode ; absent, chaque CLI applique son propre modèle par défaut. `sdk` et `claude-code` continuent d'utiliser `models.triage`/`models.implement` de `sisyphe.yml` (noms Claude). Choix retenu : surcharge machine, sinon défaut de la CLI — les `sisyphe.yml` existants ne bougent pas.
- **Sandbox** : `sandbox: true` reste réservé à `sdk`. codex et opencode tournent toujours dans leur mode sûr propre (codex `workspace-write`, opencode permissions bornées au worktree).
- **Chemins protégés bloquants** : `protectedPathsTouched` cesse d'être informatif ; un chemin protégé touché fait échouer le job, exactement comme un secret détecté. C'est la garantie qui compense l'absence de hook PreToolUse équivalent chez Codex.
- **Parité pragmatique, garanties inégales** : les limites de budget et de tours ne sont applicables qu'à `sdk`/`claude-code` ; pour codex/opencode, seul le timeout de Sisyphe borne le run, et le coût reporté est nul ou partiel. Ces écarts sont documentés, pas masqués.

## 3. Architecture

Un **adaptateur par CLI** derrière l'interface `AgentRunner` existante, plus un socle commun de sous-processus. Rejeté : une table « CLI générique » (les écarts schéma/hook/permissions en feraient un mini-langage) et un pont externe type `headless-cli` (dépendance ajoutée, moins de contrôle).

```
src/agent/
  runner.ts                 # interface, inchangée
  index.ts                  # NOUVEAU : createAgentRunner(backend, opts)
  sdk-runner.ts             # inchangé
  cli/
    process.ts              # NOUVEAU : spawn détaché, kill du groupe, grace, ring stderr, transcript sérialisé, lecteur JSONL
    claude-code-runner.ts   # DÉPLACÉ depuis cli-runner.ts, comportement identique
    codex-runner.ts         # NOUVEAU
    opencode-runner.ts      # NOUVEAU
```

Le contrat commun ne change pas : `AgentRunOptions` reste la seule entrée, chaque adaptateur écrit dans `o.transcriptPath` et rend un `AgentResult`. `output` est du JSON brut : le pipeline le valide déjà par zod (`TriageVerdictSchema`/`ImplementationReportSchema`, `pipeline.ts`). Aucun validateur n'est ajouté à l'interface.

`createAgentRunner(backend, { sandbox, models })` remplace la sélection en ligne dans `app.ts`. Le `sandbox` n'est transmis qu'au runner SDK.

## 4. Comportement par backend

| | sortie structurée | outils / permissions | garde-fou chemins | session | usage / coût |
|---|---|---|---|---|---|
| sdk | `structured_output` du SDK | options `tools`/`allowedTools` | hook SDK | `resume` | réel |
| claude-code | `--json-schema` | `--tools`/`--allowedTools`/`--disallowedTools` | hook `--settings` | `--resume` | renvoyé par la CLI |
| codex | `--output-schema <fichier>` + `-o <fichier>` | pas de liste : `--sandbox read-only` (triage) / `workspace-write` (implémentation) | bac à sable workspace + prompt (pas de hook) | `codex exec resume <id>` | tokens (`turn.completed`), coût 0 |
| opencode | dernier objet JSON du message final | `OPENCODE_PERMISSION` : allowlist (`*: deny` puis allow ciblé) | permissions `edit`/`read` par motif + `external_directory: deny` | `--session <id>` / `--continue` | événements, best-effort |

**codex.** Commande : `codex exec --json --cd <worktree> -m <modèle> --sandbox <mode> --output-schema <fichier> -o <fichier-résultat> --ignore-user-config [-c clé=valeur…]`, prompt sur stdin. Reprise : `codex exec resume <id>` avec les mêmes options. La sortie structurée est lue du fichier `-o` puis `JSON.parse` ; `sessionId` vient de `thread.started.thread_id`, l'usage de `turn.completed.usage`. Le bac à sable workspace est le mode safe ; les chemins protégés *à l'intérieur* du worktree ne sont couverts que par le prompt et le contrôle a posteriori (§8).

**opencode.** Commande : `opencode run --format json -m <provider/modèle> --auto <prompt>`, `OPENCODE_PERMISSION` en variable d'environnement. Sortie structurée : consigne « termine par un objet JSON conforme au schéma » puis extraction du dernier JSON du message final ; illisible → `output: null`, le pipeline retombe sur ses valeurs de repli. Session via `--session`/`--continue`. Usage/coût extraits des événements quand ils existent, sinon zéro.

Les noms exacts de champs d'événements et les clés de configuration (coupure web/MCP de codex, syntaxe et ordre des règles `OPENCODE_PERMISSION`) sont épinglés par une capture réelle avant de figer les adaptateurs.

## 5. Configuration

- `src/config/machine.ts` : nouvel enum, normalisation `cli` → `claude-code` au parse (les deux formes écrivent `claude-code`) ; `agentModels` en objet strict, champs chaînes non vides, optionnel ; `effectiveDailyBudget` inchangé (défaut 60 réservé à `sdk`, `undefined` partout ailleurs) ; le message de refus sandbox cite le backend.
- `src/daemon/control-types.ts` : `agentModels` ajouté à `RESTART_REQUIRED_FIELDS` — le runner est construit au démarrage, un changement de modèle exige un redémarrage. Le type `MachineFieldsClassified` force ce classement.
- `src/config/diff.ts` : comparateur `agentModels` (le `Record<RestartRequiredField, Same>` impose la complétude).
- `src/config/write.ts` : la règle sandbox devient « `sandbox: true` refusé si `agentBackend !== 'sdk'` ».
- `src/daemon/daemon.ts` : la logique budget/`needsRestart` reste valable telle quelle (elle porte déjà `agentBackend` dans `needsRestart`).

## 6. Environnement et authentification

`agentEnv(base, extra, backend)` (`src/verify/commands.ts`) :

- `sdk` : réajoute `ANTHROPIC_API_KEY`.
- `claude-code` : retire `ANTHROPIC_*`/`CLAUDE_*` (règle actuelle, étendue au nouveau nom).
- `codex` : retire `OPENAI_API_KEY`, pour forcer le login ChatGPT et éviter la bascule silencieuse sur l'API facturée — symétrique de la règle Claude.
- `opencode` : ne retire pas les clés fournisseur (modèle multi-fournisseur ; l'authentification attendue est `opencode auth login`).

`defaultServiceContext` (`src/service/index.ts`) est inchangé : la clé API n'est injectée dans le service que pour `sdk`. codex et opencode s'appuient sur leur session stockée sous `HOME`, déjà transmis au daemon. Les types `Pick<MachineConfig, 'agentBackend'>` sont élargis à l'enum complet.

## 7. Transcripts

`summarizeTranscript` (`src/cli/format.ts`) ne connaît aujourd'hui que les messages Claude. On **étend** sa reconnaissance aux formes codex (`item.completed` avec `item.type` `agent_message`/`command_execution`/`file_change`, `turn.completed`) et opencode (parties `text`/`tool`). Le chemin Claude et le transcript brut ne changent pas : `sisyphe logs --raw` et l'onglet de détail gardent les événements natifs, seule leur lecture résumée s'élargit.

## 8. Sécurité et limites

- **Un chemin protégé touché fait échouer le job** : `pipeline.ts` traite `protectedPathsTouched` comme `secretsFound` — commentaire, statut `failed`, cleanup, aucune PR. Vaut pour tous les backends, y compris Claude et le SDK.
- **codex** n'a pas de blocage *a priori* sur les fichiers protégés à l'intérieur du worktree : la barrière est le bac à sable workspace (rien hors worktree) plus le contrôle a posteriori bloquant ci-dessus.
- **opencode** exprime le garde-fou par ses permissions (`edit`/`read` en `deny` par motif), ce qui est un blocage a priori, mais la sémantique des motifs diffère des globs de `protectedPaths` : la traduction est à valider, et le contrôle a posteriori reste le filet.
- **Budget et tours** : `maxBudgetUsd` et `maxTurns` ignorés par codex/opencode ; seul le timeout de Sisyphe (kill du groupe de processus) borne un run. Le coût reporté pour codex est nul (abonnement) et best-effort pour opencode ; les KPI et `report` en tiennent compte sans se casser.
- Aucun secret nouveau ne circule : les CLI lisent leurs propres sessions sous `HOME`.

## 9. Setup et doctor

- `setup` : `validateBackend` accepte les quatre valeurs (et l'alias `cli`) ; `buildRawConfig` force `sandbox: false` pour tout backend autre que `sdk` ; `installService` vérifie que le binaire du backend choisi (`claude`/`codex`/`opencode`) est joignable sur le PATH que le service transmettra.
- `doctor` : checks adaptés au backend — `claude`/`claude auth status` (inchangé), équivalents codex (version + statut de login) et opencode (version + `opencode auth list`) ; la présence de `ANTHROPIC_API_KEY` ne concerne que `sdk`.

## 10. Interface

Onglet Réglages, groupe Agent : le select BACKEND prend les quatre valeurs ; deux champs `agentModels.triage` et `agentModels.implement` (surcharge codex/opencode, aide affichée) rejoignent le groupe. `FIELD_IDS` de `page.ts` gère les chemins `agentModels.*` pour placer les erreurs. Le bandeau de redémarrage couvre déjà `agentModels` par le seul ajout à `RESTART_REQUIRED_FIELDS`.

## 11. Tests

- Config : alias `cli` → `claude-code`, valeurs inconnues refusées, `agentModels` validé, classement restart, `sandbox` refusé hors `sdk`, comparateur de diff.
- Adaptateurs : construction des arguments (mode triage vs implémentation, reprise), lecture et parsing de la sortie structurée (cas conforme, illisible), extraction de session et d'usage, kill du groupe au timeout, écriture du transcript. Chaque adaptateur testé avec un faux binaire, comme `cli-runner.test.ts`.
- Env : `agentEnv` par backend (clé retirée ou non), injection de service inchangée pour `sdk`.
- Transcripts : échantillons codex et opencode résumés en lignes lisibles.
- Pipeline : un chemin protégé touché fait échouer le job et n'ouvre pas de PR.
- Setup/doctor : choix des quatre backends, vérification du binaire par backend, checks doctor adaptés.
- Page : les quatre options du select, les champs `agentModels`, toujours zéro `innerHTML`.

## 12. Hors périmètre

- Changer les modèles Claude de `sisyphe.yml` (ils restent valables pour `sdk`/`claude-code`).
- Configurer les modèles par backend dans `sisyphe.yml` (le réglage machine suffit).
- Pont multi-agents ou abstraction générique de CLI.
- Migration de `config.yml` : `cli` restant lu, aucune réécriture n'est nécessaire.
