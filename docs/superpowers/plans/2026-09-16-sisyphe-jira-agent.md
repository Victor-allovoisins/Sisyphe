# Workflow Jira confié à l'agent — plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une phase d'agent dédiée décide du statut Jira d'arrivée et du commentaire à chaque fin de job, le daemon garde un filet, et la clé du ticket apparaît dans le commit et la PR pour que l'app GitHub for Jira relie les deux.

**Architecture:** Une commande `sisyphe jira` expose le client Jira existant (verbes d'écriture fixes, passe-plat en lecture seule). Un skill livré dans le repo, chargé comme plugin local, apprend à l'agent à s'en servir. `finish()` devient le point de sortie unique du pipeline : il déclenche la phase `jira`, puis fait respecter deux invariants sur le ticket. Le nommage de la PR reste en TypeScript.

**Tech Stack:** TypeScript strict ESM, vitest, commander, zod, Agent SDK Claude.

**Spec:** `docs/superpowers/specs/2026-09-16-sisyphe-jira-agent-design.md`

---

## Structure des fichiers

**Créés**

| Fichier | Responsabilité |
| --- | --- |
| `src/jira/links.ts` | Fabrique les URL Jira (`browseUrl`). Seul endroit qui connaît la forme `/browse/KEY`. |
| `src/cli/commands/jira.ts` | Les six verbes de la commande `sisyphe jira`. Traduit clé → `IssueRef`, formate la sortie. |
| `src/agent/bash-guard.ts` | Décide si une commande Bash est permise (`decideBash`). Pur, sans I/O. |
| `src/agent/bash-guard-cli.ts` | Le même garde-fou en script autonome pour le backend `claude-code`. |
| `src/jobs/jira-sync.ts` | La phase `jira` : prompt, appel agent, filet d'invariants. Isolée du pipeline pour être testable seule. |
| `agent-plugin/.claude-plugin/plugin.json` | Manifeste du plugin local livré avec Sisyphe. |
| `agent-plugin/skills/sisyphe-jira/SKILL.md` | Le skill : pattern de transition, verbes disponibles, règles de commentaire. |

**Modifiés**

| Fichier | Changement |
| --- | --- |
| `src/jira/client.ts` | `refFromKey`, `listTransitions`, `get` (lecture brute). |
| `src/ui/data.ts` | `issueUrlOf` passe par `browseUrl`. |
| `src/deliver/deliver.ts` | `commitMessage`/`prTitle` portent la clé ; `DeliverInput.ticket`. |
| `src/deliver/pr-body.ts` | `Ticket: [KEY](url)` en tête, `Closes #N` seulement sous GitHub. |
| `src/agent/runner.ts` | `bashGuard` dans `AgentRunOptions`. |
| `src/agent/sdk-runner.ts`, `src/agent/cli/claude-code-runner.ts` | Câblage du `bashGuard` et du plugin local. |
| `src/store/types.ts` | `PhaseName` gagne `'jira'`. |
| `src/jobs/pipeline.ts` | `finish()` devient async et centralise la sortie ; les 8 `setStatus`/`comment` disparaissent. |
| `src/cli/index.ts` | Enregistre `sisyphe jira`. |

---

## Task 0 : vérifier que le skill se charge (bloquant)

**Pourquoi d'abord :** toute la Task 7 suppose qu'un plugin local est visible avec `settingSources: []`. Si ce n'est pas le cas, le skill devient un bloc du prompt et la Task 7 change de forme. Vingt minutes ici évitent de réécrire trois tâches.

**Files:**
- Create: `/private/tmp/claude-502/-Users-victor-Developer-Others-Sisyphe/<session>/scratchpad/probe/` (jetable, hors du repo)

- [ ] **Step 1 : fabriquer un plugin minimal**

```bash
P=$(mktemp -d)/plug
mkdir -p "$P/.claude-plugin" "$P/skills/probe-skill"
cat > "$P/.claude-plugin/plugin.json" <<'JSON'
{ "name": "probe", "version": "0.0.1", "description": "sonde de chargement" }
JSON
cat > "$P/skills/probe-skill/SKILL.md" <<'MD'
---
name: probe-skill
description: Use when asked for the probe word. Returns the secret probe word.
---
Le mot de sonde est : MARMOTTE. Réponds uniquement ce mot.
MD
echo "$P"
```

- [ ] **Step 2 : lancer l'agent dans les conditions de Sisyphe**

Écrire `probe.mjs` à côté, puis l'exécuter avec `ANTHROPIC_API_KEY` dans l'environnement :

```javascript
import { query } from '@anthropic-ai/claude-agent-sdk';
const plugin = process.argv[2];
const q = query({
  prompt: 'Invoque le skill probe-skill et donne-moi le mot de sonde.',
  options: {
    settingSources: [],
    permissionMode: 'dontAsk',
    plugins: [{ type: 'local', path: plugin }],
    skills: ['probe:probe-skill'],
    maxTurns: 6,
  },
});
for await (const m of q) if (m.type === 'result') console.log(JSON.stringify(m, null, 2));
```

Run: `node probe.mjs "$P"`
Expected: la réponse contient `MARMOTTE`.

- [ ] **Step 3 : même vérification sur le backend `claude-code`**

```bash
claude -p --setting-sources '' --strict-mcp-config --permission-mode dontAsk \
  --plugin-dir "$P" "Invoque le skill probe-skill et donne-moi le mot de sonde."
```

Expected: la réponse contient `MARMOTTE`.

- [ ] **Step 4 : consigner le résultat dans la spec**

Ajouter deux lignes à la fin de la §5 de `docs/superpowers/specs/2026-09-16-sisyphe-jira-agent-design.md` : ce qui a été essayé, ce qui a marché, la date. Si l'un des deux backends échoue, écrire **ce qui a échoué exactement** (message d'erreur) et s'arrêter pour en parler — ne pas continuer le plan sur une hypothèse fausse.

- [ ] **Step 5 : commit**

```bash
git add docs/superpowers/specs/2026-09-16-sisyphe-jira-agent-design.md
git commit -m "docs(spec): résultat de la sonde de chargement du plugin local"
```

---

## Task 1 : `browseUrl`, un seul endroit qui connaît la forme des URL Jira

**Files:**
- Create: `src/jira/links.ts`
- Create: `src/jira/links.test.ts`
- Modify: `src/ui/data.ts` (fonction `issueUrlOf`)

- [ ] **Step 1 : écrire le test qui échoue**

`src/jira/links.test.ts` :

```typescript
import { describe, expect, it } from 'vitest';
import { browseUrl } from './links.js';

describe('browseUrl', () => {
  it('compose l’URL de consultation d’un ticket', () => {
    expect(browseUrl('acme.atlassian.net', 'IOS-886')).toBe('https://acme.atlassian.net/browse/IOS-886');
  });
});
```

- [ ] **Step 2 : lancer le test et le voir échouer**

Run: `npx vitest run src/jira/links.test.ts`
Expected: FAIL — `Failed to resolve import "./links.js"`.

- [ ] **Step 3 : écrire l'implémentation**

`src/jira/links.ts` :

```typescript
/**
 * L'URL de consultation d'un ticket. Seul endroit qui connaît cette forme : l'UI, le corps de PR et les
 * commentaires la réclament tous, et une deuxième écriture littérale finirait par diverger.
 */
export function browseUrl(site: string, key: string): string {
  return `https://${site}/browse/${key}`;
}
```

- [ ] **Step 4 : lancer le test et le voir passer**

Run: `npx vitest run src/jira/links.test.ts`
Expected: PASS.

- [ ] **Step 5 : faire passer l'UI par le même helper**

Dans `src/ui/data.ts`, ajouter l'import `import { browseUrl } from '../jira/links.js';` et remplacer le corps de `issueUrlOf` :

```typescript
export function issueUrlOf(links: JiraLinks | null, repo: string, issueNumber: number): string {
  const key = links?.keys[repo];
  if (links && key) return browseUrl(links.site, `${key}-${issueNumber}`);
  return `https://github.com/${repo}/issues/${issueNumber}`;
}
```

- [ ] **Step 6 : vérifier que rien n'a bougé côté UI**

Run: `npx vitest run src/ui src/jira`
Expected: PASS, y compris `issueUrl pointe sur le ticket Jira du projet qui sert ce dépôt`.

- [ ] **Step 7 : commit**

```bash
git add src/jira/links.ts src/jira/links.test.ts src/ui/data.ts
git commit -m "refactor(jira): un seul endroit fabrique les URL /browse"
```

---

## Task 2 : le client Jira sait résoudre une clé et lire brut

`sisyphe jira show IOS-886` reçoit une clé ; le client, lui, travaille en `IssueRef` (`{repo, number}`). Il faut le chemin inverse. Il faut aussi deux lectures que la CLI expose et que le client ne publie pas encore.

**Files:**
- Modify: `src/jira/client.ts`
- Modify: `src/jira/client.test.ts`

- [ ] **Step 1 : écrire les tests qui échouent**

Ajouter à `src/jira/client.test.ts` (adapter le nom du constructeur de fixture à celui déjà utilisé dans le fichier) :

```typescript
describe('refFromKey', () => {
  it('résout une clé vers le dépôt du projet qui la sert', () => {
    const tracker = new JiraIssueTracker({
      site: 'acme.atlassian.net', email: 'bot@acme.io', apiToken: 't',
      projects: [{ key: 'IOS', accountId: 'acc', repo: 'acme/ios', candidateStatuses: ['Nouveau'], statusesInOrder: ['Nouveau', 'Fermé'], inProgressStatus: 'Nouveau', doneStatus: 'Fermé' }],
    });
    expect(tracker.refFromKey('IOS-886')).toEqual({ repo: parseRepo('acme/ios'), number: 886 });
    expect(() => tracker.refFromKey('BACK-1')).toThrow(/BACK/);
    expect(() => tracker.refFromKey('IOS')).toThrow(/IOS/);
  });
});

describe('get', () => {
  it('ne laisse passer qu’un chemin de lecture de l’API Jira', async () => {
    const calls: string[] = [];
    const tracker = trackerWithFetch(calls, { ok: true });
    await tracker.get('/rest/api/3/issue/IOS-886/changelog');
    expect(calls).toEqual(['GET https://acme.atlassian.net/rest/api/3/issue/IOS-886/changelog']);
    for (const bad of ['https://evil.example/x', '/rest/api/3/../../admin', 'rest/api/3/issue', '/plugins/servlet/x']) {
      await expect(tracker.get(bad)).rejects.toThrow(/chemin/i);
    }
  });
});
```

- [ ] **Step 2 : lancer les tests et les voir échouer**

Run: `npx vitest run src/jira/client.test.ts`
Expected: FAIL — `tracker.refFromKey is not a function`.

- [ ] **Step 3 : implémenter**

Dans `src/jira/client.ts`, ajouter la carte inverse au constructeur, à côté de `byRepo` :

```typescript
  private readonly byKey = new Map<string, JiraProject>();
```

et dans le constructeur, dans la boucle existante :

```typescript
    for (const p of cfg.projects) {
      this.byRepo.set(p.repo, p);
      this.byKey.set(p.key, p);
    }
```

Puis les trois méthodes publiques :

```typescript
  /**
   * Le chemin inverse de `key()` : la CLI reçoit `IOS-886`, le reste du code travaille en `IssueRef`.
   * Un projet inconnu est une erreur de configuration, pas un cas courant — on le dit plutôt que de deviner.
   */
  refFromKey(key: string): IssueRef {
    const number = numberFromKey(key);
    const prefix = key.slice(0, key.lastIndexOf('-'));
    if (number === null || !prefix) throw new Error(`Clé Jira invalide : ${key} (attendu PROJET-123)`);
    const project = this.byKey.get(prefix);
    if (!project) throw new Error(`Aucun projet Jira configuré pour la clé ${key}`);
    return { repo: parseRepo(project.repo), number };
  }

  /** Les transitions disponibles depuis le statut courant. Ce que `walkTo` consomme, exposé pour la CLI. */
  async listTransitions(ref: IssueRef): Promise<JiraTransition[]> {
    const r = await this.request<{ transitions?: JiraTransition[] }>(
      'GET',
      `/rest/api/3/issue/${encodeURIComponent(this.key(ref))}/transitions`,
    );
    return r.transitions ?? [];
  }

  /**
   * Lecture brute de l'API Jira, pour ce que les verbes fixes ne couvrent pas. Strictement un GET sous
   * `/rest/api/` : c'est la frontière entre « l'agent peut tout lire » et « l'agent peut écrire », et elle
   * est tenue ici, pas dans la CLI — une deuxième porte d'entrée finirait par ne pas vérifier la même chose.
   */
  async get<T = unknown>(path: string): Promise<T> {
    if (!path.startsWith('/rest/api/') || path.includes('..')) {
      throw new Error(`Chemin refusé : ${path} (attendu un chemin de lecture sous /rest/api/)`);
    }
    return this.request<T>('GET', path);
  }
```

Ajouter `parseRepo` à l'import existant de `../github/source.js`.

- [ ] **Step 4 : lancer les tests et les voir passer**

Run: `npx vitest run src/jira/client.test.ts`
Expected: PASS.

- [ ] **Step 5 : commit**

```bash
git add src/jira/client.ts src/jira/client.test.ts
git commit -m "feat(jira): résolution d'une clé et lecture brute de l'API"
```

---

## Task 3 : la commande `sisyphe jira`

**Files:**
- Create: `src/cli/commands/jira.ts`
- Create: `src/cli/commands/jira.test.ts`
- Modify: `src/cli/index.ts`

- [ ] **Step 1 : écrire les tests qui échouent**

`src/cli/commands/jira.test.ts` :

```typescript
import { describe, expect, it, vi } from 'vitest';
import { parseRepo, type IssueRef } from '../../github/source.js';
import { runJiraVerb, type JiraCli } from './jira.js';

const ref: IssueRef = { repo: parseRepo('acme/ios'), number: 886 };

function fake(over: Partial<JiraCli> = {}): JiraCli {
  return {
    refFromKey: () => ref,
    getIssue: async () => ({
      repo: ref.repo, number: 886, title: 'Couleur', body: 'corps', author: 'Victor',
      state: 'open', labels: [], comments: [],
      tracker: { key: 'IOS-886', issueType: 'Bug', fixVersions: [], status: 'En développement' },
    }),
    listTransitions: async () => [{ id: '31', to: { name: 'En relecture' } }],
    transitionTo: async () => ({ hops: ['A relire', 'En relecture'] }),
    comment: async () => undefined,
    addTriggerLabel: async () => undefined,
    removeTriggerLabel: async () => undefined,
    get: async () => ({ values: [] }),
    ...over,
  };
}

describe('runJiraVerb', () => {
  it('show rend le ticket en JSON, statut et clé compris', async () => {
    const out = await runJiraVerb(fake(), { verb: 'show', key: 'IOS-886' });
    expect(JSON.parse(out)).toMatchObject({ key: 'IOS-886', status: 'En développement', title: 'Couleur' });
  });

  it('transitions liste les statuts atteignables, pas les noms de transition', async () => {
    const out = await runJiraVerb(fake(), { verb: 'transitions', key: 'IOS-886' });
    expect(JSON.parse(out)).toEqual([{ id: '31', to: 'En relecture' }]);
  });

  it('transition rend la suite des sauts effectués', async () => {
    const out = await runJiraVerb(fake(), { verb: 'transition', key: 'IOS-886', target: 'En relecture' });
    expect(out).toContain('A relire → En relecture');
  });

  it('comment refuse un corps vide plutôt que de poster du vide', async () => {
    await expect(runJiraVerb(fake(), { verb: 'comment', key: 'IOS-886', body: '   ' })).rejects.toThrow(/vide/i);
  });

  it('assign --back rend le ticket, assign --bot le reprend', async () => {
    const back = vi.fn(async () => undefined);
    const bot = vi.fn(async () => undefined);
    await runJiraVerb(fake({ removeTriggerLabel: back }), { verb: 'assign', key: 'IOS-886', to: 'back' });
    await runJiraVerb(fake({ addTriggerLabel: bot }), { verb: 'assign', key: 'IOS-886', to: 'bot' });
    expect(back).toHaveBeenCalledOnce();
    expect(bot).toHaveBeenCalledOnce();
  });

  it('get passe le chemin au client, qui décide de l’accepter', async () => {
    const get = vi.fn(async () => ({ values: [] }));
    await runJiraVerb(fake({ get }), { verb: 'get', path: '/rest/api/3/issue/IOS-886/changelog' });
    expect(get).toHaveBeenCalledWith('/rest/api/3/issue/IOS-886/changelog');
  });
});
```

- [ ] **Step 2 : lancer les tests et les voir échouer**

Run: `npx vitest run src/cli/commands/jira.test.ts`
Expected: FAIL — `Failed to resolve import "./jira.js"`.

- [ ] **Step 3 : écrire l'implémentation**

`src/cli/commands/jira.ts` :

```typescript
import { createApp } from '../../app.js';
import type { Issue, IssueRef } from '../../github/source.js';
import type { JiraTransition } from '../../jira/transitions.js';

/**
 * Ce que la commande attend de son client Jira. Un sous-ensemble nommé plutôt que `JiraIssueTracker`
 * entier : les tests passent un faux, et la liste dit d'un coup d'œil ce que l'agent peut atteindre.
 */
export interface JiraCli {
  refFromKey(key: string): IssueRef;
  getIssue(ref: IssueRef): Promise<Issue>;
  listTransitions(ref: IssueRef): Promise<JiraTransition[]>;
  transitionTo(ref: IssueRef, target: string): Promise<{ hops: string[] }>;
  comment(ref: IssueRef, markdown: string): Promise<void>;
  addTriggerLabel(ref: IssueRef): Promise<void>;
  removeTriggerLabel(ref: IssueRef): Promise<void>;
  get<T>(path: string): Promise<T>;
}

export type JiraVerb =
  | { verb: 'show'; key: string }
  | { verb: 'transitions'; key: string }
  | { verb: 'transition'; key: string; target: string }
  | { verb: 'comment'; key: string; body: string }
  | { verb: 'assign'; key: string; to: 'back' | 'bot' }
  | { verb: 'get'; path: string };

/** Sortie destinée à un agent : JSON pour ce qui se relit, une phrase pour ce qui s'est passé. */
export async function runJiraVerb(client: JiraCli, v: JiraVerb): Promise<string> {
  if (v.verb === 'get') return JSON.stringify(await client.get(v.path), null, 2);
  const ref = client.refFromKey(v.key);
  switch (v.verb) {
    case 'show': {
      const issue = await client.getIssue(ref);
      return JSON.stringify(
        {
          key: issue.tracker?.key ?? v.key,
          title: issue.title,
          status: issue.tracker?.status ?? '',
          issueType: issue.tracker?.issueType ?? '',
          fixVersions: issue.tracker?.fixVersions ?? [],
          state: issue.state,
          body: issue.body,
          comments: issue.comments,
        },
        null,
        2,
      );
    }
    case 'transitions': {
      const list = await client.listTransitions(ref);
      // Le statut d'arrivée, pas le nom de la transition : c'est sur lui qu'on apparie, et l'exposer
      // évite que l'agent se fie à un libellé qui ne dit pas où il atterrit.
      return JSON.stringify(list.map((t) => ({ id: t.id, to: t.to.name })), null, 2);
    }
    case 'transition': {
      const { hops } = await client.transitionTo(ref, v.target);
      return hops.length ? `${v.key} : ${hops.join(' → ')}` : `${v.key} : déjà dans « ${v.target} »`;
    }
    case 'comment': {
      if (!v.body.trim()) throw new Error('Corps de commentaire vide : rien à poster.');
      await client.comment(ref, v.body);
      return `${v.key} : commentaire posté.`;
    }
    case 'assign': {
      if (v.to === 'bot') {
        await client.addTriggerLabel(ref);
        return `${v.key} : assigné au compte Sisyphe.`;
      }
      await client.removeTriggerLabel(ref);
      return `${v.key} : rendu à la personne qui l'a confié.`;
    }
  }
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/** Point d'entrée CLI : construit le vrai client, exécute, imprime. Le jeton ne quitte jamais `~/.sisyphe`. */
export async function jiraCommand(argv: string[]): Promise<void> {
  const app = await createApp({ needsAgent: false });
  if (!app.jira) throw new Error('Aucune section `jira` dans la configuration machine : commande indisponible.');
  const [verb, ...rest] = argv;
  let parsed: JiraVerb;
  switch (verb) {
    case 'show':
    case 'transitions':
      parsed = { verb, key: required(rest[0], 'clé de ticket') };
      break;
    case 'transition':
      parsed = { verb, key: required(rest[0], 'clé de ticket'), target: required(rest[1], 'statut cible') };
      break;
    case 'comment':
      parsed = { verb, key: required(rest[0], 'clé de ticket'), body: await readStdin() };
      break;
    case 'assign':
      parsed = { verb, key: required(rest[0], 'clé de ticket'), to: rest.includes('--bot') ? 'bot' : 'back' };
      break;
    case 'get':
      parsed = { verb, path: required(rest[0], 'chemin API') };
      break;
    default:
      throw new Error(`Verbe inconnu : ${verb ?? '(aucun)'} (attendu show, transitions, transition, comment, assign, get)`);
  }
  console.log(await runJiraVerb(app.jira, parsed));
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Argument manquant : ${what}.`);
  return value;
}
```

- [ ] **Step 4 : lancer les tests et les voir passer**

Run: `npx vitest run src/cli/commands/jira.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5 : enregistrer la commande**

Dans `src/cli/index.ts`, ajouter l'import `import { jiraCommand } from './commands/jira.js';` puis, après la commande `cancel` :

```typescript
program
  .command('jira')
  .description('Lit et pilote un ticket Jira : show, transitions, transition, comment, assign, get')
  .argument('<args...>', 'verbe et ses arguments')
  .allowUnknownOption()
  .action((args: string[]) => jiraCommand(args));
```

- [ ] **Step 6 : vérifier à la main sur un vrai ticket**

Run: `npx tsc --noEmit && npm run build && sisyphe jira show IOS-886`
Expected: le JSON du ticket, avec `"status"` non vide.

- [ ] **Step 7 : commit**

```bash
git add src/cli/commands/jira.ts src/cli/commands/jira.test.ts src/cli/index.ts
git commit -m "feat(cli): commande sisyphe jira"
```

---

## Task 4 : la clé du ticket dans le commit et la PR

**Files:**
- Modify: `src/deliver/deliver.ts:45-53` (`commitMessage`, `prTitle`), `src/deliver/deliver.ts:10-27` (`DeliverInput`)
- Modify: `src/deliver/pr-body.ts:42-79` (`renderPrBody`)
- Modify: `src/jobs/pipeline.ts` (appel à `deliver`)
- Modify: `src/deliver/deliver.test.ts`, `src/deliver/render.test.ts`

- [ ] **Step 1 : écrire les tests qui échouent**

Dans `src/deliver/deliver.test.ts`, remplacer les assertions de nommage du test existant `shouldBeDraft lit les drapeaux…` et ajouter :

```typescript
  it('porte la clé Jira dans le commit et le titre de PR, sans Closes', () => {
    const job = makeJob();
    const ticket = { key: 'IOS-886', url: 'https://acme.atlassian.net/browse/IOS-886' };
    expect(commitMessage(job, ticket)).toMatch(/^fix\(IOS-886\): Titre\n\nCo-Authored-By: Sisyphe/);
    expect(commitMessage(job, ticket)).not.toContain('Closes');
    expect(prTitle(job, ticket)).toBe('fix(IOS-886): Titre');
  });

  it('sans ticket Jira, le nommage GitHub ne bouge pas', () => {
    const job = makeJob();
    expect(commitMessage(job, null)).toMatch(/^fix\(#7\): Titre\n\nCloses #7\n\nCo-Authored-By: Sisyphe/);
    expect(prTitle(job, null)).toBe('[#7] Titre');
  });
```

Dans `src/deliver/render.test.ts`, ajouter :

```typescript
  it('ouvre le corps sur le lien du ticket Jira et supprime Closes', () => {
    const body = renderPrBody({
      job, report, verify, phases, prTemplate: null, costUsd: 1, durationMs: 1000,
      ticket: { key: 'IOS-886', url: 'https://acme.atlassian.net/browse/IOS-886' },
    });
    expect(body.split('\n')[0]).toBe('Ticket: [IOS-886](https://acme.atlassian.net/browse/IOS-886)');
    expect(body).not.toContain('Closes #');
  });

  it('sans ticket Jira, le corps garde son Closes en dernier', () => {
    const body = renderPrBody({ job, report, verify, phases, prTemplate: null, costUsd: 1, durationMs: 1000, ticket: null });
    expect(body).toContain('Closes #7');
  });
```

- [ ] **Step 2 : lancer les tests et les voir échouer**

Run: `npx vitest run src/deliver`
Expected: FAIL — `Expected 2 arguments, but got 1` au typecheck vitest, ou assertions rouges.

- [ ] **Step 3 : implémenter le nommage**

Dans `src/deliver/deliver.ts`, ajouter le type et changer les deux fonctions :

```typescript
/** Le ticket tel que la livraison doit le nommer. `null` : suivi GitHub, le nommage historique s'applique. */
export interface TicketRef {
  key: string;
  url: string;
}

export function commitMessage(job: Job, ticket: TicketRef | null): string {
  const type = job.verdict?.change_type ?? 'chore';
  const author = `Co-Authored-By: ${SISYPHE_AUTHOR.name} <${SISYPHE_AUTHOR.email}>`;
  // La clé dans le sujet suffit à l'app GitHub for Jira : c'est ainsi qu'elle relie le commit au ticket.
  // Pas de `Closes` sous Jira — le numéro y désignerait une issue GitHub sans rapport, qu'une fusion sur la
  // branche par défaut fermerait pour de bon.
  if (ticket) return `${type}(${ticket.key}): ${cleanTitle(job.issueTitle)}\n\n${author}`;
  return `${type}(#${job.issueNumber}): ${cleanTitle(job.issueTitle)}\n\nCloses #${job.issueNumber}\n\n${author}`;
}

export function prTitle(job: Job, ticket: TicketRef | null): string {
  const type = job.verdict?.change_type ?? 'chore';
  // Convention av-tools : `type(KEY): description`, pour qu'une PR de Sisyphe ne se distingue pas d'une autre.
  if (ticket) return `${type}(${ticket.key}): ${cleanTitle(job.issueTitle)}`;
  return `[#${job.issueNumber}] ${cleanTitle(job.issueTitle)}`;
}
```

Ajouter `ticket: TicketRef | null;` à `DeliverInput`, et dans `deliver()` remplacer les trois appels :

```typescript
  const commitSha = await i.git.commitTree(i.worktreePath, job.branch, i.verify.treeSha, job.baseSha, commitMessage(job, i.ticket));
  ...
  const title = prTitle(job, i.ticket);
  const body = renderPrBody({ job, report: i.report, verify: i.verify, phases: i.phases, prTemplate: i.prTemplate, costUsd: job.costUsd, durationMs: i.durationMs, ticket: i.ticket });
```

- [ ] **Step 4 : implémenter le corps de PR**

Dans `src/deliver/pr-body.ts`, ajouter `ticket: TicketRef | null;` à `PrBodyInput` (importer le type depuis `./deliver.js`), puis :

```typescript
export function renderPrBody(i: PrBodyInput): string {
  const { job, verify } = i;
  const report = sanitizeReport(i.report);
  // Le lien du ticket ouvre le corps : c'est la première chose qu'un relecteur cherche, et l'app
  // GitHub for Jira n'en a pas besoin — elle travaille sur le commit et le titre.
  const lines: string[] = i.ticket ? [`Ticket: [${i.ticket.key}](${i.ticket.url})`, '', '## Résumé', '', report.summary, ''] : ['## Résumé', '', report.summary, ''];
```

et à la fin, remplacer la ligne `Closes` :

```typescript
  if (!i.ticket) lines.push(`Closes #${job.issueNumber}`, '');
  lines.push(jobMarker(job.id));
```

- [ ] **Step 5 : câbler le pipeline**

Dans `src/jobs/pipeline.ts`, à l'intérieur de la phase `deliver`, calculer le ticket juste avant l'appel :

```typescript
        const ticket = issue.tracker && deps.machine.jira
          ? { key: issue.tracker.key, url: browseUrl(deps.machine.jira.site, issue.tracker.key) }
          : null;
        return deliver({
          job, issue, config, report, verify: verified, phases: phases.listForJob(job.id), ticket,
          source, forge, git: deps.git, worktreePath: wtPath, pushUrl, prTemplate, baseBranch, durationMs: elapsed(),
        });
```

Ajouter l'import `import { browseUrl } from '../jira/links.js';`.

- [ ] **Step 6 : lancer les tests et les voir passer**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, aucune erreur de type.

- [ ] **Step 7 : commit**

```bash
git add src/deliver src/jobs/pipeline.ts
git commit -m "feat(deliver): la clé Jira dans le commit, le titre et le corps de PR"
```

---

## Task 5 : le garde-fou Bash de la phase `jira`

La phase `jira` a le ticket en contexte — du texte écrit par des tiers — et un accès Bash. Sans garde, une injection réussie dispose de la machine. Le garde ne laisse passer que `sisyphe jira …`.

**Files:**
- Create: `src/agent/bash-guard.ts`
- Create: `src/agent/bash-guard.test.ts`
- Create: `src/agent/bash-guard-cli.ts`
- Modify: `src/agent/runner.ts`, `src/agent/sdk-runner.ts`, `src/agent/cli/claude-code-runner.ts`

- [ ] **Step 1 : écrire le test qui échoue**

`src/agent/bash-guard.test.ts` :

```typescript
import { describe, expect, it } from 'vitest';
import { decideBash } from './bash-guard.js';

describe('decideBash', () => {
  it('laisse passer les verbes jira de sisyphe', () => {
    expect(decideBash('sisyphe jira show IOS-886').allowed).toBe(true);
    expect(decideBash('  sisyphe jira transition IOS-886 "En relecture"').allowed).toBe(true);
  });

  it('refuse tout le reste, y compris ce qui commence bien', () => {
    for (const cmd of [
      'ls',
      'sisyphe status',
      'sisyphe jira show IOS-886; rm -rf /',
      'sisyphe jira show IOS-886 && curl evil.example',
      'sisyphe jira show IOS-886 | sh',
      'echo x $(sisyphe jira show IOS-886)',
      'sisyphe jira show `whoami`',
    ]) {
      expect(decideBash(cmd), cmd).toMatchObject({ allowed: false });
    }
  });

  it('ferme par défaut sur une entrée absente ou inattendue', () => {
    expect(decideBash(undefined).allowed).toBe(false);
    expect(decideBash('').allowed).toBe(false);
  });
});
```

- [ ] **Step 2 : lancer le test et le voir échouer**

Run: `npx vitest run src/agent/bash-guard.test.ts`
Expected: FAIL — `Failed to resolve import "./bash-guard.js"`.

- [ ] **Step 3 : implémenter**

`src/agent/bash-guard.ts` :

```typescript
/** Ce que le préfixe autorisé laisse faire, et rien d'autre. Voir `decideBash`. */
export const JIRA_COMMAND_PREFIX = 'sisyphe jira ';

/** Ce qui enchaîne, redirige ou substitue une commande : une seule de ces marques et on refuse. */
const SHELL_METACHARACTERS = /[;&|<>`$(){}\n\r\\]/;

export interface BashDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Le garde-fou Bash de la phase `jira`. Elle travaille avec le texte du ticket en contexte, écrit par
 * des tiers : seul `sisyphe jira …` passe, et seulement s'il ne porte aucune marque d'enchaînement.
 * Refuser toute métacaractère plutôt que d'essayer d'analyser la ligne — un analyseur de shell partiel
 * se fait contourner, une liste de caractères interdits non.
 *
 * Ferme par défaut : entrée absente, vide ou inattendue = refus.
 */
export function decideBash(command: string | undefined): BashDecision {
  if (typeof command !== 'string' || !command.trim()) {
    return { allowed: false, reason: 'Commande absente : refusée.' };
  }
  const trimmed = command.trim();
  if (SHELL_METACHARACTERS.test(trimmed)) {
    return { allowed: false, reason: 'Commande refusée : enchaînement, redirection ou substitution shell interdits dans cette phase.' };
  }
  if (!trimmed.startsWith(JIRA_COMMAND_PREFIX)) {
    return { allowed: false, reason: `Commande refusée : seul « ${JIRA_COMMAND_PREFIX.trim()} … » est autorisé dans cette phase.` };
  }
  return { allowed: true, reason: '' };
}
```

- [ ] **Step 4 : lancer le test et le voir passer**

Run: `npx vitest run src/agent/bash-guard.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5 : le même garde en script autonome**

`src/agent/bash-guard-cli.ts`, calqué sur `src/agent/path-guard-cli.ts` — lire ce fichier d'abord et en reprendre `readAll`, `isMain` et la forme de sortie :

```typescript
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decideBash } from './bash-guard.js';

/**
 * Hook PreToolUse du backend CLI pour la phase `jira`. Même décision que côté SDK, dans un processus
 * Node autonome. Ferme par défaut : toute anomalie refuse la commande, et on sort toujours en 0 —
 * un `exit 1` serait traité comme une erreur non bloquante, donc un refus manqué.
 */
export function guardBashFromHookInput(raw: string): string | null {
  const deny = (reason: string): string =>
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    });
  try {
    const input = JSON.parse(raw) as { tool_input?: Record<string, unknown> };
    const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : undefined;
    const decision = decideBash(command);
    return decision.allowed ? null : deny(decision.reason);
  } catch (err) {
    return deny(`Garde-fou Sisyphe indisponible, commande refusée : ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  stream.setEncoding('utf8');
  let data = '';
  for await (const chunk of stream) data += chunk;
  return data;
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const raw = await readAll(process.stdin).catch(() => '');
  const output = guardBashFromHookInput(raw);
  if (output !== null) process.stdout.write(`${output}\n`);
}
```

- [ ] **Step 6 : câbler les deux backends**

Dans `src/agent/runner.ts`, ajouter à `AgentRunOptions`, à côté de `pathGuard` :

```typescript
  /** Garde-fou Bash : `true` n'autorise que `sisyphe jira …`. Utilisé par la phase `jira`, qui n'a rien d'autre à lancer. */
  bashGuard?: boolean;
```

Dans `src/agent/sdk-runner.ts`, `buildOptions`, remplacer la ligne `hooks:` :

```typescript
    hooks: buildHooks(o),
```

et ajouter au-dessus de `buildOptions` :

```typescript
/** Les hooks PreToolUse du run : garde de chemins pour les écritures, garde Bash pour la phase `jira`. */
function buildHooks(o: AgentRunOptions): Options['hooks'] {
  const entries: NonNullable<Options['hooks']>['PreToolUse'] = [];
  if (o.pathGuard) entries.push({ matcher: 'Edit|Write', hooks: [pathGuardHook(o.pathGuard.worktreePath, o.pathGuard.protectedPatterns)] });
  if (o.bashGuard) entries.push({ matcher: 'Bash', hooks: [bashGuardHook()] });
  return entries.length ? { PreToolUse: entries } : undefined;
}
```

Dans `src/agent/hooks.ts`, ajouter `bashGuardHook()` à côté de `pathGuardHook`, en reprenant sa forme (lire le fichier d'abord) et en appelant `decideBash(input.tool_input?.command)`.

Dans `src/agent/cli/claude-code-runner.ts`, étendre `buildCliSettings` :

```typescript
export function buildCliSettings(hookScript: string, nodeBin: string = process.execPath, bashHookScript?: string): Record<string, unknown> {
  const preToolUse: unknown[] = [
    { matcher: 'Edit|Write', hooks: [{ type: 'command', command: `"${nodeBin}" "${hookScript}"`, timeout: HOOK_TIMEOUT_SECONDS }] },
  ];
  if (bashHookScript) {
    preToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: `"${nodeBin}" "${bashHookScript}"`, timeout: HOOK_TIMEOUT_SECONDS }] });
  }
  return { hooks: { PreToolUse: preToolUse } };
}
```

et, dans `run()`, passer `bash-guard-cli.js` quand `o.bashGuard` est vrai, avec la même vérification d'existence que pour `path-guard-cli.js` — un garde introuvable refuse le run, il ne le laisse pas passer nu.

- [ ] **Step 7 : lancer toute la suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8 : commit**

```bash
git add src/agent
git commit -m "feat(agent): garde-fou Bash limitant la phase jira à sisyphe jira"
```

---

## Task 6 : le plugin et le skill livrés avec Sisyphe

**Files:**
- Create: `agent-plugin/.claude-plugin/plugin.json`
- Create: `agent-plugin/skills/sisyphe-jira/SKILL.md`
- Create: `src/agent/plugin-path.ts`
- Create: `src/agent/plugin-path.test.ts`

- [ ] **Step 1 : écrire le manifeste**

`agent-plugin/.claude-plugin/plugin.json` :

```json
{
  "name": "sisyphe",
  "version": "0.1.0",
  "description": "Skills livrés avec Sisyphe pour son agent autonome.",
  "author": { "name": "Sisyphe" }
}
```

- [ ] **Step 2 : écrire le skill**

`agent-plugin/skills/sisyphe-jira/SKILL.md` :

```markdown
---
name: sisyphe-jira
description: Use at the end of a Sisyphe job to move the Jira ticket to its final status and post the report comment. Covers reading the ticket, walking the workflow one transition at a time, and handing the ticket back when blocked.
---

# Clore un ticket Jira à la fin d'un job

Tu es la dernière phase d'un job Sisyphe. Le travail de code est fini — bien ou mal. Ton rôle : laisser le
ticket dans le bon statut et écrire, pour la personne qui l'a signalé, ce qui s'est passé.

Tu n'as qu'un outil : la commande `sisyphe jira`. Aucune autre commande ne passera.

## Ce que tu peux faire

| Commande | Effet |
| --- | --- |
| `sisyphe jira show IOS-886` | Le ticket : titre, statut courant, type, versions, description, commentaires. |
| `sisyphe jira transitions IOS-886` | Les statuts atteignables **depuis le statut courant**, avec leur id. |
| `sisyphe jira transition IOS-886 "En relecture"` | Va jusqu'à ce statut, en enchaînant les étapes s'il le faut. |
| `sisyphe jira assign IOS-886 --back` | Rend le ticket à la personne qui l'a confié à Sisyphe. |
| `sisyphe jira get /rest/api/3/...` | N'importe quelle lecture de l'API Jira, pour ce que le reste ne dit pas. |

Aucun enchaînement n'est possible : pas de `;`, pas de `|`, pas de `&&`, pas de redirection. Une commande par
appel. C'est pour cela que le commentaire ne se poste pas par la ligne de commande — voir plus bas.

## Les transitions

`sisyphe jira transition` fait déjà le chemin complet : il apparie sur le **statut d'arrivée**, jamais sur le
nom de la transition, ne saute aucune étape du workflow, et s'arrête au bout de cinq sauts. Tu n'as pas à
enchaîner toi-même. Appelle-le une fois avec le statut visé.

S'il échoue — chemin introuvable, statut absent du workflow configuré — **n'insiste pas et ne cherche pas un
statut de remplacement**. Rends le ticket avec `assign --back` et dis-le dans ton commentaire. Un humain
décidera ; c'est exactement ce que ferait un développeur coincé.

Il n'y a personne à interroger : tu ne poses pas de question, tu décides ou tu rends la main.

## Où laisser le ticket

Le résultat du job t'est donné dans le prompt. En fonction :

- **PR ouverte et vérification au vert** → statut de relecture (`doneStatus` de la configuration, donné dans
  le prompt). Le ticket reste assigné à Sisyphe : c'est un travail soumis, pas un travail abandonné.
- **PR ouverte mais vérification rouge** → même statut de relecture, et le commentaire doit dire, en premier,
  que la PR est en brouillon et pourquoi. Laisse le ticket assigné.
- **Rien à livrer** (triage non concluant, diff vide, secret détecté, chemin protégé touché, échec) → ne
  déplace pas le ticket, `assign --back`. On ne fait pas reculer une colonne parce qu'on a buté ; on rend la
  main là où le ticket se trouve.
- **Job annulé** → `assign --back`, commentaire court.

## Le commentaire

Tu ne le postes pas toi-même : tu l'écris dans le champ `comment` de ton rapport JSON, et Sisyphe le pose.
C'est le seul moyen d'avoir un texte sur plusieurs lignes — la ligne de commande n'en accepte aucune.
Un `comment` vide veut dire « ne rien poster », et Sisyphe posera alors son propre message de secours.

Il est lu par la personne qui a signalé le problème, pas par un développeur qui relira les logs.

- Commence par `🪨 `.
- Deux à quatre phrases. Ce qui a été fait, ou ce qui bloque, et quoi faire ensuite.
- Le lien de la PR s'il y en a une, en toutes lettres.
- Aucun nom de fichier, aucun nom de fonction, aucun extrait de code, aucun jargon.
- Si tu as dû rendre le ticket, dis-le et dis pourquoi.

## Avant de finir

Relis le ticket (`show`) et vérifie que tu l'as bien laissé où tu voulais. Puis rends ton rapport JSON.
```

- [ ] **Step 3 : écrire le test de résolution du chemin**

`src/agent/plugin-path.test.ts` :

```typescript
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentPluginPath, JIRA_SKILL } from './plugin-path.js';

describe('agentPluginPath', () => {
  it('pointe sur un plugin réellement présent dans le paquet', async () => {
    const path = agentPluginPath();
    await expect(access(join(path, '.claude-plugin', 'plugin.json'))).resolves.toBeUndefined();
    await expect(access(join(path, 'skills', 'sisyphe-jira', 'SKILL.md'))).resolves.toBeUndefined();
  });

  it('nomme le skill sous sa forme qualifiée par le plugin', () => {
    expect(JIRA_SKILL).toBe('sisyphe:sisyphe-jira');
  });
});
```

- [ ] **Step 4 : lancer le test et le voir échouer**

Run: `npx vitest run src/agent/plugin-path.test.ts`
Expected: FAIL — `Failed to resolve import "./plugin-path.js"`.

- [ ] **Step 5 : implémenter**

`src/agent/plugin-path.ts` :

```typescript
import { fileURLToPath } from 'node:url';

/** Nom du skill tel que l'option `skills` du SDK l'attend : qualifié par le plugin qui le porte. */
export const JIRA_SKILL = 'sisyphe:sisyphe-jira';

/**
 * Le plugin livré avec Sisyphe. Il vit à la racine du dépôt (`agent-plugin/`), pas dans `dist/` : ce sont
 * des fichiers Markdown et JSON, `tsc` ne les copie pas, et un chemin calculé depuis `dist/agent/` reste
 * valide dans les deux cas — le paquet installé est le dépôt lui-même (`npm link`).
 */
export function agentPluginPath(): string {
  return fileURLToPath(new URL('../../agent-plugin', import.meta.url));
}
```

- [ ] **Step 6 : lancer le test et le voir passer**

Run: `npx vitest run src/agent/plugin-path.test.ts`
Expected: PASS. Si le chemin est faux, corriger le nombre de `..` selon l'emplacement réel de `dist/agent/`.

**Vérifié en Task 0 :** le nom qualifié `<plugin>:<skill>` est la forme qui marche — d'où `sisyphe:sisyphe-jira`,
et non `sisyphe-jira` comme l'écrit la §3.4 de la spec. Le champ `skills` du message `init` liste les skills
*découverts*, pas les skills *autorisés* : il est identique avec et sans l'option `skills`. Ne pas s'en servir
pour juger que l'allowlist fonctionne — elle fonctionne, mais ça se vérifie en demandant à l'agent d'invoquer
un skill absent de la liste, pas en lisant `init`.

- [ ] **Step 7 : commit**

```bash
git add agent-plugin src/agent/plugin-path.ts src/agent/plugin-path.test.ts
git commit -m "feat(agent): plugin local et skill sisyphe-jira livrés avec Sisyphe"
```

---

## Task 7 : la phase `jira`

**Files:**
- Create: `src/jobs/jira-sync.ts`
- Create: `src/jobs/jira-sync.test.ts`
- Modify: `src/store/types.ts:73` (`PhaseName`)
- Modify: `src/agent/schemas.ts`
- Modify: `src/agent/prompts.ts`
- Modify: `src/agent/runner.ts`, `src/agent/sdk-runner.ts`, `src/agent/cli/claude-code-runner.ts` (options `plugins`/`skills`)
- Modify: `src/cli/index.ts` (la liste `PHASES` de `sisyphe logs`)

- [ ] **Step 1 : écrire le test qui échoue**

`src/jobs/jira-sync.test.ts` :

```typescript
import { describe, expect, it, vi } from 'vitest';
import { jiraOutcomeOf, runJiraPhase, type JiraSyncDeps } from './jira-sync.js';
import { emptyFlags, type Job } from '../store/types.js';

const job = { id: 'j1', repo: 'acme/ios', issueNumber: 886, issueTitle: 'Couleur', state: 'done', attempt: 1, costUsd: 0.4, durationMs: 60_000, prUrl: 'https://github.com/acme/ios/pull/412', flags: emptyFlags() } as unknown as Job;

describe('jiraOutcomeOf', () => {
  it('décrit un job livré, vérification comprise', () => {
    const o = jiraOutcomeOf(job, 'done', 'En relecture');
    expect(o).toMatchObject({ state: 'done', prUrl: 'https://github.com/acme/ios/pull/412', targetHint: 'En relecture', verificationFailed: false });
  });

  it('décrit un job bloqué sans PR', () => {
    const o = jiraOutcomeOf({ ...job, state: 'blocked', prUrl: null } as Job, 'blocked', 'En relecture');
    expect(o).toMatchObject({ state: 'blocked', prUrl: null });
  });
});

describe('runJiraPhase', () => {
  function deps(over: Partial<JiraSyncDeps> = {}): JiraSyncDeps {
    return {
      agent: { run: vi.fn(async () => ({ output: { status: 'En relecture', commented: true, handedBack: false, note: '' }, sessionId: null, costUsd: 0.01, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, numTurns: 2, durationMs: 10, stopReason: 'completed', transcriptPath: '' })) },
      ...over,
    } as unknown as JiraSyncDeps;
  }

  it('rend le rapport de l’agent quand il aboutit', async () => {
    const d = deps();
    const r = await runJiraPhase(d, job, jiraOutcomeOf(job, 'done', 'En relecture'));
    expect(r).toMatchObject({ commented: true, handedBack: false });
  });

  it('rend un rapport vide plutôt que de lever quand l’agent ne produit rien', async () => {
    const d = deps({ agent: { run: vi.fn(async () => ({ output: null, sessionId: null, costUsd: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, numTurns: 0, durationMs: 1, stopReason: 'max_turns', transcriptPath: '' })) } as unknown as JiraSyncDeps['agent'] });
    const r = await runJiraPhase(d, job, jiraOutcomeOf(job, 'done', 'En relecture'));
    expect(r).toEqual({ status: '', commented: false, handedBack: false, note: 'aucun rapport produit' });
  });
});
```

- [ ] **Step 2 : lancer le test et le voir échouer**

Run: `npx vitest run src/jobs/jira-sync.test.ts`
Expected: FAIL — `Failed to resolve import "./jira-sync.js"`.

- [ ] **Step 3 : ajouter le schéma de rapport**

Dans `src/agent/schemas.ts` :

```typescript
export const JiraSyncReportSchema = z.object({
  status: z.string().describe("Statut Jira dans lequel le ticket a été laissé ; chaîne vide si aucune transition n'a eu lieu"),
  /**
   * Le texte, pas un booléen : le garde-fou Bash interdit toute redirection, donc un corps sur plusieurs
   * lignes ne peut pas passer par la ligne de commande. L'agent l'écrit ici, le pipeline le poste. Vide =
   * rien à dire, et le pipeline posera son message de secours.
   */
  comment: z.string().describe('Le commentaire à poster sur le ticket, en markdown ; chaîne vide pour ne rien poster'),
  handedBack: z.boolean().describe("Le ticket a-t-il été rendu à la personne qui l'avait confié à Sisyphe"),
  note: z.string().describe("Ce qui n'a pas pu être fait, en une phrase ; chaîne vide si tout s'est bien passé"),
});
export type JiraSyncReport = z.infer<typeof JiraSyncReportSchema>;
export const jiraSyncJsonSchema = z.toJSONSchema(JiraSyncReportSchema, { target: 'draft-07' });
```

- [ ] **Step 4 : ajouter le prompt**

Dans `src/agent/prompts.ts` :

```typescript
import type { JiraOutcome } from '../jobs/jira-sync.js';

/**
 * Prompt de la phase `jira`. Le contenu du ticket n'est **pas** rappelé ici : l'agent le lit lui-même avec
 * `sisyphe jira show`, ce qui évite d'injecter du texte de tiers dans un prompt dont le rôle est d'agir.
 */
export function jiraSyncPrompt(o: JiraOutcome): string {
  const lines = [
    `Tu es en phase JIRA, la dernière du job. Ticket : ${o.key}. Applique le skill sisyphe-jira.`,
    '',
    'Résultat du job :',
    `- issue : ${o.state}`,
    `- vérification : ${o.verificationFailed ? 'échouée après toutes les tentatives' : 'passée'}`,
    `- pull request : ${o.prUrl ?? 'aucune'}`,
    `- tentatives : ${o.attempts}`,
    `- coût : $${o.costUsd.toFixed(2)} · durée : ${o.duration}`,
    `- statut de relecture configuré pour ce projet : « ${o.targetHint} »`,
  ];
  if (o.reason) lines.push(`- ce qui s'est passé : ${o.reason}`);
  if (o.flags.length) lines.push(`- signalements : ${o.flags.join(', ')}`);
  lines.push('', 'Termine par le rapport JSON demandé ; le schéma décrit chaque champ.');
  return lines.join('\n');
}
```

- [ ] **Step 5 : implémenter la phase**

Ce fichier utilise `skills` et `bashGuard` sur `AgentRunOptions` : les deux champs sont ajoutés au Step 6
(`bashGuard` l'a été en Task 5). `tsc` reste rouge entre les deux étapes, c'est attendu — le Step 8 le vérifie.

`src/jobs/jira-sync.ts` :

```typescript
import { jiraSyncPrompt } from '../agent/prompts.js';
import { JIRA_SKILL } from '../agent/plugin-path.js';
import type { AgentResult, AgentRunner } from '../agent/runner.js';
import { JiraSyncReportSchema, jiraSyncJsonSchema, type JiraSyncReport } from '../agent/schemas.js';
import type { Job, JobState } from '../store/types.js';
import { fmtDuration } from '../util/time.js';

const JIRA_MAX_TURNS = 20;
const JIRA_MAX_BUDGET_USD = 1;

/** Ce que la phase `jira` a besoin de savoir du job, et rien de plus : elle ne voit ni le dépôt ni le diff. */
export interface JiraOutcome {
  key: string;
  state: JobState;
  verificationFailed: boolean;
  prUrl: string | null;
  attempts: number;
  costUsd: number;
  duration: string;
  targetHint: string;
  reason: string | null;
  flags: string[];
}

export function jiraOutcomeOf(job: Job, state: JobState, targetHint: string, key = ''): JiraOutcome {
  const flags: string[] = [];
  if (job.flags.secretsFound.length) flags.push('secrets détectés dans le diff');
  if (job.flags.protectedPathsTouched.length) flags.push('chemins protégés modifiés');
  if (job.flags.largeDiff) flags.push('diff volumineux');
  if (job.flags.earlyStop) flags.push(`agent arrêté avant la fin (${job.flags.earlyStop})`);
  return {
    key, state, verificationFailed: job.flags.verificationFailed, prUrl: job.prUrl,
    attempts: job.attempt, costUsd: job.costUsd, duration: fmtDuration(job.durationMs),
    targetHint, reason: job.error, flags,
  };
}

export interface JiraSyncDeps {
  agent: AgentRunner;
  env: Record<string, string>;
  transcriptPath: string;
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  model?: string;
}

const EMPTY: JiraSyncReport = { status: '', comment: '', handedBack: false, note: 'aucun rapport produit' };

/**
 * Un tour d'agent, un seul outil. Ne lève jamais : le filet du pipeline s'appuie sur ce qu'elle rend, et
 * une exception ici priverait le job de sa clôture Jira au lieu de la dégrader.
 *
 * Rend aussi le résultat brut : son coût doit être imputé au job comme celui des autres phases, sans quoi
 * la phase échapperait au plafond quotidien.
 */
export async function runJiraPhase(
  deps: JiraSyncDeps,
  job: Job,
  outcome: JiraOutcome,
): Promise<{ report: JiraSyncReport; result: AgentResult<JiraSyncReport> }> {
  const res = await deps.agent.run<JiraSyncReport>({
    cwd: deps.cwd,
    model: deps.model,
    phase: 'implement',
    systemPromptAppend: "Tu clos un ticket Jira pour Sisyphe. Ta seule commande disponible est `sisyphe jira`. Tu n'as ni dépôt, ni réseau, ni personne à interroger.",
    prompt: jiraSyncPrompt(outcome),
    outputSchema: jiraSyncJsonSchema,
    maxTurns: JIRA_MAX_TURNS,
    maxBudgetUsd: JIRA_MAX_BUDGET_USD,
    allowedTools: ['Bash'],
    disallowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    bashGuard: true,
    skills: [JIRA_SKILL],
    env: deps.env,
    timeoutMs: deps.timeoutMs,
    signal: deps.signal,
    transcriptPath: deps.transcriptPath,
  });
  const parsed = JiraSyncReportSchema.safeParse(res.output);
  return { report: parsed.success ? parsed.data : EMPTY, result: res };
}
```

- [ ] **Step 6 : ajouter `skills` aux options d'agent**

Dans `src/agent/runner.ts`, ajouter à `AgentRunOptions` :

```typescript
  /** Skills du plugin livré avec Sisyphe à rendre visibles pour ce run. Absent : aucun skill. */
  skills?: string[];
```

Dans `src/agent/sdk-runner.ts`, `buildOptions`, ajouter :

```typescript
    plugins: o.skills?.length ? [{ type: 'local', path: agentPluginPath() }] : undefined,
    skills: o.skills,
```

Dans `src/agent/cli/claude-code-runner.ts`, `buildCliArgs`, ajouter avant `--append-system-prompt-file` :

```typescript
  // La CLI n'a pas d'équivalent de l'option `skills` du SDK (vérifié en Task 0 : ni --skills, ni
  // --allowed-skills). Elle n'en a pas besoin ici : `--setting-sources ''` coupe toute autre source, donc
  // seuls les skills de ce plugin existent pour l'agent. Le filtrage au cas par cas, s'il devenait utile,
  // passerait par `--disallowedTools 'Skill(<plugin>:<skill>)'`, qui refuse bien l'invocation.
  if (o.skills?.length) args.push('--plugin-dir', agentPluginPath());
```

- [ ] **Step 7 : ajouter la phase au modèle**

`src/store/types.ts:73` :

```typescript
export type PhaseName = 'triage' | 'implement' | 'verify' | 'deliver' | 'jira';
```

Dans `src/cli/index.ts`, ajouter `'jira'` à la constante `PHASES` et au libellé de l'option `--phase`.

- [ ] **Step 8 : lancer les tests et les voir passer**

Run: `npx vitest run src/jobs/jira-sync.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 9 : commit**

```bash
git add src/jobs/jira-sync.ts src/jobs/jira-sync.test.ts src/agent src/store/types.ts src/cli/index.ts
git commit -m "feat(jobs): phase jira, un tour d'agent pour clore le ticket"
```

---

## Task 8 : `finish()` devient le point de sortie unique

Dix `return finish(...)` existent dans `runJob`. En y branchant la phase `jira` et le filet, aucune sortie ne peut les manquer — c'est la seule façon de tenir « à chaque fin de job » sans répéter huit fois le même bloc.

**Files:**
- Modify: `src/jobs/pipeline.ts:79-84` (`finish`), et les 8 appels `source.setStatus`/`source.comment` du corps
- Modify: `test/integration/jira-pipeline.test.ts`
- Modify: `test/integration/pipeline.test.ts`

**Lire d'abord `test/integration/jira-pipeline.test.ts`.** Il contient déjà, avec un vrai `JiraIssueTracker`
branché sur un Jira factice (`fakeJira`, `harnessOn`), les trois invariants que ce changement doit préserver :
le ticket arrive « En relecture », le triage bloqué rend la main sans quitter la colonne, le job annulé ne
laisse pas le ticket au bot. Ces tests-là ne doivent pas changer d'intention.

**Ils vont tous casser d'une même façon** : le tableau `steps` alimente le faux agent, et la phase `jira`
consomme désormais un pas de plus. Chaque test existant a besoin d'un pas supplémentaire en fin de liste,
dont la sortie a la forme d'un `JiraSyncReport`. C'est la première chose à faire, avant d'écrire les nouveaux.

- [ ] **Step 1 : écrire les tests qui échouent**

Ajouter en tête de `test/integration/jira-pipeline.test.ts` :

```typescript
/** Ce que la phase `jira` rend quand elle a fait son travail : elle a transitionné et rédigé son texte. */
const jiraOk = { status: 'En relecture', comment: '🪨 PR prête : https://example.test/pr/1', handedBack: false, note: '' };
/** Ce qu'elle rend quand elle n'a rien pu faire : c'est le cas que le filet doit rattraper. */
const jiraMuet = { status: '', comment: '', handedBack: false, note: 'coincé' };
```

puis les tests :

```typescript
  it('ouvre une phase jira à la fin du job', async () => {
    const j = fakeJira();
    const h = await harnessOn(j.tracker, [
      { output: readyVerdict },
      { output: report('Créé'), sideEffect: writeFeature('hello\n') },
      { output: jiraOk, sideEffect: async () => { j.state.status = 'En relecture'; } },
    ], ['release/8.42.0']);
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    await runJob(job.id, h.deps, signal());

    expect(h.deps.phases.listForJob(job.id).map((p) => p.name)).toContain('jira');
    expect(j.state.status).toBe('En relecture');
  });

  it('rend le ticket lui-même quand la phase jira ne l’a pas fait', async () => {
    const j = fakeJira();
    const blocked = { ...readyVerdict, verdict: 'needs_clarification', note: 'Il manque un écran.', questions: ['Quel écran ?'] };
    const h = await harnessOn(j.tracker, [{ output: blocked }, { output: jiraMuet }]);
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    await runJob(job.id, h.deps, signal());

    // Invariant 1 : un job non livré ne laisse jamais le ticket assigné au compte dédié.
    expect(j.state.assignee).toBe('acc-victor');
    // Invariant 2 : un job terminé laisse toujours une trace.
    expect(j.state.comments.join('\n')).toContain('🪨');
  });

  it('poste le texte rédigé par la phase jira, et lui seul', async () => {
    const j = fakeJira();
    const h = await harnessOn(j.tracker, [
      { output: readyVerdict },
      { output: report('Créé'), sideEffect: writeFeature('hello\n') },
      { output: jiraOk },
    ], ['release/8.42.0']);
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    await runJob(job.id, h.deps, signal());

    // Un seul commentaire, et c'est celui de l'agent : le message scripté ne doit pas s'y ajouter.
    expect(j.state.comments).toHaveLength(1);
    expect(j.state.comments[0]).toContain('https://example.test/pr/1');
  });
```

Dans `test/integration/pipeline.test.ts` (suivi GitHub, `FakeIssueSource`), ajouter :

```typescript
  it('sous suivi GitHub, aucune phase jira : le chemin scripté reste en place', async () => {
    const h = await makeHarness({ steps: [{ output: readyVerdict }, { output: report('Créé'), sideEffect: writeFeature('hello\n') }] });
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());

    expect(done.state).toBe('done');
    expect(h.deps.phases.listForJob(job.id).map((p) => p.name)).not.toContain('jira');
  });
```

- [ ] **Step 2 : lancer les tests et les voir échouer**

Run: `npx vitest run test/integration`
Expected: FAIL — aucune phase `jira` enregistrée, et les tests existants consomment leurs pas dans le désordre.

- [ ] **Step 3 : réécrire `finish`**

Dans `src/jobs/pipeline.ts`, remplacer `finish` par :

```typescript
  /**
   * Le point de sortie unique du job. Toute issue passe par ici : c'est ce qui garantit qu'un ticket est
   * toujours clos, quel que soit le chemin pris — y compris les sorties anticipées du triage.
   *
   * Sous suivi GitHub, ou sur un backend agent sans skills, on garde le chemin scripté d'avant.
   */
  const finish = async (state: JobState, patch: JobPatch = {}): Promise<Job> => {
    const current = store.get(job.id) ?? job;
    const finished = store.transition(job.id, state, { ...patch, durationMs: (current.durationMs ?? 0) + elapsed() });
    await closeTicket(finished, state).catch((err) => log.warn({ err }, 'clôture du ticket incomplète'));
    return finished;
  };
```

et ajouter, juste au-dessus :

```typescript
  /** Ce que le scripté postait avant, réutilisé par le filet quand l'agent n'a rien dit. */
  const scriptedComment = (state: JobState, finished: Job): string => {
    if (state === 'cancelled') return renderCancelledComment(finished.id);
    if (finished.prUrl) {
      return renderDoneComment({
        jobId: finished.id, prUrl: finished.prUrl, status: state === 'done' ? 'done' : 'failed',
        costUsd: finished.costUsd, durationMs: finished.durationMs, attempts: finished.attempt,
      });
    }
    return renderFailedComment(finished.id, (finished.error ?? '').slice(0, 500), trigger);
  };

  /**
   * Phase `jira` puis filet. Deux invariants, et rien d'autre :
   * 1. un job non livré ne laisse jamais le ticket assigné au compte dédié ;
   * 2. un job terminé laisse toujours un commentaire.
   * Les deux sont vérifiés contre Jira, pas contre ce que l'agent affirme : c'est le seul état qui compte.
   */
  const closeTicket = async (finished: Job, state: JobState): Promise<void> => {
    const key = issue?.tracker?.key;
    const project = deps.machine.jira?.projects.find((p) => p.repo === job.repo);
    if (!key || !project || !supportsSkills(deps.machine.agentBackend)) {
      // Chemin historique : suivi GitHub, ou backend sans skills.
      await source.comment(issueRef, scriptedComment(state, finished)).catch(() => undefined);
      await source.setStatus(issueRef, statusFor(state)).catch(() => undefined);
      return;
    }
    // Pas de modèle imposé : `config` (le sisyphe.yml du dépôt) n'existe pas sur les sorties les plus
    // précoces — une config illisible est justement l'une d'elles. Chaque backend applique son défaut.
    const { report, result } = await runPhase('jira', finished.attempt, null, () =>
      runJiraPhase(
        { agent: deps.agent, env: agentEnvVars, transcriptPath: join(dir, `transcript-jira-${finished.attempt}.jsonl`), cwd: dir, timeoutMs: minutes(5), signal },
        finished,
        jiraOutcomeOf(finished, state, project.doneStatus, key),
      ),
      (out) => ({ outcome: out.report.note ? 'failure' : 'success', costUsd: out.result.costUsd, usage: out.result.usage, numTurns: out.result.numTurns, stopReason: out.result.stopReason }),
    );
    // Le coût suit le job comme celui des autres phases : le plafond quotidien le compte.
    record(result);
    if (state !== 'done' && !report.handedBack) {
      const still = await source.canTrigger(issueRef).catch(() => ({ ok: false, login: null }));
      if (still.ok) await source.removeTriggerLabel(issueRef).catch((err) => log.warn({ err }, 'ticket non rendu'));
    }
    // L'agent rédige, le pipeline poste : c'est le seul chemin, et il garantit qu'un job terminé laisse
    // toujours une trace — texte de l'agent s'il en a écrit un, message scripté sinon.
    const body = report.comment.trim() || scriptedComment(state, finished);
    await source.comment(issueRef, body).catch((err) => log.warn({ err }, 'commentaire de fin non posté'));
  };
```

Ajouter en haut du fichier :

```typescript
import { renderDoneComment } from '../deliver/comments.js';
import { jiraOutcomeOf, runJiraPhase } from './jira-sync.js';

/** Les backends qui savent charger un plugin local. Les autres gardent le chemin scripté. */
function supportsSkills(backend: MachineConfig['agentBackend']): boolean {
  return backend === 'sdk' || backend === 'claude-code';
}

/** Le statut que le chemin scripté posait pour chaque issue. */
function statusFor(state: JobState): StatusLabel | null {
  if (state === 'done') return 'done';
  if (state === 'failed') return 'failed';
  if (state === 'blocked') return 'blocked';
  return null;
}
```

**Le répertoire du job doit exister avant la première sortie possible.** `await mkdir(dir, { recursive: true })`
est aujourd'hui après `signal.throwIfAborted()` et après la transition vers `triaging` : une annulation au
tout début atteint le `catch` avec un `dir` inexistant, et la phase `jira` échoue en ENOENT sur l'écriture de
son transcript. Hisser le `mkdir` au-dessus du premier `throwIfAborted()`, avant le `try`. Constaté en Task 7,
qui a un test du cas dégradé — mais dégrader ici veut dire perdre la clôture Jira, pas un détail.

**Deux variables à sortir du `try`.** `closeTicket` est appelée depuis les sorties les plus précoces comme
depuis le `catch` ; ce qu'elle lit doit exister avant elles :

```typescript
  let issue: Issue | null = null;                       // était `const issue = await source.getIssue(...)` (~ligne 130)
  const agentEnvVars = agentEnv(deps.env, {}, deps.machine.agentBackend); // était calculé ligne ~172
```

L'affectation d'`issue` devient `issue = await source.getIssue(issueRef);`, et la ligne 172 se contente
d'enrichir l'environnement des phases de code avec `envExtra` (garder une seconde variable locale pour elles
plutôt que de donner les variables du dépôt à la phase `jira`, qui n'a rien à en faire).

Ajouter aux imports : `type Issue` et `type StatusLabel` depuis `../github/source.js`.

- [ ] **Step 4 : retirer les appels devenus doubles**

Supprimer les huit paires `await source.comment(...)` / `await source.setStatus(...)` des lignes ~144, 156, 219, 276, 282, 288, 341 et 352, ainsi que l'appel à `setStatus` de la fin de `deliver()` (`src/deliver/deliver.ts`, le `bestEffort('label de statut', …)` et le `bestEffort('commentaire de fin', …)`). Le seul `setStatus` conservé est la prise en main du début (`'in-progress'`, ligne ~129) : aucun agent ne tourne encore à ce moment-là.

`deliver()` ne touche donc plus au ticket ; supprimer `source` de `DeliverInput` s'il n'y sert plus à rien et laisser le typecheck le confirmer.

- [ ] **Step 5 : lancer les tests et les voir passer**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS. Les tests de `deliver.test.ts` qui vérifiaient la pose du label de statut doivent être supprimés, pas adaptés : ce n'est plus le rôle de `deliver`.

- [ ] **Step 6 : commit**

```bash
git add src/jobs/pipeline.ts src/jobs/pipeline.test.ts src/deliver
git commit -m "feat(jobs): finish() clôt le ticket par la phase jira, avec filet"
```

---

## Task 9 : `doctor` et documentation

**Files:**
- Modify: `src/cli/commands/doctor.ts`, `src/cli/commands/doctor.test.ts`
- Modify: `README.md`

- [ ] **Step 1 : écrire le test qui échoue**

Ajouter à `src/cli/commands/doctor.test.ts`, sur le modèle des contrôles existants :

```typescript
  it('signale un plugin agent absent du paquet', async () => {
    const checks = await runChecks({ ...base, pluginExists: false });
    const line = checks.find((c) => c.name.includes('plugin agent'));
    expect(line).toMatchObject({ ok: false });
    expect(line?.detail).toMatch(/sisyphe-jira/);
  });
```

- [ ] **Step 2 : lancer le test et le voir échouer**

Run: `npx vitest run src/cli/commands/doctor.test.ts`
Expected: FAIL — aucun contrôle nommé `plugin agent`.

- [ ] **Step 3 : implémenter le contrôle**

Dans `src/cli/commands/doctor.ts`, ajouter le contrôle sur le modèle de ceux qui l'entourent (lire un
contrôle existant pour en reprendre exactement la forme de retour) :

```typescript
/**
 * Le plugin livré avec Sisyphe. `tsc` ne copie ni Markdown ni JSON : ces fichiers vivent dans le dépôt et
 * n'apparaissent pas dans `dist/`. Absents, la phase `jira` tournerait sans son skill — un agent qui
 * improvise sur un ticket réel plutôt qu'un échec visible.
 */
async function checkAgentPlugin(): Promise<Check> {
  const root = agentPluginPath();
  const required = [join(root, '.claude-plugin', 'plugin.json'), join(root, 'skills', 'sisyphe-jira', 'SKILL.md')];
  const missing: string[] = [];
  for (const f of required) {
    try {
      await access(f);
    } catch {
      missing.push(f);
    }
  }
  if (missing.length === 0) return { name: 'plugin agent (sisyphe-jira)', ok: true, detail: root };
  return {
    name: 'plugin agent (sisyphe-jira)',
    ok: false,
    detail: `fichiers manquants : ${missing.join(', ')}. Le plugin vit dans le dépôt, pas dans dist/ : reprendre le clone (git status) plutôt que relancer npm run build.`,
  };
}
```

Adapter le nom du type `Check` et la forme des champs à ceux du fichier, et brancher l'appel dans la liste
des contrôles exécutés. Ajouter les imports `access` (`node:fs/promises`), `join` (`node:path`) et
`agentPluginPath` (`../../agent/plugin-path.js`).

- [ ] **Step 4 : lancer le test et le voir passer**

Run: `npx vitest run src/cli/commands/doctor.test.ts`
Expected: PASS.

- [ ] **Step 5 : documenter**

Dans `README.md`, ajouter une section « Ce que Sisyphe écrit sur le ticket Jira » : la phase `jira`, le filet, la commande `sisyphe jira` et ses six verbes, et le fait que la clé apparaît dans le commit et le titre de PR pour que le panneau Développement se remplisse. Mentionner que les backends `codex` et `opencode` gardent le chemin scripté.

- [ ] **Step 6 : lancer toute la suite et construire**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: PASS, aucune erreur.

- [ ] **Step 7 : commit**

```bash
git add src/cli/commands/doctor.ts src/cli/commands/doctor.test.ts README.md
git commit -m "feat(doctor): vérifie le plugin agent ; docs: la clôture Jira"
```

---

## Task 10 : vérification de bout en bout sur un vrai ticket

Rien de ce qui précède ne prouve que l'agent sait se servir du skill. Un test avec un faux runner vérifie le câblage, pas le jugement.

- [ ] **Step 1 : préparer un ticket de contrôle**

Créer dans Jira un ticket trivial sur le projet configuré, l'assigner au compte dédié, le placer dans un statut candidat.

- [ ] **Step 2 : lancer un cycle complet**

Run: `sisyphe start --once`
Expected: le job va jusqu'à la PR.

- [ ] **Step 3 : vérifier les cinq points**

```bash
sisyphe logs <jobId> --phase jira    # la phase a tourné, le transcript montre des appels `sisyphe jira`
sisyphe jira show <KEY>              # le ticket est dans le statut de relecture
gh pr view <n> --json title,body     # titre `type(KEY): …`, corps ouvrant sur `Ticket: [KEY](…)`, pas de `Closes`
git log -1 --format=%s <branche>     # sujet `type(KEY): …`
```

Puis, sur le ticket dans Jira : le panneau **Développement** montre la branche, le commit et la pull request. C'est le point qui manquait sur IOS-886 — s'il reste vide, la clé n'est pas là où l'app la cherche, et c'est la Task 4 qu'il faut reprendre.

- [ ] **Step 4 : vérifier le filet**

Relancer un job en rendant `sisyphe jira` indisponible pour l'agent (renommer temporairement le binaire sur le `PATH` passé à l'agent, ou pointer `SISYPHE_HOME` sur une configuration sans section `jira`). Attendu : le job se termine quand même, le ticket est rendu et porte le commentaire scripté.

- [ ] **Step 5 : consigner**

Ajouter à la fin de la spec une section « Vérifié en production le … » avec la clé du ticket de contrôle et ce qui a été observé.

```bash
git add docs/superpowers/specs/2026-09-16-sisyphe-jira-agent-design.md
git commit -m "docs(spec): vérification de bout en bout"
```

---

## Ce que ce plan ne fait pas

Repris de la §7 de la spec, pour qu'un relecteur ne le cherche pas :

- La batterie de tests intégrale sur un ticket trivial (IOS-886 : trente minutes pour une couleur).
- Les messages d'erreur du daemon qui disent encore `acme/demo#42` (`daemon.ts:524`, `:531`).
- Le formulaire « Nouveau job » de l'UI, qui demande un numéro (`page.ts:248`, `actions.ts:133`).
- `cli/format.ts:31`, qui affiche `repo#N`.
- Les jobs antérieurs à la bascule Jira, dont les liens pointent dans le vide.
