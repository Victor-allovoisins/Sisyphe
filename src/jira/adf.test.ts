import { describe, expect, it } from 'vitest';
import { adfToMarkdown } from './adf.js';

const doc = (...content: unknown[]) => ({ type: 'doc', version: 1, content });
const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const txt = (text: string, marks?: unknown[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });

describe('adfToMarkdown', () => {
  it('rend les paragraphes séparés par une ligne vide', () => {
    expect(adfToMarkdown(doc(p(txt('Première.')), p(txt('Seconde.'))))).toBe('Première.\n\nSeconde.');
  });

  it('rend les marques de style et les liens', () => {
    const d = doc(p(txt('gras', [{ type: 'strong' }]), txt(' et '), txt('lien', [{ type: 'link', attrs: { href: 'https://x.test' } }])));
    expect(adfToMarkdown(d)).toBe('**gras** et [lien](https://x.test)');
  });

  it('rend le code en ligne et les blocs de code avec leur langage', () => {
    const d = doc(p(txt('appelle ', []), txt('foo()', [{ type: 'code' }])), { type: 'codeBlock', attrs: { language: 'swift' }, content: [txt('let x = 1')] });
    expect(adfToMarkdown(d)).toBe('appelle `foo()`\n\n```swift\nlet x = 1\n```');
  });

  it('rend les listes à puces et numérotées', () => {
    const item = (s: string) => ({ type: 'listItem', content: [p(txt(s))] });
    expect(adfToMarkdown(doc({ type: 'bulletList', content: [item('un'), item('deux')] }))).toBe('- un\n- deux');
    expect(adfToMarkdown(doc({ type: 'orderedList', content: [item('un'), item('deux')] }))).toBe('1. un\n2. deux');
  });

  it('indente une liste imbriquée sous sa puce', () => {
    const inner = { type: 'bulletList', content: [{ type: 'listItem', content: [p(txt('enfant'))] }] };
    const outer = { type: 'bulletList', content: [{ type: 'listItem', content: [p(txt('parent')), inner] }] };
    expect(adfToMarkdown(doc(outer))).toBe('- parent\n\n  - enfant');
  });

  it('rend les titres au bon niveau', () => {
    expect(adfToMarkdown(doc({ type: 'heading', attrs: { level: 2 }, content: [txt('Étapes')] }))).toBe('## Étapes');
  });

  it('signale une pièce jointe au lieu de la passer sous silence', () => {
    const d = doc({ type: 'mediaSingle', content: [{ type: 'media', attrs: { alt: 'capture.png', type: 'file' } }] });
    const out = adfToMarkdown(d);
    expect(out).toContain("non lisible par l'agent");
    expect(out).toContain('capture.png');
  });

  it('rend une mention en @nom, lisible par un humain comme par l’agent', () => {
    expect(adfToMarkdown(doc(p(txt('cc '), { type: 'mention', attrs: { id: '557058:x', text: '@Victor' } })))).toBe('cc @Victor');
  });

  it('rend un tableau ligne par ligne', () => {
    const cell = (s: string) => ({ type: 'tableCell', content: [p(txt(s))] });
    const d = doc({ type: 'table', content: [{ type: 'tableRow', content: [cell('a'), cell('b')] }] });
    expect(adfToMarkdown(d)).toBe('| a | b |');
  });

  it('garde le texte des nœuds inconnus au lieu de le perdre', () => {
    const d = doc({ type: 'panelDuFutur', content: [p(txt('information importante'))] });
    expect(adfToMarkdown(d)).toBe('information importante');
  });

  it('accepte une chaîne brute et le vide sans lever', () => {
    expect(adfToMarkdown('déjà du texte')).toBe('déjà du texte');
    expect(adfToMarkdown(null)).toBe('');
    expect(adfToMarkdown(undefined)).toBe('');
    expect(adfToMarkdown(doc())).toBe('');
  });

  it('normalise les fins de ligne et écrase les lignes vides en excès', () => {
    expect(adfToMarkdown('a\r\n\r\n\r\n\r\nb')).toBe('a\n\nb');
  });
});
