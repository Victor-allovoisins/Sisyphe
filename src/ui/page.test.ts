import { describe, expect, it } from 'vitest';
import { PAGE_HTML } from './page.js';

describe('PAGE_HTML', () => {
  it('est une page HTML complète et autonome', () => {
    expect(PAGE_HTML.startsWith('<!doctype html>')).toBe(true);
    expect(PAGE_HTML).toContain('<title>Sisyphe</title>');
    expect(PAGE_HTML).toContain('</html>');
    // Aucune ressource externe : la CSP `default-src 'self'` bloquerait tout CDN.
    expect(PAGE_HTML).not.toMatch(/(src|href)="https?:\/\//);
  });

  it("n'interpole aucune donnée côté serveur : la page est statique, les données viennent de l'API", () => {
    expect(PAGE_HTML).not.toContain('${');
  });

  it("n'injecte jamais de HTML : tout passe par createElement et textContent", () => {
    for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      expect(PAGE_HTML).not.toContain(forbidden);
    }
    expect(PAGE_HTML).toContain('textContent');
    expect(PAGE_HTML).toContain('createElement');
  });

  it('ne fabrique un lien que vers https://github.com/', () => {
    expect(PAGE_HTML).toContain("'https://github.com/'");
  });

  it('expose les trois onglets, le flux SSE et les routes JSON', () => {
    expect(PAGE_HTML).toContain('Tableau de bord');
    expect(PAGE_HTML).toContain('>Jobs<');
    expect(PAGE_HTML).toContain('>KPIs<');
    expect(PAGE_HTML).toContain("EventSource('/api/events')");
    expect(PAGE_HTML).toContain("'/api/jobs'");
    expect(PAGE_HTML).toContain("'/api/report?since='");
  });

  it('porte les couleurs d’état alignées sur les labels GitHub', () => {
    for (const cls of ['.s-run', '.s-done', '.s-blocked', '.s-failed', '.s-cancelled', '.s-queued']) {
      expect(PAGE_HTML).toContain(cls);
    }
  });
});
