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
