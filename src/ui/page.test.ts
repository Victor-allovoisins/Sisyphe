import { describe, expect, it } from 'vitest';
import { PAGE_HTML } from './page.js';

const JIRA = { site: 'acme.atlassian.net', keys: { 'acme/demo': 'DEMO' } };

/** Corps d'une fonction du script embarqué, bornes comprises, par comptage d'accolades. */
function fnSource(name: string): string {
  const start = PAGE_HTML.indexOf('function ' + name + '(');
  if (start < 0) throw new Error(`fonction introuvable dans la page : ${name}`);
  let depth = 0;
  for (let i = PAGE_HTML.indexOf('{', start); i < PAGE_HTML.length; i++) {
    if (PAGE_HTML[i] === '{') depth++;
    else if (PAGE_HTML[i] === '}' && --depth === 0) return PAGE_HTML.slice(start, i + 1);
  }
  throw new Error(`fonction non terminée : ${name}`);
}

function constSource(name: string): string {
  const m = new RegExp('var ' + name + ' = .*;').exec(PAGE_HTML);
  if (!m) throw new Error(`constante introuvable dans la page : ${name}`);
  return m[0];
}

interface FakeNode { tag: string; text: string; href?: string; target?: string; rel?: string }

/**
 * Les gardes de lien sont le point sensible de la page : on les extrait du HTML et on les exécute
 * pour de vrai. Un test qui se contenterait de chercher `'https://github.com/'` dans la chaîne
 * resterait vert le jour où la validation du site Jira disparaîtrait.
 */
function guards(jira: unknown): {
  issueLink(repo: string, number: number, key?: string | null): FakeNode;
  deducedKey(repo: string, number: number): string | null;
} {
  const source = [
    ...['REPO_RE', 'JIRA_SITE_RE', 'JIRA_KEY_RE', 'JIRA_ISSUE_KEY_RE'].map(constSource),
    ...['safeLink', 'ghLink', 'jiraSite', 'jiraKey', 'deducedKey', 'issueLabel', 'issueLink'].map(fnSource),
    'return { issueLink: issueLink, deducedKey: deducedKey };',
  ].join('\n');
  const el = (tag: string, _cls: string | null, text: string): FakeNode => ({ tag, text });
  return Function('ui', 'el', source)({ jira }, el);
}

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

  it('ne fabrique un lien que vers GitHub ou le site Jira configuré', () => {
    expect(guards(null).issueLink('acme/demo', 42, null)).toMatchObject({ tag: 'a', text: 'acme/demo#42', href: 'https://github.com/acme/demo/issues/42', target: '_blank', rel: 'noopener noreferrer' });
    expect(guards(JIRA).issueLink('acme/demo', 42, 'DEMO-42')).toMatchObject({ tag: 'a', text: 'DEMO-42', href: 'https://acme.atlassian.net/browse/DEMO-42' });
    // Dépôt hors des projets Jira : la configuration peut être mixte, ses tickets restent sur GitHub.
    expect(guards(JIRA).issueLink('acme/other', 7, null).href).toBe('https://github.com/acme/other/issues/7');
  });

  it('le lien suit la clé du job, pas le projet Jira du dépôt', () => {
    // Un job antérieur à la bascule porte un numéro d’issue GitHub, sur un dépôt aujourd’hui sur Jira.
    expect(guards(JIRA).issueLink('acme/demo', 42, null)).toMatchObject({ text: 'acme/demo#42', href: 'https://github.com/acme/demo/issues/42' });
    // Et la clé vaut pour elle-même : le numéro du ticket n’a pas à suivre celui de l’issue.
    expect(guards(JIRA).issueLink('acme/demo', 42, 'DEMO-7').href).toBe('https://acme.atlassian.net/browse/DEMO-7');
  });

  it('ne suit pas un site Jira qui déplacerait l’origine du lien', () => {
    // Le site arrive par le snapshot : `@` ou `/` y suffirait à pointer ailleurs qu’Atlassian.
    for (const site of ['acme.atlassian.net@evil.example', 'evil.example', 'acme.atlassian.net/../evil']) {
      const link = guards({ site, keys: { 'acme/demo': 'DEMO' } }).issueLink('acme/demo', 42, 'DEMO-42');
      expect(link.href).toBe('https://github.com/acme/demo/issues/42');
    }
    // Même exigence sur la clé que porte le job, qui compose l’URL elle aussi.
    for (const key of ['../evil', 'DEMO-42/../..', 'demo-42', '@evil.example']) {
      expect(guards(JIRA).issueLink('acme/demo', 42, key).href).toBe('https://github.com/acme/demo/issues/42');
    }
    // Et sur la clé de projet, dont le journal d’actions se sert encore faute de mieux.
    expect(guards(JIRA).deducedKey('acme/demo', 42)).toBe('DEMO-42');
    expect(guards({ site: 'acme.atlassian.net', keys: { 'acme/demo': '../evil' } }).deducedKey('acme/demo', 42)).toBeNull();
  });

  it('expose les trois onglets, le flux SSE et les routes JSON', () => {
    expect(PAGE_HTML).toContain('Tableau de bord');
    expect(PAGE_HTML).toContain('>Jobs<');
    expect(PAGE_HTML).toContain('>KPIs<');
    expect(PAGE_HTML).toContain("EventSource('/api/events')");
    expect(PAGE_HTML).toContain("'/api/jobs'");
    expect(PAGE_HTML).toContain("'/api/report?since='");
  });

  it('expose un bloc Jira qui ne manipule que le chemin du jeton, jamais sa valeur', () => {
    expect(PAGE_HTML).toContain('id="set-jira-site"');
    expect(PAGE_HTML).toContain('id="set-jira-email"');
    expect(PAGE_HTML).toContain('id="set-jira-token"');
    expect(PAGE_HTML).toContain('Jeton API (chemin)');
    // Le compte se cherche côté serveur : aucun champ ne demande un accountId brut.
    expect(PAGE_HTML).toContain("api('jira-accounts'");
    expect(PAGE_HTML).not.toContain('placeholder="accountId"');
    // Le nom d'affichage reste côté page : le schéma du serveur est strict et refuserait la clé.
    expect(PAGE_HTML).toContain('function cleanJiraProject');
    expect(PAGE_HTML).not.toContain('accountDisplay:');
  });

  it('permet de retirer le suivi Jira, pas seulement de l’ajouter', () => {
    // Un null explicite : sans lui le serveur reporterait l'ancienne section, et le retrait serait impossible.
    expect(PAGE_HTML).toContain('config.jira = (site && email && token && settings.jira.projects.length)');
    expect(PAGE_HTML).toContain(': null;');
  });

  it('ajoute un quatrième onglet Réglages, avec son formulaire groupé', () => {
    expect(PAGE_HTML).toContain('data-tab="settings"');
    expect(PAGE_HTML).toContain('id="view-settings"');
    // Un champ par réglage modifiable, `dataDir` compris (verrouillé), et les trois groupes.
    for (const id of ['set-poll', 'set-concurrent', 'set-budget', 'set-backend', 'set-sandbox',
      'set-app-id', 'set-installation', 'set-label', 'set-key-path', 'set-data-dir']) {
      expect(PAGE_HTML).toContain(`id="${id}"`);
    }
    for (const title of ['Exécution', 'Agent', 'GitHub']) expect(PAGE_HTML).toContain(title);
    // `dataDir` : affiché désactivé, jamais reposté modifié (le serveur le refuse de toute façon).
    expect(PAGE_HTML).toContain('id="set-data-dir" disabled');
    // Le champ budget vide vaut « aucune limite ».
    expect(PAGE_HTML).toContain('placeholder="aucune limite"');
  });

  it('expose les quatre backends et les surcharges de modèle de l’onglet Réglages', () => {
    // Le select BACKEND vaut les valeurs canoniques ; l’ancienne `cli` a disparu de l’interface.
    for (const value of ['sdk', 'claude-code', 'codex', 'opencode']) {
      expect(PAGE_HTML).toContain(`<option value="${value}">${value}</option>`);
    }
    expect(PAGE_HTML).not.toContain('<option value="cli"');
    for (const id of ['set-model-triage', 'set-model-implement']) {
      expect(PAGE_HTML).toContain(`id="${id}"`);
    }
    // Les erreurs de validation `agentModels.*` atterrissent sous le bon champ.
    expect(PAGE_HTML).toContain("'agentModels.triage': 'set-model-triage'");
    expect(PAGE_HTML).toContain("'agentModels.implement': 'set-model-implement'");
    // L’aide rappelle que sdk/claude-code suivent les modèles du dépôt.
    expect(PAGE_HTML).toContain('sisyphe.yml');
  });

  it('n’envoie agentModels que si une surcharge de modèle est renseignée', () => {
    const start = PAGE_HTML.indexOf('function readSettingsConfig()');
    const end = PAGE_HTML.indexOf('\n  }', start);
    const body = PAGE_HTML.slice(start, end);
    expect(body).toContain('if (triage || implement)');
    expect(body).toContain('config.agentModels = {};');
    expect(body).toContain('config.agentModels.triage = triage;');
    expect(body).toContain('config.agentModels.implement = implement;');
    // Le remplissage repart de `config.agentModels`, vide quand il est absent.
    expect(PAGE_HTML).toContain('var models = config.agentModels || {};');
    expect(PAGE_HTML).toContain("setField('set-model-triage', models.triage);");
    expect(PAGE_HTML).toContain("setField('set-model-implement', models.implement);");
  });

  it('affiche les quatre blocs d’information et charge aux routes dédiées', () => {
    for (const id of ['diag-list', 'disk-list', 'env-list', 'repos-list']) {
      expect(PAGE_HTML).toContain(`id="${id}"`);
    }
    expect(PAGE_HTML).toContain("getJson('/api/settings')");
    expect(PAGE_HTML).toContain("getJson('/api/diagnostics' + (fresh ? '?fresh=1' : ''))");
    expect(PAGE_HTML).toContain("getJson('/api/disk')");
    expect(PAGE_HTML).toContain("api('settings', readSettingsConfig())");
    expect(PAGE_HTML).toContain("api('purge-cache', {})");
    // Le diagnostic n'est pas lancé au chargement de la page : les blocs se chargent au premier affichage de l'onglet.
    expect(PAGE_HTML).toContain("if (name === 'settings')");
    expect(PAGE_HTML).toContain('if (!blocks.diagnostics)');
  });

  it('ne peut enregistrer que si quelque chose a changé, et place les erreurs sous le champ fautif', () => {
    // La référence est la forme réémise par le formulaire, comparée champ à champ par JSON.
    expect(PAGE_HTML).toContain('settings.baseline = JSON.stringify(readSettingsConfig());');
    expect(PAGE_HTML).toContain('JSON.stringify(readSettingsConfig()) !== settings.baseline');
    expect(PAGE_HTML).toContain("byId('set-save').disabled = ui.readOnly || !changed;");
    // `issues` du serveur : chaque message va sous son champ, les autres dans l'encadré général.
    expect(PAGE_HTML).toContain('function showFieldErrors(issues, error)');
    expect(PAGE_HTML).toContain("input.parentNode.appendChild(el('p', 'field-error', issue.message));");
  });

  it('rappelle un redémarrage dû de façon persistante, depuis le statut du daemon', () => {
    // Le rappel ne vient pas de la réponse d'un enregistrement, qui disparaît au snapshot suivant.
    expect(PAGE_HTML).toContain('ui.pendingRestart = (o.daemon && o.daemon.pendingRestart) || [];');
    expect(PAGE_HTML).toContain('if (ui.reachable && pending.length) restartFields = pending;');
    expect(PAGE_HTML).toContain("el('button', 'action small danger', 'Redémarrer')");
    // Daemon arrêté : on propose Démarrer, jamais Redémarrer, et tout prendra effet au démarrage.
    expect(PAGE_HTML).toContain("el('button', 'action small primary', 'Démarrer')");
    expect(PAGE_HTML).toContain('Prendra effet au démarrage');
    // Redémarrer enchaîne arrêt puis démarrage.
    expect(PAGE_HTML).toContain('function restartDaemon(button)');
    expect(PAGE_HTML).toContain("api('stop', {}).then");
  });

  it('traduit les trois réponses d’enregistrement sans mentir sur l’état du daemon', () => {
    expect(PAGE_HTML).toContain('function afterSave(result)');
    expect(PAGE_HTML).toContain('result.reloaded');
    expect(PAGE_HTML).toContain('result.reloadError');
    expect(PAGE_HTML).toContain('result.needsRestart');
    expect(PAGE_HTML).toContain('effet au démarrage');
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

  it('désactive tout le formulaire et les actions de réglages en lecture seule', () => {
    expect(PAGE_HTML).toContain('function applySettingsReadOnly()');
    expect(PAGE_HTML).toContain('byId(id).disabled = disabled;');
    expect(PAGE_HTML).toContain("byId('set-save').hidden = disabled;");
    expect(PAGE_HTML).toContain("byId('purge-cache').hidden = disabled;");
    expect(PAGE_HTML).toContain("byId('set-repo-add').hidden = disabled;");
    // `dataDir` reste verrouillé même en écriture : il se change par `sisyphe setup`.
    expect(PAGE_HTML).toContain("byId('set-data-dir').disabled = true;");
    // Les surcharges de modèle sont désactivées comme le reste du formulaire en lecture seule.
    const start = PAGE_HTML.indexOf('function applySettingsReadOnly()');
    const list = PAGE_HTML.slice(start, PAGE_HTML.indexOf('].forEach', start));
    for (const id of ['set-model-triage', 'set-model-implement']) expect(list).toContain(`'${id}'`);
  });

  it('vide le cache de build après confirmation et montre l’espace disque', () => {
    expect(PAGE_HTML).toContain('Vider le cache de build');
    expect(PAGE_HTML).toContain('function purgeCache(button)');
    expect(PAGE_HTML).toContain('Vider le cache de build ? Il sera reconstruit au prochain build.');
    expect(PAGE_HTML).toContain('function fmtBytes(n)');
    expect(PAGE_HTML).toContain("byId('disk-total').textContent = 'Total : '");
  });

  it('borne chaque appel et la pile de toasts', () => {    expect(PAGE_HTML).toContain('new AbortController()');
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
