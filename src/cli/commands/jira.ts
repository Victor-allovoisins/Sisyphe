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
  // Non générique : un `<T>` laisse l'appelant prétendre connaître la forme de la réponse, alors que
  // `get` sert justement à lire ce que les verbes fixes ne modélisent pas. `JiraIssueTracker.get<T = unknown>`
  // reste compatible (instancié en `unknown`), et `JSON.stringify` n'a pas besoin de mieux que `unknown`.
  get(path: string): Promise<unknown>;
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

/**
 * Lit stdin en entier. Sans redirection, itérer sur `process.stdin` ne se termine jamais : un humain qui tape
 * `sisyphe jira comment IOS-886` dans un terminal resterait bloqué sans indication. L'agent, lui, redirige
 * toujours, donc ne voit jamais cette garde.
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error(
      "Aucune entrée standard à lire (terminal interactif) : rediriger le corps du commentaire, par exemple `sisyphe jira comment IOS-886 < corps.md` ou `sisyphe jira comment IOS-886 <<'EOF'`.",
    );
  }
  process.stdin.setEncoding('utf8');
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

/**
 * Analyse pure des arguments de la commande, séparée de `jiraCommand` pour être testable sans passer par
 * `createApp` ni par stdin : le corps d'un `comment` est fourni par l'appelant (déjà lu), pas lu ici.
 */
export function parseJiraArgv(argv: string[], opts: { body?: string } = {}): JiraVerb {
  const [verb, ...rest] = argv;
  switch (verb) {
    case 'show':
    case 'transitions':
      return { verb, key: required(rest[0], 'clé de ticket') };
    case 'transition':
      return { verb, key: required(rest[0], 'clé de ticket'), target: required(rest[1], 'statut cible') };
    case 'comment':
      return { verb, key: required(rest[0], 'clé de ticket'), body: opts.body ?? '' };
    case 'assign':
      return { verb, key: required(rest[0], 'clé de ticket'), to: assignTarget(rest) };
    case 'get':
      return { verb, path: required(rest[0], 'chemin API') };
    default:
      throw new Error(`Verbe inconnu : ${verb ?? '(aucun)'} (attendu show, transitions, transition, comment, assign, get)`);
  }
}

/**
 * `assign` sans drapeau ne doit pas se résoudre en silence vers l'un des deux choix : rendre le ticket est
 * l'action la moins réversible (voir `removeTriggerLabel`), elle ne doit jamais arriver par oubli de drapeau.
 */
function assignTarget(rest: string[]): 'back' | 'bot' {
  const back = rest.includes('--back');
  const bot = rest.includes('--bot');
  if (back === bot) {
    throw new Error('assign : préciser --back (rendre le ticket) ou --bot (l’assigner à Sisyphe) — exactement un des deux.');
  }
  return bot ? 'bot' : 'back';
}

/** Point d'entrée CLI : construit le vrai client, exécute, imprime. Le jeton ne quitte jamais `~/.sisyphe`. */
export async function jiraCommand(argv: string[]): Promise<void> {
  const app = await createApp({ needsAgent: false });
  if (!app.jira) throw new Error('Aucune section `jira` dans la configuration machine : commande indisponible.');
  const body = argv[0] === 'comment' ? await readStdin() : undefined;
  console.log(await runJiraVerb(app.jira, parseJiraArgv(argv, { body })));
}

function required(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Argument manquant : ${what}.`);
  return value;
}
