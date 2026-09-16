import type { AdfNode } from './adf.js';

/**
 * Markdown → ADF, volontairement minimal.
 *
 * Ce qui passe par ici, ce sont les commentaires que Sisyphe poste sur un ticket : le `note` du triage, une
 * demande de précision, un échec. Ils sont lus par la personne qui a signalé le bug, pas par un développeur.
 * L'objectif est donc qu'ils soient **lisibles**, pas que le Markdown soit fidèlement rendu : on garde les
 * paragraphes, les sauts de ligne et les listes, et on laisse le reste en texte.
 *
 * Surtout, on n'enveloppe pas le message dans un bloc de code : ce serait fidèle et illisible.
 */

const text = (s: string): AdfNode => ({ type: 'text', text: s });

/** Une ligne de texte, ses retours internes rendus par des sauts durs plutôt que par des paragraphes vides. */
function inline(line: string): AdfNode[] {
  const parts = line.split('\n');
  const out: AdfNode[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push({ type: 'hardBreak' });
    if (p !== '') out.push(text(p));
  });
  return out.length > 0 ? out : [text('')];
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;

/** Un bloc séparé par une ligne vide devient un paragraphe, une liste à puces ou une liste numérotée. */
function block(lines: string[]): AdfNode | null {
  const kept = lines.filter((l) => l.trim() !== '');
  if (kept.length === 0) return null;

  const bullets = kept.map((l) => BULLET.exec(l));
  if (bullets.every(Boolean)) {
    return {
      type: 'bulletList',
      content: bullets.map((m) => ({ type: 'listItem', content: [{ type: 'paragraph', content: inline(m![1]) }] })),
    };
  }
  const ordered = kept.map((l) => ORDERED.exec(l));
  if (ordered.every(Boolean)) {
    return {
      type: 'orderedList',
      content: ordered.map((m) => ({ type: 'listItem', content: [{ type: 'paragraph', content: inline(m![1]) }] })),
    };
  }
  return { type: 'paragraph', content: inline(kept.join('\n')) };
}

export function markdownToAdf(markdown: string): AdfNode {
  const blocks = markdown
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((b) => block(b.split('\n')))
    .filter((b): b is AdfNode => b !== null);
  // Un document ADF vide est refusé par l'API : on garde au moins un paragraphe.
  return { type: 'doc', version: 1, content: blocks.length > 0 ? blocks : [{ type: 'paragraph', content: [text('')] }] } as AdfNode;
}
