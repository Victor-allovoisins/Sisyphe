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

  it('affiche « aucune limite » quand le budget du jour n’a pas de plafond', () => {
    expect(PAGE_HTML).toContain("'aucune limite'");
  });

  it('porte les couleurs d’état alignées sur les labels GitHub', () => {
    for (const cls of ['.s-run', '.s-done', '.s-blocked', '.s-failed', '.s-cancelled', '.s-queued']) {
      expect(PAGE_HTML).toContain(cls);
    }
  });

  it('expose les boutons système, statiques et identifiés par leur action', () => {
    for (const name of ['start', 'pause', 'poll', 'stop', 'enqueue']) {
      expect(PAGE_HTML).toContain(`data-action="${name}"`);
    }
    for (const label of ['Démarrer', 'Arrêter', 'Pause', 'Reprendre', 'Poll maintenant']) {
      expect(PAGE_HTML).toContain(label);
    }
    // Daemon injoignable : les boutons de la socket sont grisés et disent pourquoi.
    expect(PAGE_HTML).toContain("'daemon arrêté'");
    expect(PAGE_HTML).toContain("button.setAttribute('title',");
    expect(PAGE_HTML).toContain('id="paused-banner"');
  });

  it('porte le formulaire « Nouveau job » : un vrai form, un select de repos, un numéro entier positif', () => {
    expect(PAGE_HTML).toContain('<form class="filters new-job" id="new-job"');
    expect(PAGE_HTML).toContain('Nouveau job');
    expect(PAGE_HTML).toContain('<select id="new-repo">');
    expect(PAGE_HTML).toContain('<input type="number" id="new-issue" min="1"');
    // `preventDefault` : la validation passe par `api()`, jamais par une navigation de formulaire.
    expect(PAGE_HTML).toContain("byId('new-job').addEventListener('submit'");
    expect(PAGE_HTML).toContain('event.preventDefault();');
  });

  it('construit les boutons Annuler et Relancer par job, avec leur attribut d’action', () => {
    expect(PAGE_HTML).toContain("setAttribute('data-action', kind)");
    expect(PAGE_HTML).toContain("jobButton(job, 'cancel'");
    expect(PAGE_HTML).toContain("jobButton(job, 'retry'");
    expect(PAGE_HTML).toContain('Annuler');
    expect(PAGE_HTML).toContain('Relancer');
    // Le clic ne doit pas remonter à la ligne du tableau, qui ouvrirait le panneau de détail.
    expect(PAGE_HTML).toContain('event.stopPropagation();');
  });

  it('appelle les actions avec les deux en-têtes anti-CSRF et sans cookie', () => {
    expect(PAGE_HTML).toContain("'/api/actions/' + name");
    expect(PAGE_HTML).toContain("method: 'POST'");
    expect(PAGE_HTML).toContain("'Content-Type': 'application/json'");
    expect(PAGE_HTML).toContain("'X-Sisyphe-Action': '1'");
    expect(PAGE_HTML).toContain("credentials: 'omit'");
  });

  it('confirme avant une action destructrice et désactive le bouton pendant l’appel', () => {
    expect(PAGE_HTML).toContain('window.confirm(question)');
    expect(PAGE_HTML).toContain('Annuler le job ');
    expect(PAGE_HTML).toContain('Relancer le job ');
    expect(PAGE_HTML).toContain('Arrêter le daemon ?');
    expect(PAGE_HTML).toContain('button.disabled = true;');
    expect(PAGE_HTML).toContain('button.disabled = false;');
  });

  it('affiche un toast par résultat et le journal des actions', () => {
    expect(PAGE_HTML).toContain('.toast.ok');
    expect(PAGE_HTML).toContain('.toast.ko');
    // Succès 4 s, erreur 8 s avec le message relayé.
    expect(PAGE_HTML).toContain("kind === 'ok' ? 4000 : 8000");
    expect(PAGE_HTML).toContain('Dernières actions');
    expect(PAGE_HTML).toContain('id="actions-body"');
  });

  it('ne montre aucun bouton ni formulaire en lecture seule', () => {
    // Défaut prudent : tant qu'aucun snapshot n'est arrivé, la page se croit en lecture seule.
    expect(PAGE_HTML).toContain('readOnly: true');
    expect(PAGE_HTML).toContain('if (ui.readOnly) return null;');
    expect(PAGE_HTML).toContain('bar.hidden = ui.readOnly;');
    expect(PAGE_HTML).toContain("byId('new-job').hidden = ui.readOnly;");
    expect(PAGE_HTML).toContain("byId('jobs-actions-head').hidden = ui.readOnly;");
    expect(PAGE_HTML).toContain('ui.readOnly = o.readOnly !== false;');
    // La barre et le formulaire sont en `display: flex` : sans cette règle, `hidden` ne les masquerait pas.
    expect(PAGE_HTML).toContain('[hidden] { display: none !important; }');
  });

  it('embarque un script qui parse : une coquille dans le gabarit blanchirait la page en silence', () => {
    // `tsc` ne regarde pas l'intérieur du littéral et aucun autre test ne le lit comme du code : sans
    // cette compilation (sans exécution : le script touche `document`), une erreur de syntaxe passerait.
    const open = PAGE_HTML.indexOf('<script>') + '<script>'.length;
    const close = PAGE_HTML.indexOf('</script>');
    const body = PAGE_HTML.slice(open, close);
    expect(body.length).toBeGreaterThan(1000);
    expect(() => new Function(body)).not.toThrow();
  });

  it('garde l’en-tête du tableau Jobs et le colSpan des lignes vides en phase', () => {
    const start = PAGE_HTML.indexOf('<th>État</th>');
    const head = PAGE_HTML.slice(start, PAGE_HTML.indexOf('</tr></thead>', start));
    const columns = head.split('<th').length - 1;
    expect(columns).toBe(9);
    // La dernière colonne est masquée en lecture seule : les lignes vides doivent alors en compter une de moins.
    expect(head).toContain('id="jobs-actions-head" hidden');
    expect(PAGE_HTML).toContain('return ui.readOnly ? ' + (columns - 1) + ' : ' + columns + ';');
  });

  it('ne câble que de vrais boutons et un vrai formulaire : tout est atteignable au clavier', () => {
    // Aucun `div` cliquable : chaque action est un <button> ou le submit du formulaire.
    expect(PAGE_HTML).not.toMatch(/<div[^>]*onclick/i);
    expect(PAGE_HTML).not.toContain("el('div', 'action'");
    expect(PAGE_HTML).toContain("button.type = 'button';");
    // Une ligne de tableau qui contient un vrai bouton ne peut pas se déclarer bouton elle-même.
    expect(PAGE_HTML).not.toContain("'role', 'button'");
    expect(PAGE_HTML).toContain("tr.setAttribute('tabindex', '0');");
  });

  it('rend le focus après une action et ne reconstruit pas le journal à chaque snapshot', () => {
    expect(PAGE_HTML).toContain('function focusJobButton(jobId)');
    expect(PAGE_HTML).toContain('buttons[i].focus();');
    // Le panneau est mis à jour sur place : le reconstruire remonterait le défilement et perdrait le focus.
    expect(PAGE_HTML).toContain('function refreshDetail()');
    expect(PAGE_HTML).toContain('detailHead.node.insertBefore(detailHead.action, detailHead.close);');
    // Journal : rien n'est refait tant que la signature des lignes n'a pas bougé.
    expect(PAGE_HTML).toContain('if (key === lastActionsKey) return;');
  });

  it('dit la vérité juste après une action, sans attendre le snapshot suivant', () => {
    expect(PAGE_HTML).toContain('function applyLocalEffect(name)');
    expect(PAGE_HTML).toContain("if (name === 'pause') ui.paused = true;");
    expect(PAGE_HTML).toContain("else if (name === 'resume') ui.paused = false;");
    expect(PAGE_HTML).toContain('applyLocalEffect(name);');
    // Prologue du daemon : le service tourne, la socket ne répond pas encore, Démarrer reste visible.
    expect(PAGE_HTML).toContain('var starting = ui.serviceRunning && !ui.reachable;');
    expect(PAGE_HTML).toContain('start.hidden = ui.reachable;');
    expect(PAGE_HTML).toContain('démarrage en cours…');
  });

  it('borne chaque appel et la pile de toasts', () => {
    expect(PAGE_HTML).toContain('new AbortController()');
    expect(PAGE_HTML).toContain('signal: controller.signal');
    expect(PAGE_HTML).toContain("err.name === 'AbortError'");
    expect(PAGE_HTML).toContain('clearTimeout(timer);');
    expect(PAGE_HTML).toContain('while (box.children.length > MAX_TOASTS) box.removeChild(box.firstChild);');
    // La pile défile au lieu de pousser les plus anciens hors de l'écran.
    expect(PAGE_HTML).toContain('max-height: calc(100vh - 40px); overflow-y: auto;');
  });

  it('coupe les titres d’issue, qui sont des données tierces', () => {
    for (const rule of ['.card-title', '.detail-title']) {
      const line = PAGE_HTML.split('\n').find((l) => l.trim().startsWith(rule + ' {'));
      expect(line, rule).toBeDefined();
      expect(line).toContain('overflow-wrap: anywhere');
    }
  });
});
