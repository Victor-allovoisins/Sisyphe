# Plan d'implémentation — av-tools, phase A : lire av-tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal :** à chaque job suivi sur Jira, Sisyphe lit la version à jour des conventions de livraison
d'av-tools, la valide, l'épingle, et note dans le job le commit utilisé. Doctor dit ce que le prochain job
trouvera. Rien ne change encore dans ce que Sisyphe livre : c'est la phase B.

**Architecture :**
- **Jetons réduits** : `getAuthenticatedRemoteUrl` crée un jeton limité au dépôt demandé, en lecture seule
  pour av-tools.
- **`src/avtools/templates.ts`** valide le fichier (schéma zod, repris du contrôle `[I]` d'av-tools) et rend
  les modèles.
- **`src/avtools/source.ts`** tient le miroir git d'av-tools, rafraîchit la branche, et épingle la dernière
  version validée sous `refs/sisyphe/avtools/validated`.
- **Pipeline** : il charge la version après `getIssue` et note son SHA (migration 5). En phase A, une version
  illisible ne bloque rien.

**Tech Stack :** TypeScript (Node 24, ESM), vitest, zod 4, `yaml`, git via `execa`, `@octokit/app`.

Spec : `docs/superpowers/specs/2026-09-30-sisyphe-avtools-design.md`, §§ 2, 3 et 5.

**Conventions d'exécution :**
- Toutes les commandes se lancent depuis `/Users/victor/Developer/Others/Sisyphe/.wt/feature-avtools-skills-sisyphe`.
- Commits au format du dépôt : `type(portée): description`, en français.
- Ne jamais pousser.
- Prérequis, hors code : le propriétaire du compte ILokYou ajoute `IA-Claude-Marketplace` aux dépôts de l'app
  `allo-sisyphe`. Aucun test ne dépend de cette action.

---

## Fichiers

| Fichier | Rôle |
|---|---|
| Modifier `docs/superpowers/specs/2026-09-30-sisyphe-avtools-design.md` | La phase A ne bloque pas ; ce que doctor appelle « en retard » |
| Modifier `src/github/source.ts`, `src/github/client.ts`, `test/fakes/fake-issue-source.ts` | Jetons réduits au dépôt, URL distante par dépôt dans le faux |
| Modifier `src/config/machine.ts`, `src/config/write.ts` | Section `avTools` et ses valeurs par défaut |
| Modifier `src/git/git.ts`, `test/helpers/git-fixture.ts` | `resolveRef`, `readFileAtSha`, `pinRef` ; `addCommit` |
| Créer `test/fixtures/av-tools/delivery-templates.yml` | Copie de test du fichier d'av-tools (PR #53) |
| Créer `src/avtools/templates.ts` | Validation et rendu |
| Créer `src/avtools/source.ts` | Miroir, épingle, repli |
| Modifier `src/store/db.ts`, `src/store/types.ts`, `src/store/jobs.ts`, `src/store/store.test.ts` | Migration 5, `Job.avToolsSha` |
| Modifier `src/jobs/pipeline.ts`, `src/app.ts` | Chargement en début de job, câblage |
| Modifier `src/cli/commands/doctor.ts` | Check « av-tools » |

---

### Tâche 1 : amender la spec

**Files :**
- Modify: `docs/superpowers/specs/2026-09-30-sisyphe-avtools-design.md`

La spec dit qu'en l'absence de version valide, le ticket est rendu avant le triage. Appliqué dès la phase A,
cela bloquerait tous les jobs Jira tant que la #53 n'est pas fusionnée : le fichier n'existe pas encore sur
`main`. La phase A ne bloque donc rien, et le blocage arrive avec la phase B, quand Sisyphe rend réellement
depuis av-tools.

- [ ] **Étape 1 : § 3.1**

Remplacer le paragraphe qui commence par `Elle n'est **requise que si \`jira\` est configuré**.` par :

```markdown
Absente, ou partiellement remplie, elle prend ces valeurs par défaut, résolues à l'usage par
`resolveAvTools(machine)` : le fichier de config n'est jamais réécrit avec des valeurs que personne n'a
saisies. Elle ne sert que sous suivi Jira. `config/write.ts` doit la reporter à l'écriture comme il reporte
`jira` à la main (`write.ts:43-49`), sinon la page de réglages l'efface.
```

- [ ] **Étape 2 : § 3.4, puce `null`**

Remplacer la puce qui commence par `- **\`null\`** :` par :

```markdown
- **`null`** :
  - En phase A, le job continue sans version d'av-tools (`avToolsSha` reste nul), avec un avertissement au
    journal. Rien ne se rend encore depuis av-tools, et bloquer ici arrêterait tous les jobs Jira tant que la
    #53 n'est pas fusionnée.
  - En phase B, `finish('blocked')` avec le message Sisyphe `renderAvToolsUnavailableComment`, en 🪨, qui dit
    que les conventions av-tools sont illisibles et que doctor en donne la raison. Le ticket est rendu. Aucun
    agent n'a tourné.
```

- [ ] **Étape 3 : § 3.5, réponse du check**

Remplacer les trois puces de la réponse (`ok`, `avertissement`, `échec`) par :

```markdown
- **ok** : `main valide, épingle <sha court>` ou `main valide, aucune épingle`. Si la branche est valide,
  le prochain job l'épinglera : il n'y a pas de retard à signaler.
- **avertissement** : la branche est inutilisable (fichier absent ou invalide), mais une épingle existe. Les
  jobs gardent alors la dernière version validée, c'est-à-dire du retard sur la branche.
- **échec** : pas d'accès au dépôt, ou branche inutilisable sans aucune épingle.
```

- [ ] **Étape 4 : commit**

```bash
git add docs/superpowers/specs/2026-09-30-sisyphe-avtools-design.md
git commit -m "docs(spec): av-tools — la phase A ne bloque pas, retard défini pour doctor"
```

---

### Tâche 2 : jetons réduits au dépôt demandé

**Files :**
- Modify: `src/github/source.ts:126-127`
- Modify: `src/github/client.ts:263-266`
- Modify: `test/fakes/fake-issue-source.ts:49,172-174`
- Test: `src/github/client.test.ts`

- [ ] **Étape 1 : les tests qui échouent**

À la fin de `src/github/client.test.ts` :

```ts
describe('getAuthenticatedRemoteUrl', () => {
  it('réduit le jeton au dépôt demandé', async () => {
    const src = makeClient();
    const calls: unknown[] = [];
    inject(src, { auth: async (o: unknown) => { calls.push(o); return { token: 'tok' }; } });
    expect(await src.getAuthenticatedRemoteUrl(repo)).toBe('https://x-access-token:tok@github.com/acme/demo.git');
    expect(calls).toEqual([{ type: 'installation', repositoryNames: ['demo'] }]);
  });

  it('readOnly le limite en plus à contents: read', async () => {
    const src = makeClient();
    const calls: unknown[] = [];
    inject(src, { auth: async (o: unknown) => { calls.push(o); return { token: 'tok' }; } });
    await src.getAuthenticatedRemoteUrl(repo, { readOnly: true });
    expect(calls).toEqual([{ type: 'installation', repositoryNames: ['demo'], permissions: { contents: 'read' } }]);
  });
});
```

- [ ] **Étape 2 : les voir échouer**

Run : `npx vitest run src/github/client.test.ts -t getAuthenticatedRemoteUrl`
Expected : FAIL, `calls` vaut `[{ type: 'installation' }]`.

- [ ] **Étape 3 : le contrat**

Dans `src/github/source.ts`, remplacer les deux lignes de `getAuthenticatedRemoteUrl` de l'interface `Forge` par :

```ts
  /**
   * URL HTTPS avec un jeton d'installation **réduit à ce seul dépôt**, valide environ une heure : à ré-obtenir
   * juste avant chaque fetch ou push, jamais mémorisée au-delà d'une opération. `readOnly` le limite en plus
   * à `contents: read` : c'est la forme des lectures d'av-tools, dont le `main` n'est pas protégé et part chez
   * tous les devs.
   */
  getAuthenticatedRemoteUrl(repo: RepoRef, opts?: { readOnly?: boolean }): Promise<string>;
```

- [ ] **Étape 4 : le client**

Dans `src/github/client.ts`, remplacer la méthode `getAuthenticatedRemoteUrl` par :

```ts
  async getAuthenticatedRemoteUrl(repo: RepoRef, opts: { readOnly?: boolean } = {}): Promise<string> {
    // Sans `repositoryNames`, le jeton couvre toute l'installation : un jeton demandé pour pousser sur l'app
    // iOS pourrait écrire sur av-tools. GitHub réduit le jeton à sa création, rien d'autre n'est à gérer.
    const auth = await this.call(async (o) =>
      (await o.auth({
        type: 'installation',
        repositoryNames: [repo.name],
        ...(opts.readOnly ? { permissions: { contents: 'read' } } : {}),
      })) as { token: string },
    );
    return `https://x-access-token:${auth.token}@github.com/${repo.full}.git`;
  }
```

- [ ] **Étape 5 : le faux**

Dans `test/fakes/fake-issue-source.ts`, sous `remoteUrl = 'file:///dev/null';`, ajouter :

```ts
  /** URL par dépôt (`owner/name`), prioritaire sur `remoteUrl` : un job et av-tools n'ont pas le même distant. */
  remoteUrls: Record<string, string> = {};
  /** Options reçues par le dernier `getAuthenticatedRemoteUrl`, par dépôt : les tests vérifient `readOnly`. */
  remoteUrlOpts: Record<string, { readOnly?: boolean } | undefined> = {};
```

et remplacer la méthode `getAuthenticatedRemoteUrl` par :

```ts
  async getAuthenticatedRemoteUrl(repo: RepoRef, opts?: { readOnly?: boolean }): Promise<string> {
    this.remoteUrlOpts[repo.full] = opts;
    return this.remoteUrls[repo.full] ?? this.remoteUrl;
  }
```

Si `RepoRef` n'est pas encore importé en tête du fichier, l'ajouter à l'import de `../../src/github/source.js`.

- [ ] **Étape 6 : vérifier**

Run : `npx vitest run src/github/client.test.ts test/fakes`
Expected : PASS.

Run : `npm run typecheck`
Expected : aucune erreur.

- [ ] **Étape 7 : commit**

```bash
git add src/github/source.ts src/github/client.ts src/github/client.test.ts test/fakes/fake-issue-source.ts
git commit -m "feat(github): jetons d'installation réduits au dépôt demandé, lecture seule sur demande"
```

---

### Tâche 3 : la section `avTools`

**Files :**
- Modify: `src/config/machine.ts` (schéma, après `jira`)
- Modify: `src/config/write.ts:43-49`
- Test: `src/config/machine.test.ts`, `src/config/write.test.ts`

- [ ] **Étape 1 : les tests qui échouent**

À la fin de `src/config/machine.test.ts` (importer `stringify` de `yaml`, et `AV_TOOLS_DEFAULTS`,
`resolveAvTools` de `./machine.js`, s'ils ne le sont pas) :

```ts
describe('avTools', () => {
  const base = { github: { appId: 1, installationId: 1, privateKeyPath: '/k.pem' }, repos: ['a/b'] };

  it('absente : les valeurs par défaut', () => {
    expect(resolveAvTools(parseMachineConfig(stringify(base)))).toEqual(AV_TOOLS_DEFAULTS);
  });

  it('partielle : seule la branche change', () => {
    const m = parseMachineConfig(stringify({ ...base, avTools: { branch: 'feature/delivery-templates' } }));
    expect(resolveAvTools(m)).toEqual({ ...AV_TOOLS_DEFAULTS, branch: 'feature/delivery-templates' });
  });

  it('une clé inconnue est refusée', () => {
    expect(() => parseMachineConfig(stringify({ ...base, avTools: { bogus: 1 } }))).toThrow(MachineConfigError);
  });
});
```

À la fin de `src/config/write.test.ts` (importer `mkdtemp`, `writeFile`, `rm` de `node:fs/promises`,
`tmpdir` de `node:os`, `join` de `node:path`, et `validateMachineConfigInput` de `./write.js`, s'ils ne le
sont pas) :

```ts
describe('validateMachineConfigInput — avTools', () => {
  it('reporte la section avTools que la page de réglages ne renvoie pas', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-write-'));
    const key = join(dir, 'k.pem');
    await writeFile(key, 'x');
    const raw = { github: { appId: 1, installationId: 1, privateKeyPath: key }, repos: ['a/b'] };
    const r = await validateMachineConfigInput(raw, { dataDir: '~/.sisyphe', jira: undefined, avTools: { branch: 'x' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.avTools).toEqual({ branch: 'x' });
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Étape 2 : les voir échouer**

Run : `npx vitest run src/config/machine.test.ts src/config/write.test.ts -t avTools`
Expected : FAIL, `resolveAvTools` n'est pas exporté.

- [ ] **Étape 3 : le schéma**

Dans `src/config/machine.ts`, dans `MachineConfigSchema`, juste après la section `jira` (après son
`.transform((v) => v ?? undefined),`) :

```ts
  /**
   * Où lire les conventions de livraison d'av-tools. Facultative, même partiellement : `resolveAvTools`
   * complète avec les valeurs par défaut, à l'usage, pour que le fichier ne se voie jamais réécrit avec des
   * valeurs que personne n'a saisies. Ne sert que sous suivi Jira : av-tools ne parle que de tickets Jira.
   */
  avTools: z
    .strictObject({
      repo: z.string().regex(REPO_PATTERN, 'format attendu : owner/repo').optional(),
      branch: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
    })
    .optional(),
```

Puis, après la déclaration de `type MachineConfig` :

```ts
/** Le dépôt, la branche et le fichier d'av-tools qu'un job lit, faute de réglage contraire. */
export const AV_TOOLS_DEFAULTS = {
  repo: 'ILokYou/IA-Claude-Marketplace',
  branch: 'main',
  path: 'plugins/av-tools/skills/av-shared/reference/delivery-templates.yml',
} as const;

export interface AvToolsLocation {
  repo: string;
  branch: string;
  path: string;
}

/** La section `avTools`, complétée des valeurs par défaut. */
export function resolveAvTools(machine: Pick<MachineConfig, 'avTools'>): AvToolsLocation {
  return {
    repo: machine.avTools?.repo ?? AV_TOOLS_DEFAULTS.repo,
    branch: machine.avTools?.branch ?? AV_TOOLS_DEFAULTS.branch,
    path: machine.avTools?.path ?? AV_TOOLS_DEFAULTS.path,
  };
}
```

- [ ] **Étape 4 : le report à l'écriture**

Dans `src/config/write.ts`, changer la signature de `validateMachineConfigInput` :

```ts
  current: Pick<MachineConfig, 'dataDir' | 'jira' | 'avTools'>,
```

et, juste après le bloc qui reporte `jira` (qui se termine par `raw = { ...(raw as Record<string, unknown>), jira: current.jira };` et `}`) :

```ts
  // Même report pour `avTools`, que la page ne gère pas non plus : l'enregistrer effacerait sinon le réglage
  // de branche, et les jobs retomberaient sur `main` sans que personne l'ait demandé.
  if (current.avTools && raw !== null && typeof raw === 'object' && !('avTools' in raw)) {
    raw = { ...(raw as Record<string, unknown>), avTools: current.avTools };
  }
```

- [ ] **Étape 5 : vérifier**

Run : `npx vitest run src/config`
Expected : PASS.

Run : `npm run typecheck`
Expected : aucune erreur. Les appelants de `validateMachineConfigInput` passent la config machine entière,
qui porte `avTools`.

- [ ] **Étape 6 : commit**

```bash
git add src/config/machine.ts src/config/write.ts src/config/machine.test.ts src/config/write.test.ts
git commit -m "feat(config): section avTools, valeurs par défaut résolues à l'usage"
```

---

### Tâche 4 : primitives git et fixture

**Files :**
- Modify: `src/git/git.ts` (constante après `BASE_REF_PREFIX` ; méthodes après `readFileAtRef`)
- Modify: `test/helpers/git-fixture.ts`
- Test: `src/git/git.test.ts`

- [ ] **Étape 1 : la fixture**

À la fin de `test/helpers/git-fixture.ts` :

```ts
/**
 * Ajoute un commit sur `branch` au distant créé par `createRemoteRepo(root, …)`, depuis son dépôt source.
 * `amend: true` réécrit le dernier commit et force le push : vu du miroir, c'est un force-push.
 */
export async function addCommit(
  root: string,
  files: Record<string, string>,
  opts: { branch?: string; message?: string; amend?: boolean } = {},
): Promise<string> {
  const src = join(root, 'src-repo');
  const branch = opts.branch ?? 'main';
  const git = (args: string[]) => execa('git', args, { cwd: src, env: TEST_ENV });
  await writeFiles(src, files);
  await git(['add', '-A']);
  await git(['commit', '-q', ...(opts.amend ? ['--amend'] : []), '-m', opts.message ?? 'update']);
  await git(['push', '-q', '--force', join(root, 'remote.git'), `HEAD:refs/heads/${branch}`]);
  return (await git(['rev-parse', 'HEAD'])).stdout.trim();
}
```

- [ ] **Étape 2 : les tests qui échouent**

Dans `src/git/git.test.ts`, ajouter `AVTOOLS_PIN_REF` à l'import de `./git.js` et `addCommit` à celui de
`../../test/helpers/git-fixture.js`. Puis, à l'intérieur du `describe('Git', …)` principal, après son
`afterEach` :

```ts
  describe('resolveRef, readFileAtSha, pinRef', () => {
    it('résout la branche rafraîchie et lit un fichier à ce SHA', async () => {
      expect(await git.resolveRef(repo, `${BASE_REF_PREFIX}main`)).toBe(headSha);
      expect(await git.readFileAtSha(repo, headSha, 'README.md')).toBe('# demo');
      expect(await git.readFileAtSha(repo, headSha, 'absent.txt')).toBeNull();
    });

    it('une ref inconnue rend null', async () => {
      expect(await git.resolveRef(repo, 'refs/sisyphe/nope')).toBeNull();
    });

    it("l'épingle retient un commit que main a perdu par un force-push", async () => {
      await git.pinRef(repo, AVTOOLS_PIN_REF, headSha);
      await addCommit(root, { 'README.md': '# réécrit\n' }, { amend: true });
      await git.ensureMirror(repo, remotePath, PUBLIC_URL, ['main']);
      expect(await git.resolveRef(repo, `${BASE_REF_PREFIX}main`)).not.toBe(headSha);
      expect(await git.resolveRef(repo, AVTOOLS_PIN_REF)).toBe(headSha);
      expect(await git.readFileAtSha(repo, headSha, 'README.md')).toBe('# demo');
    });

    it('refuse autre chose qu’un SHA complet', async () => {
      await expect(git.readFileAtSha(repo, 'main', 'README.md')).rejects.toThrow(GitError);
    });
  });
```

- [ ] **Étape 3 : les voir échouer**

Run : `npx vitest run src/git/git.test.ts -t resolveRef`
Expected : FAIL, `git.resolveRef is not a function`.

- [ ] **Étape 4 : l'implémentation**

Dans `src/git/git.ts`, sous `export const BASE_REF_PREFIX = 'refs/sisyphe/base/';` :

```ts
/**
 * Ref où Sisyphe épingle le dernier commit d'av-tools qu'il a validé. Les reflogs du miroir sont coupés :
 * après un force-push, seul ce pointeur retient ce commit, que `git gc` effacerait sinon.
 */
export const AVTOOLS_PIN_REF = 'refs/sisyphe/avtools/validated';
```

Dans la classe `Git`, juste après `readFileAtRef` :

```ts
  /** SHA du commit que pointe `ref` dans le miroir, ou null si la ref n'existe pas. */
  async resolveRef(repo: string, ref: string): Promise<string | null> {
    const r = await this.exec(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], mirrorPath(this.paths, repo));
    if (r.exitCode === 0) return r.stdout.trim();
    // 1 : `--quiet` dit « pas de telle ref », c'est une réponse. Tout autre code est une panne.
    if (r.exitCode === 1) return null;
    throw this.fail(['rev-parse', ref], r);
  }

  /** Contenu d'un fichier à un commit donné, désigné par son SHA complet ; null si le fichier n'y existe pas. */
  async readFileAtSha(repo: string, sha: string, path: string): Promise<string | null> {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitError(`SHA invalide : ${sha}`, 'show', '');
    const result = await this.exec(['show', `${sha}:${path}`], mirrorPath(this.paths, repo));
    if (result.exitCode === 0) return result.stdout;
    if (/does not exist in|exists on disk, but not in/.test(result.all ?? '')) return null;
    throw this.fail(['show'], result);
  }

  /** Pose `ref` sur `sha` dans le miroir, sous le verrou du dépôt comme toute écriture du miroir. */
  async pinRef(repo: string, ref: string, sha: string): Promise<void> {
    await this.withRepoLock(repo, async () => {
      await this.run(['update-ref', ref, sha], mirrorPath(this.paths, repo));
    });
  }
```

- [ ] **Étape 5 : vérifier**

Run : `npx vitest run src/git/git.test.ts`
Expected : PASS.

- [ ] **Étape 6 : commit**

```bash
git add src/git/git.ts src/git/git.test.ts test/helpers/git-fixture.ts
git commit -m "feat(git): lire un fichier à un SHA, résoudre et épingler une ref du miroir"
```

---

### Tâche 5 : les modèles

**Files :**
- Create: `test/fixtures/av-tools/delivery-templates.yml`
- Create: `src/avtools/templates.ts`
- Test: `src/avtools/templates.test.ts`

- [ ] **Étape 1 : la fixture**

C'est une copie **de test** du fichier de la PR av-tools #53. Aucune copie ne sert à l'exécution.

```bash
mkdir -p test/fixtures/av-tools
git -C /Users/victor/Developer/Others/allovoisins-cc-tools-delivery-templates show origin/feature/delivery-templates:plugins/av-tools/skills/av-shared/reference/delivery-templates.yml > test/fixtures/av-tools/delivery-templates.yml
```

Run : `grep -c "^  jira_\|^  pr_\|^  commit_subject" test/fixtures/av-tools/delivery-templates.yml`
Expected : `15`.

- [ ] **Étape 2 : les tests qui échouent**

`src/avtools/templates.test.ts` :

```ts
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseDeliveryTemplates, render, type DeliveryTemplates } from './templates.js';

const FIXTURE = fileURLToPath(new URL('../../test/fixtures/av-tools/delivery-templates.yml', import.meta.url));
const read = () => readFile(FIXTURE, 'utf8');

async function valid(): Promise<DeliveryTemplates> {
  const r = parseDeliveryTemplates(await read());
  if (!r.ok) throw new Error(r.reason);
  return r.value;
}

/** Le fichier réel abîmé par un remplacement : rend la raison du refus, et échoue si la version passe. */
async function broken(from: string | RegExp, to: string): Promise<string> {
  const text = await read();
  const out = text.replace(from, to);
  if (out === text) throw new Error(`mutation sans effet : ${String(from)}`);
  const r = parseDeliveryTemplates(out);
  if (r.ok) throw new Error('la version abîmée passe');
  return r.reason;
}

describe('parseDeliveryTemplates', () => {
  it("accepte le fichier d'av-tools", async () => {
    const t = await valid();
    expect(t.gitmoji.fix).toBe('🐛');
    expect(t.gitmoji.feature).toBe('✨');
    expect(t.forbidden).toEqual(['Co-Authored-By', 'Claude', 'Anthropic']);
  });

  it('refuse une version de schéma inconnue', async () => {
    expect(await broken(/^schema_version: 1$/m, 'schema_version: 2')).toContain('schema_version');
  });

  it('refuse une clé de premier niveau inconnue', async () => {
    expect(await broken(/^schema_version: 1$/m, 'schema_version: 1\nextra: 1')).toContain('extra');
  });

  it('refuse une clé dupliquée', async () => {
    expect(await broken(/^templates:$/m, 'templates:\n  jira_cancelled:\n    vars: {}\n    text: "x"')).toContain('YAML illisible');
  });

  it('refuse un gitmoji manquant', async () => {
    expect(await broken(/^  docs: .*\n/m, '')).toContain('gitmoji');
  });

  it('refuse un jeton non déclaré', async () => {
    expect(await broken('mis en pause : {reason}', 'mis en pause : {raison}')).toContain('{raison}');
  });

  it('refuse une liste qui ne tient pas seule sur sa ligne', async () => {
    expect(await broken(/^      \{problem\}$/m, '      - {problem}')).toContain('{problem}');
  });

  it("refuse un modèle d'une ligne qui contient un saut de ligne", async () => {
    expect(await broken('"Pull Request opened: {pr_url}"', '"Pull Request opened: {pr_url}\\n"')).toContain('jira_pr_opened');
  });

  it('refuse un texte vide', async () => {
    expect(await broken(/(  jira_cancelled:\n    vars: \{\}\n    text: )\|\n      .*\n/, '$1""\n')).toContain('texte vide');
  });

  it('refuse un modèle que Sisyphe rend et qui manque', async () => {
    expect(await broken(/\n  # No variable[^\n]*\n  jira_cancelled:[\s\S]*$/, '\n')).toContain('jira_cancelled : modèle absent');
  });

  it('refuse une variable que Sisyphe ne sait pas remplir', async () => {
    const reason = await broken(
      '      pr_url: text\n    text: "Pull Request opened: {pr_url}"',
      '      pr_url: text\n      branch: text\n    text: "Pull Request opened: {pr_url} {branch}"',
    );
    expect(reason).toContain('jira_pr_opened : variables');
  });
});

describe('render', () => {
  it("rend les modèles repris d'av-tools à l'identique", async () => {
    const t = await valid();
    expect(render(t, 'commit_subject', { gitmoji: '🐛', KEY: 'BACK-655', description: 'clean erreurs gcp' })).toBe('🐛(BACK-655): clean erreurs gcp');
    expect(render(t, 'pr_title', { gitmoji: '✨', KEY: 'BACK-655', short_description: 'export CSV' })).toBe('✨(BACK-655): export CSV');
    expect(render(t, 'pr_body_simple', { KEY: 'BACK-655', changes: ['Corrige X'], test_plan: ["Ouvrir l'écran X"] })).toBe(
      "## Summary\n- Ticket: [BACK-655](https://allovoisins.atlassian.net/browse/BACK-655)\n- Corrige X\n\n## Test plan\n- Ouvrir l'écran X",
    );
    expect(render(t, 'jira_pr_opened', { pr_url: 'https://github.com/ILokYou/ILokYou-Site/pull/1' })).toBe(
      'Pull Request opened: https://github.com/ILokYou/ILokYou-Site/pull/1',
    );
    expect(render(t, 'jira_review_summary', { problem: ['P'], fixed: ['C'], impact: ['I'] })).toBe(
      '**Analyse et correction**\n\n**Problème identifié :**\n- P\n\n**Ce qui a été corrigé :**\n- C\n\n**Impact :**\n- I',
    );
  });

  it("supprime la ligne d'une liste vide", async () => {
    const t = await valid();
    expect(render(t, 'jira_review_summary', { problem: [], fixed: ['C'], impact: [] })).toBe(
      '**Analyse et correction**\n\n**Problème identifié :**\n\n**Ce qui a été corrigé :**\n- C\n\n**Impact :**',
    );
  });

  it('rend en une passe : un jeton dans une valeur reste littéral', async () => {
    const t = await valid();
    expect(render(t, 'pr_body_simple', { KEY: 'BACK-1', changes: ['voir {test_plan}'], test_plan: ['T'] })).toContain('- voir {test_plan}');
  });

  it('retire les sauts de ligne finaux', async () => {
    const t = await valid();
    expect(render(t, 'jira_cancelled', {})).toBe('Le traitement de ce ticket a été annulé.');
  });
});
```

- [ ] **Étape 3 : les voir échouer**

Run : `npx vitest run src/avtools/templates.test.ts`
Expected : FAIL, `Cannot find module './templates.js'`.

- [ ] **Étape 4 : l'implémentation**

`src/avtools/templates.ts` :

```ts
import { parse } from 'yaml';
import { z } from 'zod';

/**
 * Les conventions de livraison d'av-tools (`delivery-templates.yml`), validées pour Sisyphe.
 *
 * La validation se fait en deux niveaux, dans cet ordre :
 * - la forme du fichier, reprise du contrôle `[I]` d'av-tools. Son `main` n'est pas protégé : un fichier
 *   cassé peut y arriver sans passer par la CI ;
 * - le contrat de Sisyphe : chaque modèle qu'il rend existe et déclare exactement les variables qu'il sait
 *   remplir. Un modèle qui gagnerait une variable inconnue partirait à moitié rempli. La version entière est
 *   donc refusée, et la source retombe sur la dernière version validée.
 */

export const SCHEMA_VERSION = 1;
const VAR_TYPES = ['text', 'list'] as const;
type VarType = (typeof VAR_TYPES)[number];
const SINGLE_LINE = new Set(['commit_subject', 'pr_title', 'jira_pr_opened']);
const TOKEN = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const LONE_TOKEN = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const GITMOJI_KEYS = ['fix', 'feature', 'refactor', 'chore', 'docs'] as const;
export type GitmojiKey = (typeof GITMOJI_KEYS)[number];

/**
 * Les modèles que Sisyphe rend, et les variables qu'il sait fournir à chacun. `pr_body_standard` n'y est
 * pas : il suppose un design doc, que Sisyphe ne produit pas.
 */
export const SISYPHE_TEMPLATES = {
  commit_subject: { gitmoji: 'text', KEY: 'text', description: 'text' },
  pr_title: { gitmoji: 'text', KEY: 'text', short_description: 'text' },
  pr_body_simple: { KEY: 'text', changes: 'list', test_plan: 'list' },
  jira_pr_opened: { pr_url: 'text' },
  jira_review_summary: { problem: 'list', fixed: 'list', impact: 'list' },
  jira_handback_needs_information: { reason: 'text', questions: 'list', assignee: 'text' },
  jira_handback_too_big: { reason: 'text', split: 'list', assignee: 'text' },
  jira_handback_out_of_scope: { reason: 'text', assignee: 'text' },
  jira_handback_ambiguous_version: { reason: 'text', assignee: 'text' },
  jira_handback_nothing_to_deliver: { reason: 'text', assignee: 'text' },
  jira_handback_unsafe_change: { findings: 'list', assignee: 'text' },
  jira_handback_technical_failure: { reason: 'text', assignee: 'text' },
  jira_pr_draft: { pr_url: 'text', failed_check: 'text', attempts: 'text' },
  jira_cancelled: {},
} as const satisfies Record<string, Record<string, VarType>>;

export type TemplateName = keyof typeof SISYPHE_TEMPLATES;
type VarsOf<N extends TemplateName> = (typeof SISYPHE_TEMPLATES)[N];
export type TemplateValues<N extends TemplateName> = {
  [K in keyof VarsOf<N>]: VarsOf<N>[K] extends 'list' ? readonly string[] : string;
};

interface Template {
  vars: Record<string, VarType>;
  text: string;
}

export interface DeliveryTemplates {
  gitmoji: Record<string, string>;
  forbidden: string[];
  templates: Record<string, Template>;
}

export type ParseResult = { ok: true; value: DeliveryTemplates } | { ok: false; reason: string };

const TemplateSchema = z.strictObject({
  vars: z.record(z.string(), z.enum(VAR_TYPES)),
  text: z.string().refine((t) => t.trim() !== '', 'texte vide'),
});

const FileSchema = z.strictObject({
  schema_version: z.literal(SCHEMA_VERSION),
  gitmoji: z
    .record(z.string(), z.string().min(1))
    .refine((g) => GITMOJI_KEYS.every((k) => k in g), `gitmoji incomplet : ${GITMOJI_KEYS.join(', ')} attendus`),
  commit_rules: z.strictObject({ forbidden: z.array(z.string().min(1)) }),
  templates: z.record(z.string(), TemplateSchema),
});

const tokensOf = (text: string): string[] => [...text.matchAll(TOKEN)].map((m) => m[1] as string);

function structuralProblems(name: string, tpl: Template): string[] {
  const problems: string[] = [];
  const used = new Set(tokensOf(tpl.text));
  for (const v of used) if (!(v in tpl.vars)) problems.push(`${name} : jeton {${v}} non déclaré`);
  for (const v of Object.keys(tpl.vars)) if (!used.has(v)) problems.push(`${name} : variable ${v} déclarée mais inutilisée`);
  for (const line of tpl.text.split('\n')) {
    for (const v of tokensOf(line)) {
      if (tpl.vars[v] === 'list' && line !== `{${v}}`) problems.push(`${name} : la liste {${v}} doit être seule et non indentée sur sa ligne`);
    }
  }
  if (SINGLE_LINE.has(name) && tpl.text.includes('\n')) problems.push(`${name} : modèle d'une ligne, sans saut de ligne`);
  return problems;
}

function contractProblems(templates: Record<string, Template>): string[] {
  const sorted = (vars: Record<string, string>) => JSON.stringify(Object.entries(vars).sort(([a], [b]) => a.localeCompare(b)));
  const problems: string[] = [];
  for (const [name, expected] of Object.entries(SISYPHE_TEMPLATES)) {
    const tpl = templates[name];
    if (!tpl) {
      problems.push(`${name} : modèle absent`);
      continue;
    }
    if (sorted(tpl.vars) !== sorted(expected)) {
      problems.push(`${name} : variables ${JSON.stringify(tpl.vars)}, Sisyphe attend ${JSON.stringify(expected)}`);
    }
  }
  return problems;
}

export function parseDeliveryTemplates(text: string): ParseResult {
  let raw: unknown;
  try {
    // `yaml` refuse par défaut les clés dupliquées (`uniqueKeys`) : c'est voulu, un doublon n'a pas de sens.
    raw = parse(text);
  } catch (err) {
    return { ok: false, reason: `YAML illisible : ${(err as Error).message}` };
  }
  const r = FileSchema.safeParse(raw);
  if (!r.success) {
    return { ok: false, reason: r.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ') };
  }
  const problems = [
    ...Object.entries(r.data.templates).flatMap(([name, tpl]) => structuralProblems(name, tpl)),
    ...contractProblems(r.data.templates),
  ];
  if (problems.length) return { ok: false, reason: problems.join(' ; ') };
  return { ok: true, value: { gitmoji: r.data.gitmoji, forbidden: r.data.commit_rules.forbidden, templates: r.data.templates } };
}

/**
 * Rend un modèle selon les règles de l'en-tête du fichier :
 * - une variable `text` est insérée telle quelle ;
 * - une variable `list` donne une ligne `- élément` par entrée, et une liste vide supprime la ligne ;
 * - la substitution se fait en une passe : une valeur insérée n'est jamais relue ;
 * - tous les sauts de ligne finaux sont retirés.
 */
export function render<N extends TemplateName>(t: DeliveryTemplates, name: N, values: TemplateValues<N>): string {
  const tpl = t.templates[name];
  if (!tpl) throw new Error(`modèle av-tools absent : ${name}`);
  const vals = values as Record<string, string | readonly string[]>;
  const out: string[] = [];
  for (const line of tpl.text.split('\n')) {
    const lone = LONE_TOKEN.exec(line);
    if (lone && tpl.vars[lone[1] as string] === 'list') {
      for (const item of vals[lone[1] as string] as readonly string[]) out.push(`- ${item}`);
      continue;
    }
    out.push(line.replace(TOKEN, (_, v: string) => vals[v] as string));
  }
  return out.join('\n').replace(/\n+$/, '');
}
```

- [ ] **Étape 5 : vérifier**

Run : `npx vitest run src/avtools/templates.test.ts`
Expected : PASS.

Run : `npm run typecheck`
Expected : aucune erreur.

- [ ] **Étape 6 : commit**

```bash
git add test/fixtures/av-tools/delivery-templates.yml src/avtools/templates.ts src/avtools/templates.test.ts
git commit -m "feat(avtools): valider et rendre les modèles de livraison d'av-tools"
```

---

### Tâche 6 : la source

**Files :**
- Create: `src/avtools/source.ts`
- Test: `src/avtools/source.test.ts`

- [ ] **Étape 1 : les tests qui échouent**

`src/avtools/source.test.ts` :

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeIssueSource } from '../../test/fakes/fake-issue-source.js';
import { addCommit, createRemoteRepo } from '../../test/helpers/git-fixture.js';
import { dataPaths } from '../config/paths.js';
import { Git } from '../git/git.js';
import { AvToolsSource } from './source.js';

const REPO = 'ILokYou/IA-Claude-Marketplace';
const PATH = 'plugins/av-tools/skills/av-shared/reference/delivery-templates.yml';
const FIXTURE = fileURLToPath(new URL('../../test/fixtures/av-tools/delivery-templates.yml', import.meta.url));

describe('AvToolsSource', () => {
  let root: string;
  let avRoot: string;
  let git: Git;
  let forge: FakeIssueSource;
  let headSha: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sisyphe-avtools-'));
    avRoot = join(root, 'av');
    const { remotePath, headSha: sha } = await createRemoteRepo(avRoot, { [PATH]: await readFile(FIXTURE, 'utf8') });
    headSha = sha;
    git = new Git(dataPaths(join(root, 'data')));
    forge = new FakeIssueSource();
    forge.remoteUrls[REPO] = remotePath;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const source = () => new AvToolsSource({ git, forge, location: { repo: REPO, branch: 'main', path: PATH }, log: pino({ level: 'silent' }) });

  it('lit la tête valide, l’épingle, et demande un jeton en lecture seule', async () => {
    const s = await source().load();
    expect(s).toMatchObject({ sha: headSha, fresh: true });
    expect(s?.templates.gitmoji.fix).toBe('🐛');
    expect(await source().pinnedSha()).toBe(headSha);
    expect(forge.remoteUrlOpts[REPO]).toEqual({ readOnly: true });
  });

  it('un commit invalide par-dessus : repli sur l’épingle', async () => {
    await source().load();
    await addCommit(avRoot, { [PATH]: 'schema_version: 2\n' });
    expect(await source().load()).toMatchObject({ sha: headSha, fresh: false });
  });

  it('un fetch en échec : repli sur l’épingle', async () => {
    await source().load();
    forge.remoteUrls[REPO] = join(root, 'nulle-part.git');
    expect(await source().load()).toMatchObject({ sha: headSha, fresh: false });
  });

  it('un force-push invalide : l’épingle retient encore le commit perdu', async () => {
    await source().load();
    await addCommit(avRoot, { [PATH]: 'cassé: [\n' }, { amend: true });
    expect(await source().load()).toMatchObject({ sha: headSha, fresh: false });
  });

  it('une nouvelle version valide remplace l’épingle', async () => {
    await source().load();
    const text = await readFile(FIXTURE, 'utf8');
    const next = await addCommit(avRoot, { [PATH]: `${text}\n# relu\n` });
    expect(await source().load()).toMatchObject({ sha: next, fresh: true });
    expect(await source().pinnedSha()).toBe(next);
  });

  it('fichier absent et aucune épingle : null', async () => {
    const other = await createRemoteRepo(join(root, 'vide'), { 'README.md': 'x\n' });
    forge.remoteUrls[REPO] = other.remotePath;
    expect(await source().load()).toBeNull();
    expect(await source().pinnedSha()).toBeNull();
  });
});
```

- [ ] **Étape 2 : les voir échouer**

Run : `npx vitest run src/avtools/source.test.ts`
Expected : FAIL, `Cannot find module './source.js'`.

- [ ] **Étape 3 : l'implémentation**

`src/avtools/source.ts` :

```ts
import type { Logger } from 'pino';
import type { AvToolsLocation } from '../config/machine.js';
import { AVTOOLS_PIN_REF, BASE_REF_PREFIX, type Git } from '../git/git.js';
import { parseRepo, type Forge } from '../github/source.js';
import { parseDeliveryTemplates, type DeliveryTemplates, type ParseResult } from './templates.js';

/** Les conventions d'av-tools qu'un job utilise, et le commit dont elles viennent. */
export interface AvToolsSnapshot {
  sha: string;
  templates: DeliveryTemplates;
  /** Faux : la tête de la branche était injoignable ou invalide, c'est la dernière version validée qui sert. */
  fresh: boolean;
}

/** Ce que le pipeline et doctor attendent de la source ; les tests en passent un faux. */
export interface AvToolsLoader {
  load(): Promise<AvToolsSnapshot | null>;
  pinnedSha(): Promise<string | null>;
}

export interface AvToolsSourceDeps {
  git: Git;
  forge: Pick<Forge, 'getAuthenticatedRemoteUrl'>;
  location: AvToolsLocation;
  log: Logger;
}

export class AvToolsSource implements AvToolsLoader {
  constructor(private readonly d: AvToolsSourceDeps) {}

  /**
   * Rafraîchit le miroir d'av-tools, puis rend la version à utiliser :
   * - la tête de la branche si elle est valide, qui devient alors l'épingle ;
   * - sinon la dernière version validée ;
   * - sinon `null`.
   *
   * Ne lève jamais : une panne ici prive le job d'av-tools, elle ne le fait pas échouer.
   */
  async load(): Promise<AvToolsSnapshot | null> {
    const { repo, branch } = this.d.location;
    let why: string;
    try {
      // Lecture seule : ce jeton ne pourra jamais écrire sur av-tools, quoi qu'il arrive au processus.
      const url = await this.d.forge.getAuthenticatedRemoteUrl(parseRepo(repo), { readOnly: true });
      await this.d.git.ensureMirror(repo, url, `https://github.com/${repo}.git`, [branch]);
      const sha = await this.d.git.resolveRef(repo, `${BASE_REF_PREFIX}${branch}`);
      if (!sha) throw new Error(`branche ${branch} introuvable après le fetch`);
      const parsed = await this.parseAt(sha);
      if (parsed.ok) {
        await this.d.git.pinRef(repo, AVTOOLS_PIN_REF, sha);
        return { sha, templates: parsed.value, fresh: true };
      }
      why = `${branch}@${sha.slice(0, 7)} : ${parsed.reason}`;
    } catch (err) {
      why = err instanceof Error ? err.message : String(err);
    }
    return this.fromPin(why);
  }

  /** Le SHA épinglé, ou null : pas encore de miroir, ou jamais de version validée. */
  async pinnedSha(): Promise<string | null> {
    return this.d.git.resolveRef(this.d.location.repo, AVTOOLS_PIN_REF).catch(() => null);
  }

  private async parseAt(sha: string): Promise<ParseResult> {
    const text = await this.d.git.readFileAtSha(this.d.location.repo, sha, this.d.location.path);
    if (text === null) return { ok: false, reason: `${this.d.location.path} absent` };
    return parseDeliveryTemplates(text);
  }

  private async fromPin(why: string): Promise<AvToolsSnapshot | null> {
    const pinned = await this.pinnedSha();
    if (pinned) {
      const parsed = await this.parseAt(pinned).catch((err: unknown): ParseResult => ({ ok: false, reason: String(err) }));
      if (parsed.ok) {
        this.d.log.warn({ why, pinned }, 'av-tools : tête de branche inutilisable, repli sur la dernière version validée');
        return { sha: pinned, templates: parsed.value, fresh: false };
      }
    }
    this.d.log.warn({ why }, 'av-tools : aucune version validée disponible');
    return null;
  }
}
```

- [ ] **Étape 4 : vérifier**

Run : `npx vitest run src/avtools`
Expected : PASS.

- [ ] **Étape 5 : commit**

```bash
git add src/avtools/source.ts src/avtools/source.test.ts
git commit -m "feat(avtools): miroir d'av-tools, épingle de la dernière version validée, repli"
```

---

### Tâche 7 : le SHA d'av-tools dans le job

**Files :**
- Modify: `src/store/db.ts` (fin de `MIGRATIONS`)
- Modify: `src/store/types.ts` (`Job`, après `baseSha`)
- Modify: `src/store/jobs.ts` (`rowToJob`, `COLUMNS`)
- Test: `src/store/store.test.ts:195-265`

- [ ] **Étape 1 : adapter les tests qui reconstruisent d'anciennes bases**

Dans `src/store/store.test.ts` :

1. Test `migre une base existante en version 1 …` : juste avant `a.exec('ALTER TABLE jobs DROP COLUMN issue_key');`, ajouter
   `a.exec('ALTER TABLE jobs DROP COLUMN av_tools_sha');`.
2. Test `ajoute issue_key à une base peuplée …` : remplacer les deux lignes
   `a.exec('ALTER TABLE jobs DROP COLUMN issue_key');` et `` a.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`); `` par :

   ```ts
       // Ramenée juste avant `issue_key` (migration 4), donc sans les colonnes des migrations 4 et 5.
       a.exec('ALTER TABLE jobs DROP COLUMN av_tools_sha');
       a.exec('ALTER TABLE jobs DROP COLUMN issue_key');
       a.exec('PRAGMA user_version = 3');
   ```
3. Test `deux migrateurs concurrents …` : juste avant `seed.exec('ALTER TABLE jobs DROP COLUMN issue_key');`, ajouter
   `seed.exec('ALTER TABLE jobs DROP COLUMN av_tools_sha');`.

Puis ajouter, après le test `ajoute issue_key …` :

```ts
  it('ajoute av_tools_sha à une base peuplée, dont les lignes existantes restent sans SHA', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sisyphe-db-'));
    const file = join(dir, 'sisyphe.db');
    const a = openDatabase(file);
    const before = new JobStore(a).create({ repo: 'a/b', issueNumber: 1, issueTitle: 't' });
    a.exec('ALTER TABLE jobs DROP COLUMN av_tools_sha');
    a.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    a.close();

    const b = openDatabase(file);
    const store = new JobStore(b);
    expect(store.get(before.id)?.avToolsSha).toBeNull();
    const sha = 'a'.repeat(40);
    expect(store.update(before.id, { avToolsSha: sha }).avToolsSha).toBe(sha);
    b.close();
    await rm(dir, { recursive: true, force: true });
  });
```

- [ ] **Étape 2 : les voir échouer**

Run : `npx vitest run src/store/store.test.ts`
Expected : FAIL. `av_tools_sha` n'existe pas (`no such column`), et `avToolsSha` est `undefined`.

- [ ] **Étape 3 : la migration**

Dans `src/store/db.ts`, ajouter à la fin du tableau `MIGRATIONS`, après la migration `issue_key` :

```ts
  // Le commit d'av-tools dont un job a tiré ses conventions de livraison. Nullable, simple ALTER comme
  // `issue_key` : un job d'avant, sans suivi Jira ou sans version lisible, n'en a pas.
  `
  ALTER TABLE jobs ADD COLUMN av_tools_sha TEXT;
  `,
```

- [ ] **Étape 4 : le type et le store**

Dans `src/store/types.ts`, dans `interface Job`, sous `baseSha: string | null;` :

```ts
  /** Commit d'av-tools dont ce job tire ses conventions de livraison ; null sans suivi Jira ou sans version lisible. */
  avToolsSha: string | null;
```

Dans `src/store/jobs.ts`, dans `rowToJob`, sous `baseSha: …,` :

```ts
    avToolsSha: (r.av_tools_sha as string | null) ?? null,
```

et dans `COLUMNS`, après `baseSha: 'base_sha',` :

```ts
avToolsSha: 'av_tools_sha',
```

- [ ] **Étape 5 : les littéraux de `Job`**

Run : `npm run typecheck`
Expected : une erreur `Property 'avToolsSha' is missing` par objet `Job` écrit en entier (fixtures de tests,
faux). Ajouter `avToolsSha: null,` sous `baseSha` dans chacun, puis relancer jusqu'à zéro erreur.

- [ ] **Étape 6 : vérifier**

Run : `npx vitest run src/store`
Expected : PASS.

- [ ] **Étape 7 : commit**

```bash
git add -A src test
git commit -m "feat(store): migration 5, le SHA d'av-tools de chaque job"
```

---

### Tâche 8 : le pipeline et le câblage

**Files :**
- Modify: `src/jobs/pipeline.ts` (`PipelineDeps` ; `runJob`, après `const loaded = issue;`)
- Modify: `src/app.ts:64-67`
- Test: `test/integration/jira-pipeline.test.ts`, `test/integration/pipeline.test.ts`

- [ ] **Étape 1 : les tests qui échouent**

À la fin de `test/integration/jira-pipeline.test.ts` :

```ts
describe('pipeline sur Jira — version d’av-tools', () => {
  const blocked = { ...readyVerdict, verdict: 'needs_clarification', note: 'Il manque un écran.', questions: ['Quel écran ?'] };

  it('note le SHA de la version lue', async () => {
    const j = fakeJira();
    const h = await harnessOn(j.tracker, [{ output: blocked }, { output: jiraMuet }]);
    const calls: string[] = [];
    h.deps.avTools = {
      load: async () => { calls.push('load'); return { sha: 'a'.repeat(40), templates: { gitmoji: {}, forbidden: [], templates: {} }, fresh: true }; },
      pinnedSha: async () => null,
    };
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());
    expect(calls).toEqual(['load']);
    expect(done.avToolsSha).toBe('a'.repeat(40));
  });

  it('en phase A, une version illisible ne bloque rien', async () => {
    const j = fakeJira();
    const h = await harnessOn(j.tracker, [{ output: blocked }, { output: jiraMuet }]);
    h.deps.avTools = { load: async () => null, pinnedSha: async () => null };
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, signal());
    // Le triage a tourné et décidé : le blocage vient de lui, pas d'av-tools.
    expect(done.state).toBe('blocked');
    expect(done.error).toBe('triage : needs_clarification');
    expect(done.avToolsSha).toBeNull();
  });
});
```

À la fin de `test/integration/pipeline.test.ts` (importer `makeHarness`, `readyVerdict`, `REPO` de
`../helpers/harness.js`, `runJob` de `../../src/jobs/pipeline.js`, et `describe`, `expect`, `it` de
`vitest`, s'ils ne le sont pas) :

```ts
describe('pipeline sous suivi GitHub — av-tools', () => {
  it("ne lit pas av-tools : il ne parle que de tickets Jira", async () => {
    const blocked = { ...readyVerdict, verdict: 'needs_clarification', note: 'x', questions: ['?'] };
    const h = await makeHarness({ steps: [{ output: blocked }] });
    const calls: string[] = [];
    h.deps.avTools = { load: async () => { calls.push('load'); return null; }, pinnedSha: async () => null };
    const job = h.store.create({ repo: REPO, issueNumber: 7, issueTitle: 'Ajouter feature hello' });
    const done = await runJob(job.id, h.deps, new AbortController().signal);
    expect(done.state).toBe('blocked');
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Étape 2 : les voir échouer**

Run : `npx vitest run test/integration/jira-pipeline.test.ts test/integration/pipeline.test.ts -t av-tools`
Expected : FAIL. `avTools` n'existe pas sur `PipelineDeps` (erreur de type), ou `calls` reste vide dans le
premier test.

- [ ] **Étape 3 : les dépendances du pipeline**

Dans `src/jobs/pipeline.ts`, importer le type :

```ts
import type { AvToolsLoader } from '../avtools/source.js';
```

et ajouter à `PipelineDeps`, après `scan?: ScanFn;` :

```ts
  /** Conventions de livraison d'av-tools. Absent sans suivi Jira : av-tools ne parle que de tickets Jira. */
  avTools?: AvToolsLoader;
```

- [ ] **Étape 4 : le chargement**

Dans `runJob`, juste après `const loaded = issue;` :

```ts
    // Sous suivi Jira, la version d'av-tools du job est fixée ici, avant tout ce qui pourrait s'en servir.
    // Phase A : elle n'est que notée. Rien ne se rend encore depuis elle, et une version illisible ne bloque
    // rien — sans quoi aucun job Jira ne passerait tant que le fichier n'est pas sur `main`.
    if (loaded.tracker && deps.avTools) {
      const av = await deps.avTools.load();
      job = store.update(job.id, { avToolsSha: av?.sha ?? null });
      if (!av) log.warn('av-tools illisible : job poursuivi sans conventions de livraison');
    }
```

- [ ] **Étape 5 : le câblage**

Dans `src/app.ts`, importer :

```ts
import { AvToolsSource } from './avtools/source.js';
```

et ajouter `resolveAvTools` à l'import de `./config/machine.js`. Remplacer la construction de `deps` par :

```ts
  const git = new Git(paths);
  const deps: PipelineDeps = {
    store: new JobStore(db), phases: new PhaseStore(db), actions: new ActionStore(db), source: jira ?? github, forge: github, agent, git, paths, machine, log, env: process.env,
    // Seulement sous suivi Jira, comme le pipeline qui s'en sert.
    ...(jira ? { avTools: new AvToolsSource({ git, forge: github, location: resolveAvTools(machine), log: log.child({ component: 'av-tools' }) }) } : {}),
  };
```

- [ ] **Étape 6 : vérifier**

Run : `npx vitest run test/integration`
Expected : PASS, tests existants compris : le harnais ne câble pas `avTools`, rien ne change pour eux.

Run : `npm run typecheck`
Expected : aucune erreur.

- [ ] **Étape 7 : commit**

```bash
git add src/jobs/pipeline.ts src/app.ts test/integration/jira-pipeline.test.ts test/integration/pipeline.test.ts
git commit -m "feat(pipeline): charger av-tools en début de job Jira et en noter le SHA"
```

---

### Tâche 9 : doctor

**Files :**
- Modify: `src/cli/commands/doctor.ts` (`BuildChecksInput`, `buildChecks`, `doctorCommand`, nouvelle fonction `checkAvTools`)
- Test: `src/cli/commands/doctor.test.ts`

- [ ] **Étape 1 : les tests qui échouent**

Dans `src/cli/commands/doctor.test.ts`, ajouter `readFile` à l'import de `node:fs/promises`, et
`import { fileURLToPath } from 'node:url';`. Puis, à la fin du fichier :

```ts
describe('buildChecks — av-tools', () => {
  const AV = 'ILokYou/IA-Claude-Marketplace';
  const machine = machineWithJira('sdk');
  const fixture = () => readFile(fileURLToPath(new URL('../../../test/fixtures/av-tools/delivery-templates.yml', import.meta.url)), 'utf8');

  it('absent sans suivi Jira', () => {
    const names = buildChecks({ env: {}, machine: machineWith(['acme/one']), github: fakeGithub(async () => null) }).map((c) => c.name);
    expect(names).not.toContain('av-tools');
  });

  it("échoue quand l'app ne voit pas le dépôt, et dit où l'ajouter", async () => {
    const github = fakeGithub(async () => null, { appSlug: 'allo-sisyphe', repos: ['acme/one'] });
    const r = await run(buildChecks({ env: {}, machine, github }), 'av-tools');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('Repository access');
  });

  it('réussit sur une branche valide', async () => {
    const text = await fixture();
    const github = fakeGithub(async (repo, path, ref) => (repo.full === AV && ref === 'main' ? text : null), { appSlug: 'a', repos: ['acme/one', AV] });
    const r = await run(buildChecks({ env: {}, machine, github, avToolsPin: async () => 'b'.repeat(40) }), 'av-tools');
    expect(r).toEqual({ ok: true, detail: 'main valide, épingle bbbbbbb' });
  });

  it('avertit quand la branche est inutilisable mais qu’une épingle existe', async () => {
    const github = fakeGithub(async () => null, { appSlug: 'a', repos: [AV] });
    const check = buildChecks({ env: {}, machine, github, avToolsPin: async () => 'b'.repeat(40) }).find((c) => c.name === 'av-tools');
    expect(await check?.run()).toEqual({ warn: true, message: expect.stringContaining('absent sur main') });
  });

  it('échoue quand rien n’est valide, ni la branche ni une épingle', async () => {
    const github = fakeGithub(async () => 'schema_version: 2\n', { appSlug: 'a', repos: [AV] });
    const r = await run(buildChecks({ env: {}, machine, github }), 'av-tools');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('aucune version validée');
  });
});
```

- [ ] **Étape 2 : les voir échouer**

Run : `npx vitest run src/cli/commands/doctor.test.ts -t av-tools`
Expected : FAIL, `check absent : av-tools`.

- [ ] **Étape 3 : l'entrée**

Dans `src/cli/commands/doctor.ts`, compléter les imports :

```ts
import { parseDeliveryTemplates } from '../../avtools/templates.js';
import { loadMachineConfig, MachineConfigError, resolveAvTools, type AvToolsLocation, type MachineConfig } from '../../config/machine.js';
import { firstWord, runChecks, which, whichOrHint, withHint, type Check, type CheckWarnResult } from '../checks.js';
```

(en remplaçant les lignes d'import existantes de `../../config/machine.js` et `../checks.js`). Dans
`BuildChecksInput`, après `apiKeyChecks?: boolean;` :

```ts
  /** SHA épinglé d'av-tools sur cette machine ; absent quand on ne sait pas le lire (pas d'app initialisée). */
  avToolsPin?: () => Promise<string | null>;
```

- [ ] **Étape 4 : le check**

Avant `/** Construit la liste des checks, …`, ajouter :

```ts
/**
 * Ce que le prochain job trouvera dans av-tools. La lecture passe par l'API, pas par le miroir : doctor
 * n'écrit rien sur le disque. Si la branche est valide, le prochain job l'épinglera, donc pas de retard à
 * signaler. Si elle ne l'est pas, les jobs gardent l'épingle, et c'est ce retard qu'on signale.
 */
export async function checkAvTools(
  github: DoctorGitHub,
  loc: AvToolsLocation,
  pin?: () => Promise<string | null>,
): Promise<string | CheckWarnResult> {
  const access = await github.checkAccess();
  if (!access.repos.includes(loc.repo)) {
    throw new Error(`l'installation ${access.appSlug} n'a pas accès à ${loc.repo} : l'ajouter dans GitHub → Settings → Applications → ${access.appSlug} → Repository access`);
  }
  const pinned = pin ? await pin().catch(() => null) : null;
  const pinText = pinned ? `épingle ${pinned.slice(0, 7)}` : 'aucune épingle';
  const text = await github.getFileContent(parseRepo(loc.repo), loc.path, loc.branch);
  const parsed = text === null ? null : parseDeliveryTemplates(text);
  const problem = parsed === null ? `${loc.path} absent sur ${loc.branch}` : parsed.ok ? null : parsed.reason;
  if (!problem) return `${loc.branch} valide, ${pinText}`;
  if (pinned) return { warn: true, message: `${problem} — les jobs gardent la dernière version validée (${pinText})` };
  throw new Error(`${problem}, et aucune version validée`);
}
```

Dans `buildChecks`, juste avant le bloc du plugin agent (`if (input.machine?.jira && supportsSkills(backend)) {`) :

```ts
  // Les conventions de livraison ne servent que sous suivi Jira : av-tools ne parle que de tickets Jira.
  if (input.machine?.jira && input.github) {
    const github = input.github;
    const loc = resolveAvTools(input.machine);
    const pin = input.avToolsPin;
    checks.push({ name: 'av-tools', run: () => checkAvTools(github, loc, pin) });
  }
```

Dans `doctorCommand`, remplacer la ligne `const checks = buildChecks({ … });` par :

```ts
  const avTools = app?.deps.avTools;
  const checks = buildChecks({
    machine, github: app?.github, jira: app?.jira, env: process.env, paths, service,
    ...(avTools ? { avToolsPin: () => avTools.pinnedSha() } : {}),
  });
```

- [ ] **Étape 5 : vérifier**

Run : `npx vitest run src/cli/commands/doctor.test.ts`
Expected : PASS.

Run : `npm run typecheck`
Expected : aucune erreur.

- [ ] **Étape 6 : commit**

```bash
git add src/cli/commands/doctor.ts src/cli/commands/doctor.test.ts
git commit -m "feat(doctor): check av-tools — accès, validité de la branche, épingle"
```

---

### Tâche 10 : vérification d'ensemble

- [ ] **Étape 1 : toute la suite**

Run : `npm test`
Expected : tout passe. Le décompte doit être celui de départ plus les nouveaux tests. Si un test existant
échoue, le traiter avant d'aller plus loin : aucune tâche n'autorise à en assouplir un.

- [ ] **Étape 2 : typage et build**

Run : `npm run typecheck`
Expected : aucune erreur.

Run : `npm run build`
Expected : aucune erreur.

- [ ] **Étape 3 : essai réel, sur ce poste, en lecture seule**

Seulement une fois le prérequis fait, c'est-à-dire `IA-Claude-Marketplace` ajouté à l'app `allo-sisyphe`.
Tant que la #53 n'est pas fusionnée, mettre `avTools: { branch: feature/delivery-templates }` dans
`~/.sisyphe/config.yml`, après avoir demandé à Victor : c'est sa config. Le check ne s'affiche que si `jira`
est configuré, et ce poste n'en a pas. On vérifie donc seulement que doctor ne régresse pas :

Run : `npx tsx src/cli/index.ts doctor`
Expected : aucun check « av-tools » sur ce poste, et aucun nouvel échec. Le vrai contrôle se fait sur la
machine dédiée, qui a la section `jira`.

- [ ] **Étape 4 : rendre compte**

Rendre compte à Victor avec :
- les commits (`git log --oneline main..HEAD`) ;
- le résultat de la suite ;
- ce qui reste à faire sur la machine dédiée : ajouter le dépôt à l'app, `sisyphe doctor`, puis un job Jira
  réel dont `avToolsSha` est renseigné.

Ne pas pousser.
