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
