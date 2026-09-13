/**
 * Page unique de l'UI locale : HTML, CSS et JS vanilla, aucune dépendance, aucun build front.
 *
 * Deux règles tiennent la sécurité de ce fichier et sont vérifiées par `page.test.ts` :
 * 1. la chaîne est **statique** — aucune interpolation côté serveur (aucun `${`), les données
 *    arrivent uniquement par l'API JSON ;
 * 2. le script ne construit jamais de HTML : `createElement` + `textContent` exclusivement, et un
 *    lien n'est fabriqué qu'après vérification du préfixe `https://github.com/`.
 *
 * Corollaire de (1) : le JS embarqué n'utilise ni littéral de gabarit ni `${}` — les chaînes sont
 * concaténées avec `+`.
 */
export const PAGE_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sisyphe</title>
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --panel-2: #1c2128;
    --border: #30363d;
    --text: #e6edf3;
    --muted: #8b949e;
    --run: #388bfd;
    --done: #3fb950;
    --blocked: #d29922;
    --failed: #f85149;
    --cancelled: #6e7681;
    --queued: #484f58;
  }
  * { box-sizing: border-box; }
  /* Le display d'une classe l'emporte sur celui de la feuille par défaut : sans cette règle, une
     barre ou un formulaire en display:flex resterait visible malgré l'attribut hidden. */
  [hidden] { display: none !important; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .top {
    display: flex; align-items: center; gap: 24px;
    padding: 14px 24px; border-bottom: 1px solid var(--border); background: var(--panel);
    position: sticky; top: 0; z-index: 5;
  }
  .brand { font-size: 20px; font-weight: 700; letter-spacing: 0.5px; }
  .tabs { display: flex; gap: 6px; }
  .tab {
    background: transparent; color: var(--muted); border: 1px solid transparent; border-radius: 8px;
    padding: 8px 16px; font-size: 15px; cursor: pointer; font-family: inherit;
  }
  .tab:hover { color: var(--text); background: var(--panel-2); }
  .tab.is-active { color: var(--text); background: var(--panel-2); border-color: var(--border); }
  .conn { margin-left: auto; color: var(--muted); font-size: 13px; display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--cancelled); display: inline-block; }
  .dot.live { background: var(--done); }
  .dot.lost { background: var(--failed); }
  main { padding: 24px; max-width: 1500px; margin: 0 auto; }
  .view[hidden] { display: none; }
  h2.section-title { font-size: 14px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); margin: 32px 0 12px; }
  .band { display: flex; flex-wrap: wrap; gap: 14px; }
  .stat {
    background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px 18px; min-width: 150px; flex: 1 1 150px;
  }
  .stat .label { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
  .stat .value { font-size: 34px; font-weight: 650; line-height: 1.15; margin-top: 4px; }
  .stat .hint { font-size: 12px; color: var(--muted); margin-top: 4px; overflow-wrap: anywhere; }
  .value.ok { color: var(--done); }
  .value.ko { color: var(--failed); }
  .value.warn { color: var(--blocked); }
  .budget { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin-top: 14px; }
  .budget-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
  .budget-figure { font-size: 34px; font-weight: 650; }
  .bar { height: 14px; border-radius: 7px; background: var(--panel-2); margin-top: 12px; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--run); width: 0; transition: width 0.4s ease; }
  .bar-fill.warn { background: var(--blocked); }
  .bar-fill.over { background: var(--failed); }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(430px, 1fr)); gap: 16px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
  .card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .card-title { font-size: 17px; font-weight: 600; margin: 8px 0 2px; }
  .card-meta { display: flex; gap: 18px; flex-wrap: wrap; margin: 10px 0; }
  .card-meta .m-value { font-size: 26px; font-weight: 650; }
  .card-meta .m-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
  .feed {
    background: #010409; border: 1px solid var(--border); border-radius: 8px; margin: 0;
    padding: 10px 12px; height: 190px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
    font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: #c9d1d9;
  }
  .badge {
    display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
    border: 1px solid transparent; white-space: nowrap;
  }
  .s-run { background: rgba(56, 139, 253, 0.18); color: #79c0ff; border-color: rgba(56, 139, 253, 0.45); }
  .s-done { background: rgba(63, 185, 80, 0.18); color: #56d364; border-color: rgba(63, 185, 80, 0.45); }
  .s-blocked { background: rgba(210, 153, 34, 0.18); color: #e3b341; border-color: rgba(210, 153, 34, 0.45); }
  .s-failed { background: rgba(248, 81, 73, 0.18); color: #ff7b72; border-color: rgba(248, 81, 73, 0.45); }
  .s-cancelled { background: rgba(110, 118, 129, 0.18); color: #adbac7; border-color: rgba(110, 118, 129, 0.45); }
  .s-queued { background: rgba(72, 79, 88, 0.25); color: var(--muted); border-color: var(--border); }
  .filters { display: flex; gap: 16px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 16px; }
  .filters label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
  select, input[type="number"], button.action {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 8px; padding: 8px 12px; font-size: 14px; font-family: inherit;
  }
  button.action { cursor: pointer; }
  button.action:hover { border-color: var(--muted); }
  button.action:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid #58a6ff; outline-offset: 1px; }
  button.action[disabled] { opacity: 0.45; cursor: not-allowed; }
  button.action[disabled]:hover { border-color: var(--border); }
  /* Barre système : construite une seule fois, jamais reconstruite par le snapshot SSE (qui tombe toutes les 2 s). */
  .sysbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 16px; }
  .sysbar .spacer { flex: 1 1 auto; }
  .sysbar .hint { font-size: 12px; color: var(--muted); }
  button.primary { border-color: rgba(63, 185, 80, 0.55); color: #56d364; }
  button.danger { border-color: rgba(248, 81, 73, 0.45); color: #ff7b72; }
  .banner {
    border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; font-size: 14px; font-weight: 600;
    border: 1px solid rgba(210, 153, 34, 0.5); background: rgba(210, 153, 34, 0.12); color: #e3b341;
  }
  .new-job { align-items: flex-end; }
  .new-job input[type="number"] { width: 130px; }
  .form-title { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); padding-bottom: 10px; }
  .row-actions { display: flex; gap: 6px; white-space: nowrap; }
  button.action.small { padding: 4px 10px; font-size: 12px; }
  .card-actions { display: flex; gap: 8px; margin-top: 12px; }
  .a-ok { color: var(--done); }
  .a-ko { color: var(--failed); }
  .toasts { position: fixed; right: 20px; bottom: 20px; z-index: 12; display: flex; flex-direction: column; gap: 10px; align-items: flex-end; }
  .toast {
    max-width: 520px; border-radius: 10px; padding: 11px 16px; font-size: 14px; overflow-wrap: anywhere;
    box-shadow: 0 8px 24px rgba(1, 4, 9, 0.55); border: 1px solid var(--border); background: var(--panel-2);
  }
  .toast.ok { border-color: rgba(63, 185, 80, 0.55); background: rgba(63, 185, 80, 0.16); color: #7ee787; }
  .toast.ko { border-color: rgba(248, 81, 73, 0.55); background: rgba(248, 81, 73, 0.16); color: #ff9b95; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 11px 14px; border-bottom: 1px solid var(--border); font-size: 14px; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); background: var(--panel-2); }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr.row { cursor: pointer; }
  tbody tr.row:hover { background: var(--panel-2); }
  tbody tr.row:focus { outline: 2px solid #58a6ff; outline-offset: -2px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .title-cell { max-width: 460px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); padding: 18px 0; }
  .kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
  .kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px; }
  .kpi .label { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
  .kpi .value { font-size: 42px; font-weight: 650; line-height: 1.1; margin-top: 6px; }
  .kpi .hint { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .chart { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin-top: 20px; }
  .chart-svg { width: 100%; height: auto; display: block; max-height: 340px; }
  .legend { display: flex; gap: 18px; color: var(--muted); font-size: 12px; margin-bottom: 10px; }
  .legend .key { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
  .overlay { position: fixed; inset: 0; background: rgba(1, 4, 9, 0.6); z-index: 8; }
  .detail {
    position: fixed; top: 0; right: 0; bottom: 0; width: min(880px, 94vw); z-index: 9;
    background: var(--panel); border-left: 1px solid var(--border); overflow: auto; padding: 22px 26px;
  }
  .detail h3 { margin: 26px 0 10px; font-size: 13px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); }
  .detail-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .detail-title { font-size: 20px; font-weight: 650; margin: 12px 0 0; }
  .close { margin-left: auto; }
  pre.block {
    background: #010409; border: 1px solid var(--border); border-radius: 8px; padding: 12px;
    max-height: 340px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 0;
    font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; color: #c9d1d9;
  }
  .error-box { border: 1px solid rgba(248, 81, 73, 0.5); background: rgba(248, 81, 73, 0.1); color: #ff9b95; border-radius: 8px; padding: 12px; }
  ul.plain { list-style: none; margin: 0; padding: 0; }
  ul.plain li { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  ul.plain li:last-child { border-bottom: none; }
</style>
</head>
<body>
<header class="top">
  <div class="brand">Sisyphe</div>
  <nav class="tabs">
    <button type="button" class="tab is-active" data-tab="dash">Tableau de bord</button>
    <button type="button" class="tab" data-tab="jobs">Jobs</button>
    <button type="button" class="tab" data-tab="kpis">KPIs</button>
  </nav>
  <div class="conn"><span class="dot" id="conn-dot"></span><span id="conn-text">connexion…</span></div>
</header>
<main>
  <section class="view" id="view-dash">
    <div class="sysbar" id="sysbar" hidden>
      <button type="button" class="action primary" id="act-start" data-action="start">Démarrer</button>
      <button type="button" class="action" id="act-pause" data-action="pause">Pause</button>
      <button type="button" class="action" id="act-poll" data-action="poll">Poll maintenant</button>
      <button type="button" class="action danger" id="act-stop" data-action="stop">Arrêter</button>
      <span class="spacer"></span>
      <span class="hint" id="sysbar-hint"></span>
    </div>
    <p class="banner" id="paused-banner" hidden>En pause : les jobs en file ne démarrent plus. Reprendre pour les relancer.</p>
    <div class="band" id="system"></div>
    <div class="budget" id="budget"></div>
    <h2 class="section-title">Jobs actifs</h2>
    <div class="cards" id="active"></div>
    <p class="empty" id="active-empty" hidden>Aucun job actif. Le daemon attend une issue étiquetée.</p>
    <h2 class="section-title">Dernières actions</h2>
    <table>
      <thead><tr><th>Heure</th><th>Action</th><th>Cible</th><th>Résultat</th></tr></thead>
      <tbody id="actions-body"></tbody>
    </table>
  </section>

  <section class="view" id="view-jobs" hidden>
    <form class="filters new-job" id="new-job" aria-label="Nouveau job" hidden>
      <span class="form-title">Nouveau job</span>
      <label>Repo<select id="new-repo"></select></label>
      <label>Issue<input type="number" id="new-issue" min="1" step="1" placeholder="numéro" required></label>
      <button type="submit" class="action primary" id="act-enqueue" data-action="enqueue">Créer</button>
    </form>
    <div class="filters">
      <label>Repo<select id="filter-repo"></select></label>
      <label>État<select id="filter-state"></select></label>
      <button type="button" class="action" id="refresh">Actualiser</button>
    </div>
    <table>
      <thead><tr>
        <th>État</th><th>Issue</th><th>Titre</th><th class="num">Coût</th><th class="num">Durée</th>
        <th class="num">Essais</th><th>PR</th><th>Créé</th><th id="jobs-actions-head" hidden>Actions</th>
      </tr></thead>
      <tbody id="jobs-body"></tbody>
    </table>
  </section>

  <section class="view" id="view-kpis" hidden>
    <div class="filters">
      <label>Période<select id="period">
        <option value="7d">7 jours</option>
        <option value="30d" selected>30 jours</option>
        <option value="90d">90 jours</option>
      </select></label>
    </div>
    <div class="kpis" id="kpis"></div>
    <div class="chart" id="chart"></div>
  </section>
</main>
<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
<script>
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var STATES = ['queued', 'triaging', 'implementing', 'verifying', 'delivering', 'done', 'blocked', 'failed', 'cancelled'];
  var STATE_LABEL = {
    queued: 'en file', triaging: 'triage', implementing: 'implémentation', verifying: 'vérification',
    delivering: 'livraison', done: 'terminé', blocked: 'bloqué', failed: 'échec', cancelled: 'annulé'
  };
  var STATE_CLASS = {
    queued: 's-queued', triaging: 's-run', implementing: 's-run', verifying: 's-run', delivering: 's-run',
    done: 's-done', blocked: 's-blocked', failed: 's-failed', cancelled: 's-cancelled'
  };
  var REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\\/[A-Za-z0-9._-]+$/;
  /** États sur lesquels Relancer a un sens ; partout ailleurs c'est Annuler, ou rien pour un job terminé. */
  var RETRYABLE = { failed: true, blocked: true, cancelled: true };
  var TERMINAL = { done: true, blocked: true, failed: true, cancelled: true };
  var ACTION_LABEL = {
    cancel: 'annulation', retry: 'relance', enqueue: 'nouveau job', poll: 'poll',
    pause: 'pause', resume: 'reprise', stop: 'arrêt', start: 'démarrage'
  };
  /**
   * Dernier instantané utile hors du tableau de bord : la liste des jobs et le panneau de détail sont
   * chargés par des routes qui ne portent pas ces champs. readOnly vaut vrai tant qu'aucun snapshot
   * n'est arrivé — une instance --read-only ne doit jamais laisser clignoter un bouton.
   */
  var ui = { readOnly: true, reachable: false, paused: null, serviceRunning: false, repos: [] };

  function byId(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function fmtUsd(n) {
    var v = Number(n);
    return '$' + (isFinite(v) ? v : 0).toFixed(2);
  }

  function fmtDuration(ms) {
    var v = Number(ms);
    if (!isFinite(v) || v < 0) return '—';
    if (v < 1000) return Math.round(v) + ' ms';
    var s = Math.round(v / 1000);
    if (s < 60) return s + ' s';
    var m = Math.floor(s / 60);
    if (m < 60) return (s % 60) ? m + ' min ' + (s % 60) + ' s' : m + ' min';
    var h = Math.floor(m / 60);
    return (m % 60) ? h + ' h ' + (m % 60) + ' min' : h + ' h';
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  /** Un lien n'existe que si l'URL vient bien de GitHub ; sinon le texte reste du texte. */
  function ghLink(url, label) {
    if (typeof url !== 'string' || url.indexOf('https://github.com/') !== 0) return el('span', 'muted', label);
    var a = el('a', null, label);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  function issueLink(repo, number) {
    var label = String(repo) + '#' + String(number);
    if (!REPO_RE.test(String(repo)) || !isFinite(Number(number))) return el('span', 'muted', label);
    return ghLink('https://github.com/' + repo + '/issues/' + Number(number), label);
  }

  function badge(state) {
    return el('span', 'badge ' + (STATE_CLASS[state] || 's-queued'), STATE_LABEL[state] || String(state));
  }

  function stat(label, value, tone, hint) {
    var box = el('div', 'stat');
    box.appendChild(el('div', 'label', label));
    box.appendChild(el('div', 'value' + (tone ? ' ' + tone : ''), value));
    if (hint) box.appendChild(el('div', 'hint', hint));
    return box;
  }

  function makeMetric(label, value) {
    var box = el('div');
    var valueNode = el('div', 'm-value', value);
    box.appendChild(valueNode);
    box.appendChild(el('div', 'm-label', label));
    return { box: box, value: valueNode };
  }

  function metric(label, value) {
    return makeMetric(label, value).box;
  }

  function getJson(path) {
    return fetch(path, { headers: { accept: 'application/json' } }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + res.status);
        return body;
      });
    });
  }

  // ---------- Actions ----------

  /**
   * Un appel d'action. Les deux en-têtes sont exigés par le serveur : un formulaire HTML d'un autre site
   * ne peut poser ni l'un ni l'autre sans CORS préalable. credentials: 'omit' parce que la page n'a ni
   * session ni cookie et n'a aucune raison d'en envoyer. Ne rejette jamais : panne réseau comprise, le
   * résultat est toujours un objet, de sorte qu'aucun appelant n'a de bouton laissé désactivé.
   */
  function api(name, body) {
    return fetch('/api/actions/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sisyphe-Action': '1' },
      credentials: 'omit',
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().then(function (parsed) { return parsed; }, function () { return null; }).then(function (parsed) {
        if (res.ok && parsed && parsed.ok === true) return { ok: true, result: parsed.result };
        var message = parsed && parsed.error ? String(parsed.error) : 'HTTP ' + res.status;
        return { ok: false, error: message };
      });
    }, function (err) {
      return { ok: false, error: err && err.message ? String(err.message) : 'daemon injoignable' };
    });
  }

  function toast(kind, text) {
    var box = byId('toasts');
    var node = el('div', 'toast ' + kind, text);
    box.appendChild(node);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, kind === 'ok' ? 4000 : 8000);
  }

  /**
   * Appels en vol. La barre système est resynchronisée à chaque snapshot SSE (toutes les 2 s) : sans ce
   * compteur, elle réactiverait un bouton pendant que son action tourne encore.
   */
  var busy = 0;

  /** Vue à recharger après un succès, en plus du snapshot SSE qui rafraîchit le tableau de bord. */
  function afterAction() {
    if (!byId('view-jobs').hidden) loadJobs();
    if (detailJobId) openDetail(detailJobId);
  }

  /**
   * Déclenche une action : confirmation éventuelle, bouton désactivé pendant l'appel, toast du résultat.
   * Le bouton est rendu même si la vue a été reconstruite entre-temps (le nœud est alors détaché, sans effet).
   */
  function run(button, name, body, question, onOk) {
    if (question && !window.confirm(question)) return;
    busy++;
    button.disabled = true;
    api(name, body).then(function (r) {
      busy--;
      button.disabled = false;
      if (r.ok) {
        toast('ok', ACTION_LABEL[name] + ' : c\\'est fait');
        if (onOk) onOk();
        afterAction();
      } else {
        toast('ko', ACTION_LABEL[name] + ' : ' + r.error);
      }
      syncSysbar();
    });
  }

  /** Bouton d'action sur un job : rien du tout en lecture seule, ce qui laisse la page v1 intacte. */
  function jobButton(job, kind, cls) {
    if (ui.readOnly) return null;
    var isCancel = kind === 'cancel';
    var button = el('button', 'action' + (cls ? ' ' + cls : '') + (isCancel ? ' danger' : ''), isCancel ? 'Annuler' : 'Relancer');
    button.type = 'button';
    button.setAttribute('data-action', kind);
    button.setAttribute('data-job', job.id);
    var label = job.repo + '#' + job.issueNumber;
    var question = isCancel ? 'Annuler le job ' + label + ' ?' : 'Relancer le job ' + label + ' ?';
    button.addEventListener('click', function (event) {
      // Les lignes du tableau ouvrent le détail au clic : sans cela, annuler ouvrirait aussi le panneau.
      event.stopPropagation();
      run(button, kind, { jobId: job.id }, question);
    });
    return button;
  }

  /** Annuler tant que le job tourne, Relancer une fois échoué, bloqué ou annulé, rien sur un job terminé. */
  function jobButtonFor(job, cls) {
    if (!TERMINAL[job.state]) return jobButton(job, 'cancel', cls);
    if (RETRYABLE[job.state]) return jobButton(job, 'retry', cls);
    return null;
  }

  /**
   * État des boutons système. Appelée à chaque snapshot : elle ne touche que hidden, disabled et le
   * libellé — la barre elle-même est construite une fois pour toutes par le HTML.
   */
  function syncSysbar() {
    var bar = byId('sysbar');
    bar.hidden = ui.readOnly;
    byId('paused-banner').hidden = ui.paused !== true;
    // Onglet Jobs : le formulaire et la colonne Actions disparaissent aussi en lecture seule.
    byId('new-job').hidden = ui.readOnly;
    byId('jobs-actions-head').hidden = ui.readOnly;
    if (ui.readOnly || busy > 0) return;
    var start = byId('act-start');
    var pause = byId('act-pause');
    // Démarrer n'a de sens que si rien ne tourne : ni service, ni socket qui réponde.
    start.hidden = ui.serviceRunning || ui.reachable;
    start.disabled = false;
    pause.setAttribute('data-action', ui.paused ? 'resume' : 'pause');
    pause.textContent = ui.paused ? 'Reprendre' : 'Pause';
    [pause, byId('act-poll'), byId('act-stop')].forEach(function (button) {
      button.disabled = !ui.reachable;
      if (ui.reachable) button.removeAttribute('title');
      else button.setAttribute('title', 'daemon arrêté');
    });
    byId('sysbar-hint').textContent = ui.reachable ? '' : 'daemon arrêté : seule l\\'action Démarrer est disponible';
  }

  function renderRecentActions(rows) {
    var tbody = byId('actions-body');
    clear(tbody);
    if (!rows || !rows.length) {
      var empty = el('tr');
      var cell = el('td', 'empty', 'Aucune action enregistrée.');
      cell.colSpan = 4;
      empty.appendChild(cell);
      tbody.appendChild(empty);
      return;
    }
    rows.forEach(function (a) {
      var tr = el('tr');
      tr.appendChild(el('td', 'muted', fmtDate(a.at)));
      tr.appendChild(el('td', null, (ACTION_LABEL[a.action] || String(a.action)) + ' · ' + String(a.source)));
      var target = el('td');
      if (a.repo && a.issueNumber) target.appendChild(issueLink(a.repo, a.issueNumber));
      else if (a.jobId) target.appendChild(el('span', 'muted', String(a.jobId).slice(0, 8)));
      else target.appendChild(el('span', 'muted', '—'));
      tr.appendChild(target);
      tr.appendChild(el('td', a.outcome === 'ok' ? 'a-ok' : 'a-ko', a.outcome === 'ok' ? 'ok' : 'erreur : ' + String(a.error || '')));
      tbody.appendChild(tr);
    });
  }

  // ---------- Onglets ----------

  var VIEWS = { dash: 'view-dash', jobs: 'view-jobs', kpis: 'view-kpis' };
  var loaded = { kpis: false };

  function selectTab(name) {
    Object.keys(VIEWS).forEach(function (key) {
      byId(VIEWS[key]).hidden = key !== name;
    });
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('is-active', tabs[i].getAttribute('data-tab') === name);
    }
    // La liste des jobs bouge pendant qu'on regarde ailleurs : elle est rechargée à chaque entrée.
    if (name === 'jobs') loadJobs();
    if (name === 'kpis' && !loaded.kpis) loadReport();
  }

  // ---------- Tableau de bord ----------

  function renderSystem(o) {
    var box = byId('system');
    clear(box);
    box.appendChild(stat('Daemon', o.daemon.running ? 'actif' : 'arrêté', o.daemon.running ? 'ok' : 'ko',
      o.daemon.pid ? 'pid ' + o.daemon.pid : 'aucun verrou'));
    var svc = o.service || { kind: 'none', installed: false, running: false, enabledAtBoot: false, detail: '' };
    var serviceValue = svc.kind === 'none' ? 'aucun' : (svc.installed ? svc.kind : svc.kind + ' absent');
    var serviceTone = svc.kind === 'none' ? '' : (svc.installed ? (svc.running ? 'ok' : 'warn') : 'warn');
    var serviceDetail = 'au boot : ' + (svc.enabledAtBoot ? 'oui' : 'non') + (svc.detail ? ' · ' + svc.detail : '');
    box.appendChild(stat('Service', serviceValue, serviceTone, serviceDetail));
    box.appendChild(stat('Backend', o.backend, '', o.repos.join(' · ')));
    box.appendChild(stat('Actifs', o.counts.active, o.counts.active ? 'ok' : '', 'dont ' + o.counts.queued + ' en file'));
    box.appendChild(stat('Terminés', o.counts.done, o.counts.done ? 'ok' : '', ''));
    box.appendChild(stat('Bloqués', o.counts.blocked, o.counts.blocked ? 'warn' : '', ''));
    box.appendChild(stat('Échecs', o.counts.failed, o.counts.failed ? 'ko' : '', o.counts.cancelled + ' annulé(s)'));
  }

  function renderBudget(o) {
    var box = byId('budget');
    clear(box);
    var head = el('div', 'budget-head');
    head.appendChild(el('div', 'label', 'Budget du jour'));
    head.appendChild(el('div', 'budget-figure', fmtUsd(o.budget.spentTodayUsd) + ' / ' + fmtUsd(o.budget.dailyBudgetUsd)));
    box.appendChild(head);
    var bar = el('div', 'bar');
    var fill = el('div', 'bar-fill');
    var ratio = Math.max(0, Math.min(1, Number(o.budget.ratio) || 0));
    fill.style.width = (ratio * 100).toFixed(1) + '%';
    if (ratio >= 1) fill.classList.add('over');
    else if (ratio >= 0.8) fill.classList.add('warn');
    bar.appendChild(fill);
    box.appendChild(bar);
  }

  /** Cartes vivantes, indexées par id de job : un snapshot toutes les 2 s ne doit pas les reconstruire. */
  var cards = Object.create(null);

  function buildCard(job) {
    var card = el('div', 'card');
    var head = el('div', 'card-head');
    var badgeNode = badge(job.state);
    var phaseNode = el('span', 'muted', '');
    head.appendChild(badgeNode);
    head.appendChild(issueLink(job.repo, job.issueNumber));
    head.appendChild(phaseNode);
    card.appendChild(head);
    var titleNode = el('div', 'card-title', job.issueTitle);
    card.appendChild(titleNode);
    var meta = el('div', 'card-meta');
    var elapsed = makeMetric('écoulé', '');
    var cost = makeMetric('coût', '');
    var attempt = makeMetric('tentative', '');
    meta.appendChild(elapsed.box);
    meta.appendChild(cost.box);
    meta.appendChild(attempt.box);
    card.appendChild(meta);
    var feedNode = el('pre', 'feed', '');
    card.appendChild(feedNode);
    // Un job actif n'est jamais terminal : seule l'annulation a du sens ici.
    var cancel = jobButton(job, 'cancel', 'small');
    if (cancel) {
      var actions = el('div', 'card-actions');
      actions.appendChild(cancel);
      card.appendChild(actions);
    }
    return {
      card: card, badge: badgeNode, phase: phaseNode, title: titleNode,
      elapsed: elapsed.value, cost: cost.value, attempt: attempt.value, feed: feedNode, state: null
    };
  }

  function updateCard(rec, job) {
    if (rec.state !== job.state) {
      rec.state = job.state;
      rec.badge.className = 'badge ' + (STATE_CLASS[job.state] || 's-queued');
      rec.badge.textContent = STATE_LABEL[job.state] || String(job.state);
    }
    var phaseText = job.phase ? 'phase ' + job.phase.name + ' · essai ' + job.phase.attempt : '';
    if (rec.phase.textContent !== phaseText) rec.phase.textContent = phaseText;
    if (rec.title.textContent !== job.issueTitle) rec.title.textContent = job.issueTitle;
    rec.elapsed.textContent = fmtDuration(job.elapsedMs);
    rec.cost.textContent = fmtUsd(job.costUsd);
    rec.attempt.textContent = String(job.attempt);
    var text = job.feed.length ? job.feed.join('\\n') : 'En attente des premières actions…';
    if (rec.feed.textContent === text) return;
    // Défilement automatique seulement si on lisait déjà le bas : sinon on arrache la lecture en cours.
    var atBottom = rec.feed.scrollHeight - rec.feed.scrollTop - rec.feed.clientHeight < 40;
    rec.feed.textContent = text;
    if (atBottom) rec.feed.scrollTop = rec.feed.scrollHeight;
  }

  function renderActive(o) {
    var box = byId('active');
    byId('active-empty').hidden = o.active.length > 0;
    var seen = Object.create(null);
    o.active.forEach(function (job, index) {
      var rec = cards[job.id];
      if (!rec) {
        rec = buildCard(job);
        cards[job.id] = rec;
      }
      updateCard(rec, job);
      seen[job.id] = true;
      if (box.children[index] !== rec.card) box.insertBefore(rec.card, box.children[index] || null);
    });
    Object.keys(cards).forEach(function (id) {
      if (seen[id]) return;
      if (cards[id].card.parentNode === box) box.removeChild(cards[id].card);
      delete cards[id];
    });
  }

  function renderOverview(o) {
    var svc = o.service || {};
    ui.readOnly = o.readOnly !== false;
    ui.reachable = !!(o.control && o.control.reachable);
    ui.paused = o.daemon ? o.daemon.paused : null;
    ui.serviceRunning = !!svc.running || !!(o.daemon && o.daemon.running);
    ui.repos = o.repos || [];
    syncSysbar();
    renderSystem(o);
    renderBudget(o);
    renderActive(o);
    renderRecentActions(o.recentActions);
  }

  // ---------- Jobs ----------

  function fillFilters(repos) {
    var repoSelect = byId('filter-repo');
    if (repoSelect.options.length === 0) {
      repoSelect.appendChild(new Option('tous', ''));
      repos.forEach(function (r) { repoSelect.appendChild(new Option(r, r)); });
    }
    var stateSelect = byId('filter-state');
    if (stateSelect.options.length === 0) {
      stateSelect.appendChild(new Option('tous', ''));
      STATES.forEach(function (s) { stateSelect.appendChild(new Option(STATE_LABEL[s], s)); });
    }
    var newRepo = byId('new-repo');
    if (newRepo.options.length === 0) {
      repos.forEach(function (r) { newRepo.appendChild(new Option(r, r)); });
    }
  }

  /** La colonne Actions n'existe pas en lecture seule : le colSpan des lignes vides suit. */
  function jobsColumns() {
    return ui.readOnly ? 8 : 9;
  }

  function loadJobs() {
    byId('jobs-actions-head').hidden = ui.readOnly;
    byId('new-job').hidden = ui.readOnly;
    var params = [];
    var repo = byId('filter-repo').value;
    var state = byId('filter-state').value;
    if (repo) params.push('repo=' + encodeURIComponent(repo));
    if (state) params.push('state=' + encodeURIComponent(state));
    params.push('limit=200');
    getJson('/api/jobs' + '?' + params.join('&')).then(function (body) {
      renderJobs(body.jobs);
    }, function (err) {
      var tbody = byId('jobs-body');
      clear(tbody);
      var tr = el('tr');
      var td = el('td', 'empty', String(err.message));
      td.colSpan = jobsColumns();
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
  }

  function renderJobs(jobs) {
    var tbody = byId('jobs-body');
    clear(tbody);
    if (!jobs.length) {
      var empty = el('tr');
      var cell = el('td', 'empty', 'Aucun job pour ce filtre.');
      cell.colSpan = jobsColumns();
      empty.appendChild(cell);
      tbody.appendChild(empty);
      return;
    }
    jobs.forEach(function (job) {
      var tr = el('tr', 'row');
      var stateCell = el('td');
      stateCell.appendChild(badge(job.state));
      tr.appendChild(stateCell);
      var issueCell = el('td');
      issueCell.appendChild(issueLink(job.repo, job.issueNumber));
      tr.appendChild(issueCell);
      tr.appendChild(el('td', 'title-cell', job.issueTitle));
      tr.appendChild(el('td', 'num', fmtUsd(job.costUsd)));
      tr.appendChild(el('td', 'num', fmtDuration(job.durationMs)));
      tr.appendChild(el('td', 'num', job.attempt));
      var prCell = el('td');
      prCell.appendChild(job.prNumber ? ghLink(job.prUrl, '#' + job.prNumber) : el('span', 'muted', '—'));
      tr.appendChild(prCell);
      tr.appendChild(el('td', 'muted', fmtDate(job.createdAt)));
      if (!ui.readOnly) {
        var actionCell = el('td');
        var box = el('div', 'row-actions');
        var button = jobButtonFor(job, 'small');
        if (button) box.appendChild(button);
        else box.appendChild(el('span', 'muted', '—'));
        actionCell.appendChild(box);
        tr.appendChild(actionCell);
      }
      tr.setAttribute('tabindex', '0');
      tr.setAttribute('role', 'button');
      tr.addEventListener('click', function (event) {
        if (event.target && event.target.tagName === 'A') return;
        openDetail(job.id);
      });
      tr.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        // Entrée sur un bouton d'action de la ligne : le clic natif suffit, la ligne ne doit pas s'ouvrir.
        if (event.target !== tr) return;
        event.preventDefault();
        openDetail(job.id);
      });
      tbody.appendChild(tr);
    });
  }

  // ---------- Détail d'un job ----------

  var openPanels = [];
  /** Job affiché dans le panneau, pour le recharger après une action réussie. */
  var detailJobId = null;

  function closeDetail() {
    openPanels.forEach(function (node) { if (node.parentNode) node.parentNode.removeChild(node); });
    openPanels = [];
    detailJobId = null;
  }

  function section(parent, title) {
    parent.appendChild(el('h3', null, title));
  }

  function openDetail(id) {
    getJson('/api/jobs/' + encodeURIComponent(id)).then(renderDetail, function (err) {
      var panel = buildPanel();
      panel.appendChild(el('p', 'error-box', String(err.message)));
    });
  }

  function buildPanel() {
    closeDetail();
    var overlay = el('div', 'overlay');
    overlay.addEventListener('click', closeDetail);
    var panel = el('aside', 'detail');
    document.body.appendChild(overlay);
    document.body.appendChild(panel);
    openPanels = [overlay, panel];
    return panel;
  }

  function renderDetail(detail) {
    var panel = buildPanel();
    var job = detail.job;
    var head = el('div', 'detail-head');
    head.appendChild(badge(job.state));
    head.appendChild(ghLink(detail.issueUrl, job.repo + '#' + job.issueNumber));
    if (job.prNumber) head.appendChild(ghLink(job.prUrl, 'PR #' + job.prNumber));
    head.appendChild(el('span', 'muted', job.id));
    detailJobId = job.id;
    var jobAction = jobButtonFor(job, 'small');
    if (jobAction) head.appendChild(jobAction);
    var close = el('button', 'action close', 'Fermer');
    close.type = 'button';
    close.addEventListener('click', closeDetail);
    head.appendChild(close);
    panel.appendChild(head);
    panel.appendChild(el('p', 'detail-title', job.issueTitle));

    var meta = el('div', 'card-meta');
    meta.appendChild(metric('coût', fmtUsd(job.costUsd)));
    meta.appendChild(metric('durée', fmtDuration(job.durationMs)));
    meta.appendChild(metric('tentatives', job.attempt));
    meta.appendChild(metric('créé', fmtDate(job.createdAt)));
    meta.appendChild(metric('fini', fmtDate(job.finishedAt)));
    panel.appendChild(meta);

    if (job.error) {
      section(panel, 'Erreur');
      panel.appendChild(el('p', 'error-box', job.error));
    }

    if (detail.secrets.length) {
      section(panel, 'Secrets détectés');
      var secretList = el('ul', 'plain');
      detail.secrets.forEach(function (s) {
        secretList.appendChild(el('li', null, s.file + ' · ' + s.ruleId + ' · ligne ' + s.line));
      });
      panel.appendChild(secretList);
    }

    section(panel, 'Phases');
    if (!detail.phases.length) {
      panel.appendChild(el('p', 'empty', 'Aucune phase enregistrée.'));
    } else {
      var list = el('ul', 'plain');
      detail.phases.forEach(function (p) {
        var duration = p.finishedAt ? fmtDuration(new Date(p.finishedAt) - new Date(p.startedAt)) : 'en cours';
        var outcome = p.outcome ? ' · ' + p.outcome : '';
        list.appendChild(el('li', null, p.name + ' · essai ' + p.attempt + ' · ' + fmtUsd(p.costUsd) + ' · ' + duration + outcome));
      });
      panel.appendChild(list);
    }

    if (detail.actions && detail.actions.length) {
      section(panel, 'Actions');
      var actionList = el('ul', 'plain');
      detail.actions.forEach(function (a) {
        var outcome = a.outcome === 'ok' ? 'ok' : 'erreur : ' + String(a.error || '');
        actionList.appendChild(el('li', null, fmtDate(a.at) + ' · ' + (ACTION_LABEL[a.action] || String(a.action)) + ' · ' + String(a.source) + ' · ' + outcome));
      });
      panel.appendChild(actionList);
    }

    if (detail.diff) {
      section(panel, 'Diff');
      panel.appendChild(el('p', null, '+' + detail.diff.additions + ' / -' + detail.diff.deletions + ' · ' + detail.diff.bytes + ' octets'));
    }

    if (detail.transcript) {
      section(panel, 'Transcript ' + detail.transcript.phase + ' (essai ' + detail.transcript.attempt + ')');
      panel.appendChild(el('pre', 'block', detail.transcript.lines.join('\\n')));
    }

    detail.verify.forEach(function (v) {
      section(panel, v.name);
      panel.appendChild(el('pre', 'block', v.tail.join('\\n')));
    });

    if (detail.files.length) {
      section(panel, 'Fichiers du job');
      panel.appendChild(el('p', 'muted', detail.files.join(' · ')));
    }
  }

  // ---------- KPIs ----------

  function pct(x) { return Math.round((Number(x) || 0) * 100) + ' %'; }

  function kpi(label, value, hint) {
    var box = el('div', 'kpi');
    box.appendChild(el('div', 'label', label));
    box.appendChild(el('div', 'value', value));
    if (hint) box.appendChild(el('div', 'hint', hint));
    return box;
  }

  function loadReport() {
    getJson('/api/report?since=' + encodeURIComponent(byId('period').value)).then(function (r) {
      loaded.kpis = true;
      renderReport(r);
    }, function (err) {
      var box = byId('kpis');
      clear(box);
      box.appendChild(el('p', 'error-box', String(err.message)));
    });
  }

  function renderReport(r) {
    var box = byId('kpis');
    clear(box);
    box.appendChild(kpi('Jobs', r.total, 'depuis le ' + fmtDate(r.since)));
    box.appendChild(kpi('PR ouvertes', r.withPr, pct(r.prOpenedRate) + ' des jobs terminés'));
    box.appendChild(kpi('PR mergées', r.merged, pct(r.prMergedRate) + ' des PR ouvertes'));
    box.appendChild(kpi('Coût total', fmtUsd(r.totalCostUsd), 'médian par job livré ' + fmtUsd(r.medianCostUsd)));
    box.appendChild(kpi('Coût / PR mergée', r.costPerMergedPrUsd === null ? 'n/a' : fmtUsd(r.costPerMergedPrUsd), ''));
    box.appendChild(kpi('Durée médiane', fmtDuration(r.medianDurationMs), 'tentatives ' + (Number(r.avgAttempts) || 0).toFixed(1)));
    box.appendChild(kpi('Bloqués', r.byState.blocked, r.byState.failed + ' échec(s)'));
    renderChart(r.perDay);
  }

  function svgNode(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    Object.keys(attrs).forEach(function (key) { node.setAttribute(key, String(attrs[key])); });
    return node;
  }

  function renderChart(perDay) {
    var box = byId('chart');
    clear(box);
    var legend = el('div', 'legend');
    var jobsKey = el('span');
    var jobsSwatch = el('span', 'key');
    jobsSwatch.style.background = '#388bfd';
    jobsKey.appendChild(jobsSwatch);
    jobsKey.appendChild(document.createTextNode('jobs par jour'));
    var costKey = el('span');
    var costSwatch = el('span', 'key');
    costSwatch.style.background = '#d29922';
    costKey.appendChild(costSwatch);
    costKey.appendChild(document.createTextNode('coût par jour ($)'));
    legend.appendChild(jobsKey);
    legend.appendChild(costKey);
    box.appendChild(legend);

    if (!perDay || !perDay.length) {
      box.appendChild(el('p', 'empty', 'Aucune donnée sur la période.'));
      return;
    }

    var W = 1200, H = 260, PAD_L = 48, PAD_R = 48, PAD_T = 16, PAD_B = 30;
    var innerW = W - PAD_L - PAD_R;
    var innerH = H - PAD_T - PAD_B;
    var maxJobs = 1, maxCost = 0.01;
    perDay.forEach(function (d) {
      if (d.jobs > maxJobs) maxJobs = d.jobs;
      if (d.costUsd > maxCost) maxCost = d.costUsd;
    });
    var slot = innerW / perDay.length;
    var barW = Math.max(1, Math.min(38, slot * 0.68));
    var svg = svgNode('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart-svg', role: 'img' });

    [0, 0.5, 1].forEach(function (f) {
      var y = PAD_T + innerH - f * innerH;
      svg.appendChild(svgNode('line', { x1: PAD_L, y1: y, x2: W - PAD_R, y2: y, stroke: '#30363d', 'stroke-width': 1 }));
      var label = svgNode('text', { x: PAD_L - 8, y: y + 4, fill: '#8b949e', 'font-size': 11, 'text-anchor': 'end' });
      label.textContent = String(Math.round(f * maxJobs));
      svg.appendChild(label);
      var right = svgNode('text', { x: W - PAD_R + 8, y: y + 4, fill: '#8b949e', 'font-size': 11 });
      right.textContent = '$' + (f * maxCost).toFixed(0);
      svg.appendChild(right);
    });

    var points = [];
    perDay.forEach(function (d, i) {
      var cx = PAD_L + slot * i + slot / 2;
      var h = (d.jobs / maxJobs) * innerH;
      if (d.jobs > 0) {
        var bar = svgNode('rect', {
          x: cx - barW / 2, y: PAD_T + innerH - h, width: barW, height: Math.max(2, h), rx: 2, fill: '#388bfd', 'fill-opacity': 0.85
        });
        var tip = svgNode('title', {});
        tip.textContent = d.day + ' · ' + d.jobs + ' job(s) · ' + fmtUsd(d.costUsd) + ' · ' + d.done + ' terminé(s), ' + d.failed + ' échec(s), ' + d.blocked + ' bloqué(s)';
        bar.appendChild(tip);
        svg.appendChild(bar);
      }
      points.push(cx + ',' + (PAD_T + innerH - (d.costUsd / maxCost) * innerH));
    });
    svg.appendChild(svgNode('polyline', { points: points.join(' '), fill: 'none', stroke: '#d29922', 'stroke-width': 2 }));

    var firstLabel = svgNode('text', { x: PAD_L, y: H - 8, fill: '#8b949e', 'font-size': 11 });
    firstLabel.textContent = perDay[0].day;
    svg.appendChild(firstLabel);
    var lastLabel = svgNode('text', { x: W - PAD_R, y: H - 8, fill: '#8b949e', 'font-size': 11, 'text-anchor': 'end' });
    lastLabel.textContent = perDay[perDay.length - 1].day;
    svg.appendChild(lastLabel);

    box.appendChild(svg);
  }

  // ---------- Temps réel ----------

  function setConnection(cls, text) {
    byId('conn-dot').className = 'dot ' + cls;
    byId('conn-text').textContent = text;
  }

  var filtersReady = false;
  var source = new EventSource('/api/events');
  source.addEventListener('open', function () { setConnection('live', 'en direct'); });
  source.addEventListener('error', function () { setConnection('lost', 'reconnexion…'); });
  source.addEventListener('snapshot', function (event) {
    var overview;
    try {
      overview = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    setConnection('live', 'en direct · ' + fmtDate(overview.now));
    renderOverview(overview);
    if (!filtersReady) {
      filtersReady = true;
      fillFilters(overview.repos);
    }
  });

  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () { selectTab(tab.getAttribute('data-tab')); });
  });
  byId('refresh').addEventListener('click', loadJobs);
  byId('filter-repo').addEventListener('change', loadJobs);
  byId('filter-state').addEventListener('change', loadJobs);
  byId('period').addEventListener('change', loadReport);
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closeDetail(); });

  // Boutons système : câblés une fois, comme la barre elle-même. Seul l'arrêt demande confirmation —
  // pause, reprise et poll sont réversibles ou sans effet de bord.
  ['act-start', 'act-pause', 'act-poll', 'act-stop'].forEach(function (id) {
    var button = byId(id);
    button.addEventListener('click', function () {
      var name = button.getAttribute('data-action');
      run(button, name, {}, name === 'stop' ? 'Arrêter le daemon ?' : null);
    });
  });

  // Un vrai formulaire : Entrée valide, le bouton est atteignable au clavier, le navigateur vérifie min.
  byId('new-job').addEventListener('submit', function (event) {
    event.preventDefault();
    var repo = byId('new-repo').value;
    var field = byId('new-issue');
    var issueNumber = Number(field.value);
    if (!repo) {
      toast('ko', 'nouveau job : aucun repo configuré');
      return;
    }
    if (!isFinite(issueNumber) || issueNumber < 1 || Math.floor(issueNumber) !== issueNumber) {
      toast('ko', 'nouveau job : numéro d\\'issue invalide');
      return;
    }
    // Le champ n'est vidé qu'en cas de succès : sur un refus, le numéro reste pour corriger et réessayer.
    run(byId('act-enqueue'), 'enqueue', { repo: repo, issueNumber: issueNumber }, null, function () {
      field.value = '';
    });
  });

  syncSysbar();
})();
</script>
</body>
</html>
`;
