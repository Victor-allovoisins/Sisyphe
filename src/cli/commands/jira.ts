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
