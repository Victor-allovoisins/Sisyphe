/**
 * ADF (Atlassian Document Format) → Markdown.
 *
 * Jira Cloud rend les descriptions et commentaires en JSON, pas en texte. Ce qui en sort part directement
 * dans le prompt de triage : on vise donc la fidélité du *contenu*, pas celle de la mise en forme. Tout nœud
 * inconnu est parcouru pour son texte plutôt qu'ignoré — perdre une phrase coûte plus cher qu'un style raté.
 *
 * Les pièces jointes, elles, n'ont pas d'équivalent textuel : elles deviennent un marqueur explicite, pour que
 * l'agent sache qu'il existe une image qu'il ne verra jamais plutôt que de croire le ticket complet.
 */

export interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  attrs?: Record<string, unknown>;
}

const attrText = (n: AdfNode, ...keys: string[]): string => {
  for (const k of keys) {
    const v = n.attrs?.[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
};

function applyMarks(text: string, marks: AdfNode['marks']): string {
  let out = text;
  for (const m of marks ?? []) {
    if (m.type === 'code') out = `\`${out}\``;
    else if (m.type === 'strong') out = `**${out}**`;
    else if (m.type === 'em') out = `*${out}*`;
    else if (m.type === 'strike') out = `~~${out}~~`;
    else if (m.type === 'link') {
      const href = typeof m.attrs?.href === 'string' ? m.attrs.href : '';
      if (href) out = `[${out}](${href})`;
    }
  }
  return out;
}

/** Contenu d'un nœud, concaténé. `sep` sert aux blocs, qui se séparent par des lignes vides. */
function children(n: AdfNode, sep: string, depth: number): string {
  return (n.content ?? []).map((c) => render(c, depth)).filter((s) => s !== '').join(sep);
}

function renderList(n: AdfNode, depth: number, marker: (i: number) => string): string {
  return (n.content ?? [])
    .map((item, i) => {
      const body = children(item, '\n\n', depth + 1);
      const [first = '', ...rest] = body.split('\n');
      // Une seule source d'indentation : les lignes suivantes d'un même point sont décalées sous sa puce,
      // et une liste imbriquée en hérite en tant que ligne suivante. Ajouter en plus un retrait par niveau
      // le compterait deux fois.
      return [`${marker(i)} ${first}`, ...rest.map((l) => (l ? `  ${l}` : l))].join('\n');
    })
    .join('\n');
}

function render(n: AdfNode, depth = 0): string {
  switch (n.type) {
    case 'text':
      return applyMarks(n.text ?? '', n.marks);
    case 'hardBreak':
      return '\n';
    case 'paragraph':
      return children(n, '', depth);
    case 'heading': {
      const level = typeof n.attrs?.level === 'number' ? Math.min(6, Math.max(1, n.attrs.level)) : 1;
      return `${'#'.repeat(level)} ${children(n, '', depth)}`;
    }
    case 'bulletList':
      return renderList(n, depth, () => '-');
    case 'orderedList':
      return renderList(n, depth, (i) => `${i + 1}.`);
    case 'listItem':
      return children(n, '\n\n', depth);
    case 'codeBlock': {
      const lang = attrText(n, 'language');
      return `\`\`\`${lang}\n${children(n, '', depth)}\n\`\`\``;
    }
    case 'blockquote':
      return children(n, '\n\n', depth)
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    case 'rule':
      return '---';
    case 'mention':
      return `@${attrText(n, 'text', 'id').replace(/^@/, '')}`;
    case 'emoji':
      return attrText(n, 'text', 'shortName');
    case 'date': {
      const ts = Number(attrText(n, 'timestamp'));
      return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString().slice(0, 10) : '';
    }
    case 'inlineCard':
    case 'blockCard':
      return attrText(n, 'url');
    case 'media':
    case 'mediaSingle':
    case 'mediaGroup':
    case 'mediaInline': {
      // Volontairement bruyant : c'est la seule trace qu'un contenu visuel existe et qu'il est hors de portée.
      const name = attrText(n, 'alt') || (n.content ?? []).map((c) => attrText(c, 'alt')).find(Boolean) || '';
      return `[pièce jointe non lisible par l'agent${name ? ` : ${name}` : ''}]`;
    }
    case 'table':
      return children(n, '\n', depth);
    case 'tableRow':
      return `| ${(n.content ?? []).map((c) => render(c, depth).replace(/\n+/g, ' ').trim()).join(' | ')} |`;
    case 'tableCell':
    case 'tableHeader':
      return children(n, ' ', depth);
    case 'doc':
      return children(n, '\n\n', depth);
    default:
      // Nœud inconnu ou futur : on garde le texte qu'il contient plutôt que de le perdre.
      return children(n, '\n\n', depth);
  }
}

/** Même sortie quelle que soit l'entrée : fins de ligne unifiées, pas d'espace en fin de ligne, pas de trou. */
function normalize(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convertit un document ADF en Markdown. Accepte aussi une chaîne (certains champs Jira restent en texte
 * brut selon l'API et la version) et `null`, auquel cas le résultat est une chaîne vide — jamais `null`,
 * parce que `Issue.body` ne l'admet pas.
 */
export function adfToMarkdown(doc: unknown): string {
  if (doc == null) return '';
  if (typeof doc !== 'object') return normalize(String(doc));
  return normalize(render(doc as AdfNode));
}
