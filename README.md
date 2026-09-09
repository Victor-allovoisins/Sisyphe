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
export ANTHROPIC_API_KEY=sk-ant-...
sisyphe setup && sisyphe doctor
```

`sisyphe setup` requiert une clé API Anthropic (console), pas un abonnement claude.ai. Les données vivent sous `~/.sisyphe` (redéfinissable via `SISYPHE_HOME`).

## Côté repo cible

Un fichier `sisyphe.yml` à la racine de la branche par défaut (exemple iOS : `examples/sisyphe.ios.yml`). Poser le label `sisyphe` sur une issue déclenche le traitement. Retirer le label annule. Les labels `sisyphe:in-progress`, `sisyphe:blocked`, `sisyphe:done`, `sisyphe:failed` sont posés par Sisyphe ; les retirer relance.

## Commandes

`sisyphe start [--once]`, `status`, `logs <jobId> [--phase triage|implement|setup|verify] [--raw]`, `report [--since 30d] [--repo owner/repo]`, `cancel <jobId>`, `doctor`, `setup`.

## Développement

`npm test`, `npm run typecheck`. Les tests d'intégration tournent sans réseau : remote git bare local, `FakeIssueSource`, `ScriptedAgentRunner`.
