# Sisyphe

Daemon qui prend les issues GitHub labellisées `sisyphe`, les fait trier puis implémenter par un agent Claude, vérifie lui-même build et tests, et ouvre une pull request documentée avec son coût et sa durée. Le matin, on relit des PR.

- Spec : `docs/superpowers/specs/2026-09-08-sisyphe-design.md`
- Plan : `docs/superpowers/plans/2026-09-08-sisyphe.md`
- Validation : `docs/playground.md`

## Prérequis (macOS)

Xcode (pour un repo iOS), puis `brew install node git gitleaks xcodegen`. Node ≥ 24.

## GitHub App

Une App GitHub `sisyphe[bot]`, permissions Contents (read & write), Issues (read & write), Pull requests (read & write), Metadata (read), installée uniquement sur les repos cibles (spec §9). Marche à suivre complète : `docs/playground.md` §1.

## Installation

```bash
npm install && npm run build && npm link
sisyphe setup && sisyphe doctor
```

`sisyphe setup` demande le backend agent, écrit dans la config machine sous `agentBackend` :

- `cli` : la CLI Claude Code installée localement (`claude -p`), donc l'abonnement claude.ai. C'est la réponse proposée par défaut à la question de `sisyphe setup` (le défaut du schéma, pour une config écrite à la main, reste `sdk`). Prérequis : `claude auth status --json` renvoie `loggedIn: true`. Le sandbox n'est pas supporté par ce backend.
- `sdk` : le Agent SDK, qui exige une clé API Anthropic (console) dans `ANTHROPIC_API_KEY` — `export ANTHROPIC_API_KEY=sk-ant-...` avant `sisyphe setup`.

Les données vivent sous `~/.sisyphe` (redéfinissable via `SISYPHE_HOME`).

## Côté repo cible

Un fichier `sisyphe.yml` à la racine de la branche par défaut (exemple iOS : `examples/sisyphe.ios.yml`). Poser le label `sisyphe` sur une issue déclenche le traitement. Retirer le label annule. Les labels `sisyphe:in-progress`, `sisyphe:blocked`, `sisyphe:done`, `sisyphe:failed` sont posés par Sisyphe ; les retirer relance.

## Commandes

`sisyphe start [--once]`, `status`, `logs <jobId> [--phase triage|implement|setup|verify] [--raw]`, `report [--since 30d] [--repo owner/repo]`, `cancel <jobId>`, `doctor`, `setup`.

## Développement

`npm test`, `npm run typecheck`. Les tests d'intégration tournent sans réseau : remote git bare local, `FakeIssueSource`, `ScriptedAgentRunner`.
