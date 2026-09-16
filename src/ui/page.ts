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
  /* Le titre d'issue vient d'un tiers : sans coupure, un mot de 300 caractères étire la carte. */
  .card-title { font-size: 17px; font-weight: 600; margin: 8px 0 2px; overflow-wrap: anywhere; }
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
  select, input[type="number"], input[type="text"], button.action {
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
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  }
  .new-job { align-items: flex-end; }
  .new-job input[type="number"] { width: 130px; }
  .form-title { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); padding-bottom: 10px; }
  .row-actions { display: flex; gap: 6px; white-space: nowrap; }
  button.action.small { padding: 4px 10px; font-size: 12px; }
  .card-actions { display: flex; gap: 8px; margin-top: 12px; }
  .a-ok { color: var(--done); }
  .a-ko { color: var(--failed); }
  /* Réglages : formulaire groupé et blocs d'information. */
  .field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
  .field input, .field select { font-size: 14px; text-transform: none; letter-spacing: 0; }
  .field input[disabled] { opacity: 0.6; cursor: not-allowed; }
  .field-error { color: #ff9b95; font-size: 12px; margin: 0; text-transform: none; letter-spacing: 0; }
  .settings-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 16px; margin-bottom: 8px; }
  .settings-actions { display: flex; align-items: center; gap: 14px; margin: 22px 0; flex-wrap: wrap; }
  .block { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  .block-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
  .block-head .spacer { flex: 1 1 auto; }
  .repo-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .mono { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
  .disks { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  .disk-row { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
  .disk-row .label { font-size: 12px; text-transform: uppercase; letter-spacing: 1px; color: var(--muted); }
  .disk-row .value { font-size: 22px; font-weight: 650; }
  .disk-row .hint { font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
  /* Une pile d'erreurs longues dépasserait la fenêtre et sortirait les plus anciennes de l'écran :
     la pile défile, chaque toast est borné, et le script n'en garde que les quatre derniers. */
  .toasts {
    position: fixed; right: 20px; bottom: 20px; z-index: 12; display: flex; flex-direction: column;
    gap: 10px; align-items: flex-end; max-height: calc(100vh - 40px); overflow-y: auto;
  }
  .toast {
    max-width: 520px; border-radius: 10px; padding: 11px 16px; font-size: 14px; overflow-wrap: anywhere;
    box-shadow: 0 8px 24px rgba(1, 4, 9, 0.55); border: 1px solid var(--border); background: var(--panel-2);
    max-height: 40vh; overflow: auto; flex: 0 0 auto;
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
  .detail-title { font-size: 20px; font-weight: 650; margin: 12px 0 0; overflow-wrap: anywhere; }
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
    <button type="button" class="tab" data-tab="settings">Réglages</button>
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

  <section class="view" id="view-settings" hidden>
    <div class="banner" id="settings-banner" hidden></div>
    <p class="error-box" id="settings-error" hidden></p>
    <form id="settings-form">
      <h2 class="section-title">Exécution</h2>
      <div class="settings-grid">
        <label class="field">Intervalle de poll (s)<input type="number" id="set-poll" min="10" max="3600" step="1"></label>
        <label class="field">Jobs simultanés<input type="number" id="set-concurrent" min="1" max="8" step="1"></label>
        <label class="field">Budget quotidien (USD)<input type="number" id="set-budget" min="0" step="0.01" placeholder="aucune limite"></label>
      </div>
      <h2 class="section-title">Agent</h2>
      <div class="settings-grid">
        <label class="field">Backend<select id="set-backend"><option value="sdk">sdk</option><option value="claude-code">claude-code</option><option value="codex">codex</option><option value="opencode">opencode</option></select></label>
        <label class="field">Sandbox<select id="set-sandbox"><option value="false">non</option><option value="true">oui</option></select></label>
        <label class="field">Modèle triage (codex/opencode)<input type="text" id="set-model-triage" placeholder="défaut du backend"></label>
        <label class="field">Modèle implémentation (codex/opencode)<input type="text" id="set-model-implement" placeholder="défaut du backend"></label>
      </div>
      <p class="hint muted">Surcharge des modèles réservée à codex et opencode ; sdk et claude-code suivent les modèles de sisyphe.yml.</p>
      <h2 class="section-title">GitHub</h2>
      <div class="settings-grid">
        <label class="field">App ID<input type="number" id="set-app-id" min="1" step="1"></label>
        <label class="field">Installation ID<input type="number" id="set-installation" min="1" step="1"></label>
        <label class="field">Label de déclenchement<input type="text" id="set-label"></label>
        <label class="field">Clé privée (chemin)<input type="text" id="set-key-path"></label>
        <label class="field">Dossier de données<input type="text" id="set-data-dir" disabled></label>
      </div>
      <div id="set-jira-block">
        <h2 class="section-title">Jira</h2>
        <div class="settings-grid">
          <label class="field">Site<input type="text" id="set-jira-site" placeholder="xxx.atlassian.net"></label>
          <label class="field">Compte porteur du jeton<input type="text" id="set-jira-email" placeholder="adresse"></label>
          <label class="field">Jeton API (chemin)<input type="text" id="set-jira-token"></label>
        </div>
        <p class="hint muted">Seul le chemin est manipulé ici : le jeton lui-même n'est ni lu, ni affiché, ni transmis à la page.</p>
        <ul class="plain" id="set-jira-projects"></ul>
        <div class="filters" id="set-jira-add-row">
          <label class="field">Projet<input type="text" id="set-jira-new-key" placeholder="IOS"></label>
          <label class="field">Dépôt<select id="set-jira-new-repo"></select></label>
          <label class="field">Compte Sisyphe<input type="text" id="set-jira-new-account" placeholder="adresse ou nom"></label>
          <button type="button" class="action" id="set-jira-add">Ajouter</button>
        </div>
        <p class="hint muted" id="set-jira-add-hint"></p>
        <p class="hint muted">Sans projet, le suivi reste sur les issues GitHub.</p>
      </div>
      <h2 class="section-title">Dépôts surveillés</h2>
      <ul class="plain" id="set-repos"></ul>
      <div class="filters">
        <label class="field">Ajouter un dépôt<input type="text" id="set-repo-new" placeholder="owner/repo"></label>
        <button type="button" class="action" id="set-repo-add">Ajouter</button>
      </div>
      <div class="settings-actions">
        <button type="submit" class="action primary" id="set-save" disabled>Enregistrer</button>
        <span class="hint muted" id="set-hint"></span>
      </div>
    </form>
    <h2 class="section-title">Diagnostic</h2>
    <div class="block">
      <div class="block-head"><button type="button" class="action" id="diag-refresh">Relancer</button></div>
      <ul class="plain" id="diag-list"></ul>
    </div>
    <h2 class="section-title">Espace disque</h2>
    <div class="block">
      <div class="disks" id="disk-list"></div>
      <div class="block-head">
        <span class="hint muted" id="disk-total"></span>
        <span class="spacer"></span>
        <button type="button" class="action danger" id="purge-cache">Vider le cache de build</button>
      </div>
    </div>
    <h2 class="section-title">Environnement</h2>
    <div class="block"><ul class="plain" id="env-list"></ul></div>
    <h2 class="section-title">Dépôts</h2>
    <div class="block"><ul class="plain" id="repos-list"></ul></div>
  </section>
</main>
<div class="toasts" id="toasts" role="status" aria-live="polite" aria-atomic="false"></div>
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
  var ui = { readOnly: true, reachable: false, paused: null, serviceRunning: false, repos: [], pendingRestart: [] };
  /** Échéance d'un appel d'action : au-dessus des 30 s que le serveur s'accorde pour attendre un démarrage. */
  var ACTION_TIMEOUT_MS = 45000;
  /** Toasts empilés au plus ; au-delà les plus anciens quitteraient l'écran. */
  var MAX_TOASTS = 4;

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
    // Sans échéance, une requête restée en l'air ne rendrait jamais la main : le bouton resterait
    // désactivé et le compteur busy bloquerait la barre système pour le reste de la session. 45 s
    // couvrent les 30 s que le serveur s'accorde pour attendre le daemon après un démarrage.
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ACTION_TIMEOUT_MS);
    return fetch('/api/actions/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Sisyphe-Action': '1' },
      credentials: 'omit',
      signal: controller.signal,
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().then(function (parsed) { return parsed; }, function () { return null; }).then(function (parsed) {
        if (res.ok && parsed && parsed.ok === true) return { ok: true, result: parsed.result };
        var message = parsed && parsed.error ? String(parsed.error) : 'HTTP ' + res.status;
        // issues : le détail par champ d'une configuration refusée, affiché sous chaque champ par la page.
        if (parsed && parsed.issues) return { ok: false, error: message, issues: parsed.issues };
        return { ok: false, error: message };
      });
    }, function (err) {
      if (err && err.name === 'AbortError') {
        return { ok: false, error: 'aucune réponse après ' + Math.round(ACTION_TIMEOUT_MS / 1000) + ' s' };
      }
      return { ok: false, error: err && err.message ? String(err.message) : 'daemon injoignable' };
    }).then(function (r) {
      clearTimeout(timer);
      return r;
    }, function (err) {
      clearTimeout(timer);
      return { ok: false, error: err && err.message ? String(err.message) : 'erreur inattendue' };
    });
  }

  function toast(kind, text) {
    var box = byId('toasts');
    var node = el('div', 'toast ' + kind, text);
    box.appendChild(node);
    // Au-delà de quatre, les plus anciens sortiraient de l'écran sans avoir été lus.
    while (box.children.length > MAX_TOASTS) box.removeChild(box.firstChild);
    setTimeout(function () {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, kind === 'ok' ? 4000 : 8000);
  }

  /**
   * Appels en vol. Unique consommateur : syncSysbar, qui ne touche plus à rien tant qu'il est non nul —
   * sinon le snapshot SSE, qui tombe toutes les 2 s, réactiverait un bouton pendant que son action tourne.
   * api() ne reste jamais en suspens (échéance ci-dessus), donc le compteur redescend toujours à zéro.
   */
  var busy = 0;

  /**
   * Effet local d'une action réussie sur l'état système, appliqué avant le snapshot suivant. Sans lui la
   * barre mentirait pendant 2 s : « Pause » après une pause réussie, Arrêter encore cliquable sur un daemon
   * déjà arrêté. Le serveur n'acquitte start et stop qu'après avoir vérifié la socket : l'avance est sûre.
   */
  function applyLocalEffect(name) {
    if (name === 'pause') ui.paused = true;
    else if (name === 'resume') ui.paused = false;
    else if (name === 'start') { ui.serviceRunning = true; ui.reachable = true; ui.paused = false; }
    else if (name === 'stop') { ui.serviceRunning = false; ui.reachable = false; ui.paused = null; }
  }

  /**
   * Vue à recharger après un succès, en plus du snapshot SSE qui rafraîchit le tableau de bord. Le focus
   * du clavier est rendu au bouton du même job après le rechargement : sans cela il retomberait sur body.
   */
  function afterAction(jobId) {
    if (!byId('view-jobs').hidden) {
      loadJobs(jobId ? function () { focusJobButton(jobId); } : null);
    }
    refreshDetail();
  }

  /** Retrouve le bouton d'action d'un job après un rechargement du tableau, quel que soit son nouvel état. */
  function focusJobButton(jobId) {
    var buttons = byId('jobs-body').querySelectorAll('button[data-job]');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].getAttribute('data-job') === jobId) {
        buttons[i].focus();
        return;
      }
    }
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
        applyLocalEffect(name);
        toast('ok', ACTION_LABEL[name] + ' : c\\'est fait');
        if (onOk) onOk();
        afterAction(body && body.jobId);
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
    // Onglet Jobs : le formulaire disparaît aussi en lecture seule (la colonne Actions, elle, suit les
    // lignes dans renderJobs, pour que l'en-tête et les cellules ne puissent jamais se contredire).
    byId('new-job').hidden = ui.readOnly;
    if (ui.readOnly || busy > 0) return;
    var start = byId('act-start');
    var pause = byId('act-pause');
    // Le prologue du daemon interroge GitHub avant d'ouvrir sa socket : pendant ces quelques dizaines de
    // secondes le service tourne sans répondre. Démarrer reste alors visible mais désactivé — le masquer
    // laisserait une barre entièrement morte, sans rien à cliquer et sans explication.
    var starting = ui.serviceRunning && !ui.reachable;
    start.hidden = ui.reachable;
    start.disabled = starting;
    if (starting) start.setAttribute('title', 'démarrage en cours…');
    else start.removeAttribute('title');
    pause.setAttribute('data-action', ui.paused ? 'resume' : 'pause');
    pause.textContent = ui.paused ? 'Reprendre' : 'Pause';
    [pause, byId('act-poll'), byId('act-stop')].forEach(function (button) {
      button.disabled = !ui.reachable;
      if (ui.reachable) button.removeAttribute('title');
      else button.setAttribute('title', starting ? 'démarrage en cours…' : 'daemon arrêté');
    });
    var hint = '';
    if (starting) hint = 'démarrage en cours…';
    else if (!ui.reachable) hint = 'daemon arrêté : seule l\\'action Démarrer est disponible';
    byId('sysbar-hint').textContent = hint;
  }

  /**
   * Signature de la liste : les lignes du journal sont immuables et identifiées, un simple relevé des id
   * suffit donc à savoir si quoi que ce soit a changé.
   */
  function actionsKey(rows) {
    if (!rows || !rows.length) return 'vide';
    return rows.map(function (a) { return String(a.id) + ':' + String(a.at) + ':' + String(a.action); }).join(',');
  }

  var lastActionsKey = null;

  function renderRecentActions(rows) {
    // Le snapshot tombe toutes les 2 s : reconstruire à chaque fois empêcherait tout lien de garder le
    // focus et ferait courir un clic contre la reconstruction suivante.
    var key = actionsKey(rows);
    if (key === lastActionsKey) return;
    lastActionsKey = key;
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

  var VIEWS = { dash: 'view-dash', jobs: 'view-jobs', kpis: 'view-kpis', settings: 'view-settings' };
  var loaded = { kpis: false };
  /** Blocs d'information chargés au premier affichage de l'onglet, pas au chargement de la page. */
  var blocks = { diagnostics: false, disk: false };

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
    if (name === 'settings') {
      if (!settings.loaded && !settings.loading) loadSettings();
      if (!blocks.diagnostics) { blocks.diagnostics = true; loadDiagnostics(false); }
      if (!blocks.disk) { blocks.disk = true; loadDisk(); }
    }
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
    var cap = o.budget.dailyBudgetUsd;
    var head = el('div', 'budget-head');
    head.appendChild(el('div', 'label', 'Budget du jour'));
    // Sans plafond, c'est la limite qui disparaît, pas la dépense : le coût du jour reste affiché.
    var figure = cap === null ? fmtUsd(o.budget.spentTodayUsd) : fmtUsd(o.budget.spentTodayUsd) + ' / ' + fmtUsd(cap);
    head.appendChild(el('div', 'budget-figure', figure));
    box.appendChild(head);
    if (cap === null) {
      box.appendChild(el('div', 'muted', 'aucune limite'));
      return;
    }
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
    ui.pendingRestart = (o.daemon && o.daemon.pendingRestart) || [];
    syncSysbar();
    renderSystem(o);
    renderBudget(o);
    renderActive(o);
    renderRecentActions(o.recentActions);
    // Le rappel de redémarrage survit au rafraîchissement : il vient du daemon, pas de la réponse d'un enregistrement.
    if (settings.loaded) {
      applySettingsReadOnly();
      renderSettingsBanner();
    }
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

  function loadJobs(after) {
    byId('new-job').hidden = ui.readOnly;
    var params = [];
    var repo = byId('filter-repo').value;
    var state = byId('filter-state').value;
    if (repo) params.push('repo=' + encodeURIComponent(repo));
    if (state) params.push('state=' + encodeURIComponent(state));
    params.push('limit=200');
    getJson('/api/jobs' + '?' + params.join('&')).then(function (body) {
      renderJobs(body.jobs);
      // Une fois les lignes en place seulement : le focus vise un bouton qui n'existait pas avant.
      // Le test du type protège des branchements directs en écouteur, où le premier argument est l'événement.
      if (typeof after === 'function') after();
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
    // L'en-tête est basculé ici, avec les lignes qu'il décrit : réglé ailleurs, un premier rendu
    // antérieur au premier snapshot afficherait neuf colonnes d'en-tête au-dessus de huit cellules.
    byId('jobs-actions-head').hidden = ui.readOnly;
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
      // tabindex sans role="button" : la ligne reste une ligne de tableau pour les lecteurs d'écran
      // (le rôle aplatissait déjà les cellules, et il est invalide autour du vrai bouton d'action).
      tr.setAttribute('tabindex', '0');
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
  /** Job affiché dans le panneau, pour le rafraîchir après une action réussie. */
  var detailJobId = null;
  /** Nœuds mobiles de l'en-tête du panneau ; null quand le panneau n'affiche qu'une erreur. */
  var detailHead = null;

  function closeDetail() {
    openPanels.forEach(function (node) { if (node.parentNode) node.parentNode.removeChild(node); });
    openPanels = [];
    detailJobId = null;
    detailHead = null;
  }

  function section(parent, title) {
    parent.appendChild(el('h3', null, title));
  }

  function openDetail(id) {
    getJson('/api/jobs/' + encodeURIComponent(id)).then(renderDetail, function (err) {
      var panel = buildPanel();
      // Retenu malgré l'erreur : une action réussie retentera l'ouverture au lieu de laisser ce message.
      detailJobId = id;
      panel.appendChild(el('p', 'error-box', String(err.message)));
    });
  }

  /**
   * Après une action, seuls l'état du job et son bouton changent dans l'en-tête : les mettre à jour sur
   * place évite de reconstruire le panneau, ce qui ramènerait le défilement en haut et perdrait le focus.
   * Le reste du panneau (phases, transcript, liste d'actions) attend la prochaine ouverture.
   */
  function refreshDetail() {
    if (!detailJobId) return;
    var id = detailJobId;
    // Panneau d'erreur : rien à mettre à jour sur place, mais l'ouverture peut maintenant aboutir.
    if (!detailHead) {
      openDetail(id);
      return;
    }
    getJson('/api/jobs/' + encodeURIComponent(id)).then(function (detail) {
      // Le panneau a pu être fermé ou remplacé pendant la requête.
      if (detailJobId !== id || !detailHead) return;
      var job = detail.job;
      detailHead.badge.className = 'badge ' + (STATE_CLASS[job.state] || 's-queued');
      detailHead.badge.textContent = STATE_LABEL[job.state] || String(job.state);
      var keepFocus = detailHead.action !== null && document.activeElement === detailHead.action;
      if (detailHead.action && detailHead.action.parentNode) detailHead.action.parentNode.removeChild(detailHead.action);
      detailHead.action = jobButtonFor(job, 'small');
      if (detailHead.action) {
        detailHead.node.insertBefore(detailHead.action, detailHead.close);
        if (keepFocus) detailHead.action.focus();
      } else if (keepFocus) {
        // Plus aucune action possible sur ce job : le focus va au bouton voisin plutôt que sur body.
        detailHead.close.focus();
      }
    }, function () {
      // L'action a réussi ; seul l'affichage est en retard, le panneau reste tel quel.
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
    var stateBadge = badge(job.state);
    head.appendChild(stateBadge);
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
    detailHead = { node: head, badge: stateBadge, action: jobAction, close: close };
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

  // ---------- Réglages ----------

  /** Nom de configuration → id du champ, pour poser chaque erreur de validation sous le champ fautif. */
  var FIELD_IDS = {
    'github.appId': 'set-app-id',
    'github.installationId': 'set-installation',
    'github.privateKeyPath': 'set-key-path',
    triggerLabel: 'set-label',
    pollIntervalSeconds: 'set-poll',
    maxConcurrentJobs: 'set-concurrent',
    dailyBudgetUsd: 'set-budget',
    sandbox: 'set-sandbox',
    agentBackend: 'set-backend',
    'agentModels.triage': 'set-model-triage',
    'agentModels.implement': 'set-model-implement',
    dataDir: 'set-data-dir',
    'jira.site': 'set-jira-site',
    'jira.email': 'set-jira-email',
    'jira.apiTokenPath': 'set-jira-token'
  };
  var CHECK_ICON = { ok: '✅', warn: '⚠️', fail: '❌' };
  var CHECK_CLASS = { ok: 's-done', warn: 's-blocked', fail: 's-failed' };
  /** Suffixe des contrôles par dépôt de doctor : ceux-là nourrissent le bloc Dépôts, pas le bloc Diagnostic. */
  var REPO_CHECK_SUFFIX = ' · sisyphe.yml';

  /** État du formulaire : dernière config enregistrée (chaîne comparable) et liste de dépôts en cours d'édition. */
  var settings = { loaded: false, loading: false, baseline: null, repos: [], jira: null, jiraNames: {}, notice: null, lastReadOnly: null };

  function numberValue(id) {
    var v = byId(id).value.trim();
    return v === '' ? null : Number(v);
  }

  /** La configuration telle que le formulaire la porte. dailyBudgetUsd vide vaut null : « aucune limite ». */
  function readSettingsConfig() {
    var triage = byId('set-model-triage').value.trim();
    var implement = byId('set-model-implement').value.trim();
    var config = {
      github: {
        appId: numberValue('set-app-id'),
        installationId: numberValue('set-installation'),
        privateKeyPath: byId('set-key-path').value.trim()
      },
      repos: settings.repos.slice(),
      triggerLabel: byId('set-label').value.trim(),
      pollIntervalSeconds: numberValue('set-poll'),
      maxConcurrentJobs: numberValue('set-concurrent'),
      dailyBudgetUsd: numberValue('set-budget'),
      sandbox: byId('set-sandbox').value === 'true',
      agentBackend: byId('set-backend').value,
      // Reposté tel quel : le serveur refuse une modification, et l'omettre ferait retomber le schéma sur sa valeur par défaut.
      dataDir: byId('set-data-dir').value
    };
    // La section Jira n'est éditable que sur ses trois scalaires ; les projets repartent tels qu'ils ont été
    // chargés. Il faut la réémettre entière : le schéma exige projects, et l'omettre ferait reporter
    // l'ancienne section par le serveur, donc perdre la saisie.
    var site = byId('set-jira-site').value.trim();
    var email = byId('set-jira-email').value.trim();
    var token = byId('set-jira-token').value.trim();
    // Un null explicite quand il ne reste rien à décrire : sans lui, le serveur reporterait l'ancienne
    // section et le suivi Jira serait impossible à retirer depuis la page.
    config.jira = (site && email && token && settings.jira.projects.length)
      ? { site: site, email: email, apiTokenPath: token, projects: settings.jira.projects.map(cleanJiraProject) }
      : null;
    // Les deux champs vides : aucune clé agentModels envoyée, le serveur garde ses défauts. Sinon seules les surcharges saisies partent.
    if (triage || implement) {
      config.agentModels = {};
      if (triage) config.agentModels.triage = triage;
      if (implement) config.agentModels.implement = implement;
    }
    return config;
  }

  function setField(id, value) {
    byId(id).value = value === undefined || value === null ? '' : String(value);
  }

  function renderReposEditor() {
    var list = byId('set-repos');
    clear(list);
    if (!settings.repos.length) {
      list.appendChild(el('li', 'muted', 'Aucun dépôt surveillé.'));
      return;
    }
    settings.repos.forEach(function (repo, index) {
      var li = el('li', 'repo-row');
      li.appendChild(el('span', null, repo));
      if (!ui.readOnly) {
        var remove = el('button', 'action small danger', 'Retirer');
        remove.type = 'button';
        remove.addEventListener('click', function () {
          settings.repos.splice(index, 1);
          renderReposEditor();
          renderJiraRepoChoices();
          updateSaveState();
        });
        li.appendChild(remove);
      }
      list.appendChild(li);
    });
  }

  function fillSettings(config, dataDir) {
    setField('set-poll', config.pollIntervalSeconds);
    setField('set-concurrent', config.maxConcurrentJobs);
    setField('set-budget', config.dailyBudgetUsd === null || config.dailyBudgetUsd === undefined ? '' : config.dailyBudgetUsd);
    byId('set-backend').value = config.agentBackend;
    byId('set-sandbox').value = config.sandbox ? 'true' : 'false';
    setField('set-app-id', config.github.appId);
    setField('set-installation', config.github.installationId);
    setField('set-label', config.triggerLabel);
    setField('set-key-path', config.github.privateKeyPath);
    var models = config.agentModels || {};
    setField('set-model-triage', models.triage);
    setField('set-model-implement', models.implement);
    setField('set-data-dir', dataDir);
    settings.repos = config.repos.slice();
    // Toujours un objet, même sans section en place : la page doit pouvoir en créer une de zéro.
    settings.jira = config.jira || { site: '', email: '', apiTokenPath: '', projects: [] };
    settings.jira.projects = (settings.jira.projects || []).slice();
    setField('set-jira-site', settings.jira.site);
    setField('set-jira-email', settings.jira.email);
    setField('set-jira-token', settings.jira.apiTokenPath);
    renderJiraProjects();
    renderJiraRepoChoices();
    renderReposEditor();
  }

  /**
   * Un projet par ligne. Les statuts sont saisis en liste séparée par des virgules : l'ordre y est
   * signifiant — c'est lui que suit la marche de transitions — et une liste ordonnée se relit mieux sur
   * une ligne que dans un tableau. Les deux statuts de travail sont des menus construits depuis cette
   * liste, pour qu'ils ne puissent pas désigner un statut absent du workflow.
   */
  function renderJiraProjects() {
    var list = byId('set-jira-projects');
    clear(list);
    var projects = settings.jira.projects || [];
    if (!projects.length) {
      list.appendChild(el('li', 'muted', 'Aucun projet Jira : le suivi reste sur les issues GitHub.'));
      return;
    }
    projects.forEach(function (p, index) {
      var li = el('li', 'jira-row');
      var head = el('div', 'jira-row-head');
      head.appendChild(el('strong', null, p.key + ' → ' + p.repo));
      head.appendChild(el('span', 'muted', settings.jiraNames[p.accountId] || p.accountId));
      if (!ui.readOnly) {
        var remove = el('button', 'action small danger', 'Retirer');
        remove.type = 'button';
        remove.addEventListener('click', function () {
          settings.jira.projects.splice(index, 1);
          renderJiraProjects();
          updateSaveState();
        });
        head.appendChild(remove);
      }
      li.appendChild(head);
      li.appendChild(jiraListField(p, index, 'candidateStatuses', 'Statuts déclencheurs'));
      li.appendChild(jiraListField(p, index, 'statusesInOrder', 'Ordre du workflow'));
      li.appendChild(jiraStatusSelect(p, index, 'inProgressStatus', 'Pendant le travail'));
      li.appendChild(jiraStatusSelect(p, index, 'doneStatus', 'PR ouverte'));
      list.appendChild(li);
    });
  }

  /** Le nom lisible du compte n'est qu'un confort d'affichage : il ne fait pas partie de la configuration. */
  function cleanJiraProject(p) {
    return {
      key: p.key, accountId: p.accountId, repo: p.repo,
      candidateStatuses: p.candidateStatuses, statusesInOrder: p.statusesInOrder,
      inProgressStatus: p.inProgressStatus, doneStatus: p.doneStatus
    };
  }

  function jiraListField(project, index, field, label) {
    var wrap = el('label', 'field', label);
    var input = el('input');
    input.type = 'text';
    input.value = (project[field] || []).join(', ');
    input.disabled = ui.readOnly;
    input.addEventListener('input', function () {
      settings.jira.projects[index][field] = input.value.split(',').map(function (v) { return v.trim(); }).filter(Boolean);
      // L'ordre du workflow alimente les deux menus : ils se reconstruisent à chaque frappe.
      if (field === 'statusesInOrder') renderJiraProjects();
      updateSaveState();
    });
    wrap.appendChild(input);
    return wrap;
  }

  function jiraStatusSelect(project, index, field, label) {
    var wrap = el('label', 'field', label);
    var select = el('select');
    var options = (project.statusesInOrder || []).slice();
    // Une valeur hors du workflow reste proposée plutôt que d'être effacée en silence : c'est justement
    // celle que doctor signale, et l'escamoter empêcherait de la voir pour la corriger.
    if (project[field] && options.indexOf(project[field]) === -1) options.push(project[field]);
    options.forEach(function (name) {
      var opt = el('option', null, name);
      opt.value = name;
      select.appendChild(opt);
    });
    select.value = project[field] || '';
    select.disabled = ui.readOnly;
    select.addEventListener('change', function () {
      settings.jira.projects[index][field] = select.value;
      updateSaveState();
    });
    wrap.appendChild(select);
    return wrap;
  }

  /** Ajout d'un projet : le compte est cherché côté serveur, jamais saisi en identifiant brut. */
  function addJiraProject() {
    var hint = byId('set-jira-add-hint');
    var key = byId('set-jira-new-key').value.trim().toUpperCase();
    var repo = byId('set-jira-new-repo').value;
    var query = byId('set-jira-new-account').value.trim();
    if (!key || !repo || !query) {
      hint.textContent = 'Projet, dépôt et compte sont requis.';
      return;
    }
    if (settings.jira.projects.some(function (p) { return p.repo === repo; })) {
      hint.textContent = 'Ce dépôt est déjà servi par un projet Jira.';
      return;
    }
    hint.textContent = 'Recherche du compte…';
    api('jira-accounts', {
      site: byId('set-jira-site').value.trim(),
      email: byId('set-jira-email').value.trim(),
      apiTokenPath: byId('set-jira-token').value.trim(),
      query: query
    }).then(function (r) {
      if (!r.ok) { hint.textContent = r.error; return; }
      var accounts = (r.result && r.result.accounts) || [];
      if (!accounts.length) { hint.textContent = 'Aucun compte ne correspond à « ' + query + ' ».'; return; }
      if (accounts.length > 1) {
        hint.textContent = accounts.length + ' comptes correspondent : précisez l’adresse exacte.';
        return;
      }
      settings.jiraNames[accounts[0].accountId] = accounts[0].displayName;
      settings.jira.projects.push({
        key: key,
        accountId: accounts[0].accountId,
        repo: repo,
        candidateStatuses: ['Nouveau', 'En analyse'],
        statusesInOrder: ['Nouveau', 'En analyse', 'A développer', 'En développement', 'En relecture', 'Developpement fini'],
        inProgressStatus: 'En développement',
        doneStatus: 'En relecture'
      });
      byId('set-jira-new-key').value = '';
      byId('set-jira-new-account').value = '';
      hint.textContent = 'Ajouté : ' + accounts[0].displayName;
      renderJiraProjects();
      updateSaveState();
    });
  }

  /** Les dépôts proposés sont ceux que Sisyphe surveille : un projet Jira n'a de sens que pour l'un d'eux. */
  function renderJiraRepoChoices() {
    var select = byId('set-jira-new-repo');
    var previous = select.value;
    clear(select);
    settings.repos.forEach(function (repo) {
      var opt = el('option', null, repo);
      opt.value = repo;
      select.appendChild(opt);
    });
    if (previous) select.value = previous;
  }

  function updateSaveState() {
    var changed = settings.baseline !== null && JSON.stringify(readSettingsConfig()) !== settings.baseline;
    byId('set-save').disabled = ui.readOnly || !changed;
    byId('set-hint').textContent = changed ? 'modifications non enregistrées' : '';
  }

  function loadSettings() {
    settings.loading = true;
    return getJson('/api/settings').then(function (body) {
      settings.loading = false;
      settings.loaded = true;
      fillSettings(body.config, body.dataDir);
      // Référence de comparaison : c'est la forme réémettrice du formulaire, pas le JSON du serveur.
      settings.baseline = JSON.stringify(readSettingsConfig());
      applySettingsReadOnly();
      updateSaveState();
    }, function (err) {
      settings.loading = false;
      clear(byId('set-repos'));
      byId('settings-error').hidden = false;
      clear(byId('settings-error'));
      byId('settings-error').appendChild(el('p', null, String(err.message)));
    });
  }

  /** Désactive les champs en lecture seule ; dataDir reste verrouillé dans tous les cas (il se change par sisyphe setup). */
  function applySettingsReadOnly() {
    var disabled = ui.readOnly;
    ['set-poll', 'set-concurrent', 'set-budget', 'set-backend', 'set-sandbox', 'set-model-triage',
      'set-model-implement', 'set-app-id', 'set-installation', 'set-label', 'set-key-path',
      'set-jira-site', 'set-jira-email', 'set-jira-token'].forEach(function (id) {
      byId(id).disabled = disabled;
    });
    byId('set-data-dir').disabled = true;
    byId('set-repo-new').hidden = disabled;
    byId('set-repo-add').hidden = disabled;
    byId('set-jira-add-row').hidden = disabled;
    byId('set-save').hidden = disabled;
    byId('purge-cache').hidden = disabled;
    // La liste des dépôts n'a de boutons « Retirer » qu'en écriture : elle n'est reconstruite qu'au changement de mode.
    if (settings.lastReadOnly !== disabled) {
      settings.lastReadOnly = disabled;
      if (settings.loaded) {
        renderReposEditor();
        renderJiraProjects();
      }
    }
  }

  function addRepo() {
    var field = byId('set-repo-new');
    var value = field.value.trim();
    if (!value) return;
    if (settings.repos.indexOf(value) >= 0) {
      toast('ko', 'dépôt déjà surveillé : ' + value);
      return;
    }
    settings.repos.push(value);
    field.value = '';
    renderReposEditor();
    renderJiraRepoChoices();
    updateSaveState();
  }

  function clearFieldErrors() {
    var nodes = document.querySelectorAll('.field-error');
    for (var i = 0; i < nodes.length; i++) if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]);
    var box = byId('settings-error');
    box.hidden = true;
    clear(box);
  }

  function fieldInput(path) {
    if (FIELD_IDS[path]) return byId(FIELD_IDS[path]);
    if (path === 'repos' || path.indexOf('repos.') === 0) return byId('set-repos');
    return null;
  }

  function showFieldErrors(issues, error) {
    var box = byId('settings-error');
    var general = [];
    (issues || []).forEach(function (issue) {
      var input = fieldInput(issue.path);
      if (input && input.parentNode) input.parentNode.appendChild(el('p', 'field-error', issue.message));
      else general.push(issue);
    });
    if (!general.length && !error) return;
    box.hidden = false;
    if (error) box.appendChild(el('p', null, error));
    general.forEach(function (issue) { box.appendChild(el('p', null, issue.message)); });
  }

  function submitSettings(button) {
    clearFieldErrors();
    busy++;
    button.disabled = true;
    api('settings', readSettingsConfig()).then(function (r) {
      busy--;
      if (!r.ok) {
        showFieldErrors(r.issues, r.error);
        toast('ko', 'réglages : ' + r.error);
        updateSaveState();
        return;
      }
      afterSave(r.result);
    });
  }

  /**
   * Traduit la réponse de l'enregistrement en un rappel. reloaded true : le daemon a relu le fichier.
   * reloaded false : il est arrêté (changed prendra effet au démarrage) ou il a refusé (reloadError).
   */
  function afterSave(result) {
    settings.notice = result;
    if (result.reloaded) {
      toast('ok', result.needsRestart && result.needsRestart.length ? 'réglages enregistrés · redémarrage requis' : 'réglages enregistrés');
    } else if (result.reloadError) {
      toast('ko', "enregistré, mais le daemon n'a pas rechargé");
    } else {
      toast('ok', 'réglages enregistrés · effet au démarrage');
    }
    // Relit le fichier écrit : la référence de comparaison repart de ce qui est désormais en place.
    loadSettings();
    renderSettingsBanner();
  }

  function restartDaemon(button) {
    if (!window.confirm('Redémarrer le daemon ?')) return;
    busy++;
    button.disabled = true;
    api('stop', {}).then(function (r) {
      if (!r.ok) {
        busy--;
        button.disabled = false;
        toast('ko', 'arrêt : ' + r.error);
        syncSysbar();
        return;
      }
      applyLocalEffect('stop');
      return api('start', {}).then(function (r2) {
        busy--;
        button.disabled = false;
        if (r2.ok) {
          applyLocalEffect('start');
          settings.notice = null;
          toast('ok', "redémarrage : c'est fait");
        } else {
          toast('ko', 'démarrage : ' + r2.error);
        }
        syncSysbar();
        renderSettingsBanner();
      });
    });
  }

  /**
   * Le bandeau de redémarrage. Le rappel persistant vient de daemon.pendingRestart : il reste affiché tant
   * que le daemon tourne sur une configuration dépassée, même après avoir quitté puis rouvert l'onglet.
   * Un enregistrement daemon arrêté propose Démarrer, jamais Redémarrer.
   */
  function renderSettingsBanner() {
    var banner = byId('settings-banner');
    clear(banner);
    var notice = settings.notice;
    var pending = ui.pendingRestart || [];
    var restartFields = null;
    var stoppedFields = null;
    var errorText = null;
    if (ui.reachable && pending.length) restartFields = pending;
    if (notice) {
      if (notice.reloaded === false && notice.reloadError) errorText = notice.reloadError;
      else if (notice.reloaded === false) stoppedFields = notice.changed || [];
      else if (notice.needsRestart && notice.needsRestart.length) restartFields = restartFields || notice.needsRestart;
    }
    if (!restartFields && !stoppedFields && !errorText) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    if (restartFields) {
      banner.appendChild(el('span', null, "Redémarrage requis : " + restartFields.join(', ') + '. Le daemon tourne encore sur l\\'ancienne configuration.'));
      if (!ui.readOnly) {
        var restart = el('button', 'action small danger', 'Redémarrer');
        restart.type = 'button';
        restart.addEventListener('click', function () { restartDaemon(restart); });
        banner.appendChild(restart);
      }
      return;
    }
    if (stoppedFields) {
      banner.appendChild(el('span', null, (stoppedFields.length ? 'Enregistré. Prendra effet au démarrage : ' + stoppedFields.join(', ') + '.' : 'Enregistré. Prendra effet au prochain démarrage du daemon.')));
      if (!ui.readOnly) {
        var start = el('button', 'action small primary', 'Démarrer');
        start.type = 'button';
        start.addEventListener('click', function () { run(start, 'start', {}); });
        banner.appendChild(start);
      }
      return;
    }
    banner.appendChild(el('span', null, "Enregistré, mais le daemon n'a pas rechargé : " + errorText + ". Il tourne encore sur l'ancienne configuration."));
  }

  function checkLine(check) {
    var li = el('li');
    li.appendChild(el('span', 'badge ' + (CHECK_CLASS[check.status] || 's-queued'), CHECK_ICON[check.status] || '?'));
    li.appendChild(el('span', null, ' ' + check.name + ' · ' + check.detail));
    return li;
  }

  /** Le contrôle d'accès à l'App et les contrôles par dépôt alimentent le bloc Dépôts, pas le bloc Diagnostic. */
  function isRepoCheck(name) {
    return name === 'GitHub App' || name.indexOf(REPO_CHECK_SUFFIX) > 0;
  }

  function renderDiagnostics(d) {
    var general = byId('diag-list');
    var repos = byId('repos-list');
    clear(general);
    clear(repos);
    var repoChecks = [];
    d.checks.forEach(function (check) {
      if (isRepoCheck(check.name)) repoChecks.push(check);
      else general.appendChild(checkLine(check));
    });
    if (!general.children.length) general.appendChild(el('li', 'muted', 'Aucun contrôle général.'));
    if (!repoChecks.length) {
      repos.appendChild(el('li', 'muted', 'Aucun dépôt contrôlé : diagnostic non lancé ou App GitHub inaccessible.'));
    }
    repoChecks.forEach(function (check) { repos.appendChild(checkLine(check)); });
  }

  function renderEnvironment(d) {
    var list = byId('env-list');
    clear(list);
    var labels = { sisyphe: 'Sisyphe', node: 'Node', claude: 'Claude CLI', git: 'git', gitleaks: 'gitleaks' };
    Object.keys(labels).forEach(function (key) {
      list.appendChild(el('li', null, labels[key] + ' · ' + (d.versions[key] === null ? 'absent' : d.versions[key])));
    });
    var pathLabels = { config: 'Configuration', data: 'Données', socket: 'Socket', logs: 'Logs' };
    Object.keys(pathLabels).forEach(function (key) {
      var li = el('li');
      li.appendChild(el('span', 'muted', pathLabels[key] + ' · '));
      li.appendChild(el('span', 'mono', d.paths[key]));
      list.appendChild(li);
    });
  }

  function loadDiagnostics(fresh) {
    return getJson('/api/diagnostics' + (fresh ? '?fresh=1' : '')).then(function (d) {
      renderDiagnostics(d);
      renderEnvironment(d);
    }, function (err) {
      var list = byId('diag-list');
      clear(list);
      list.appendChild(el('li', 'error-box', String(err.message)));
    });
  }

  function fmtBytes(n) {
    var v = Number(n);
    if (!isFinite(v) || v < 0) v = 0;
    var units = ['o', 'Ko', 'Mo', 'Go', 'To'];
    var i = 0;
    while (v >= 1024 && i < units.length - 1) { v = v / 1024; i++; }
    return (i === 0 ? String(Math.round(v)) : v.toFixed(1)) + ' ' + units[i];
  }

  function renderDisk(d) {
    var box = byId('disk-list');
    clear(box);
    d.entries.forEach(function (entry) {
      var row = el('div', 'disk-row');
      row.appendChild(el('div', 'label', entry.name));
      row.appendChild(el('div', 'value', fmtBytes(entry.bytes)));
      row.appendChild(el('div', 'hint', entry.path));
      box.appendChild(row);
    });
    byId('disk-total').textContent = 'Total : ' + fmtBytes(d.totalBytes);
  }

  function loadDisk() {
    return getJson('/api/disk').then(renderDisk, function (err) {
      clear(byId('disk-list'));
      byId('disk-total').textContent = String(err.message);
    });
  }

  function purgeCache(button) {
    if (!window.confirm('Vider le cache de build ? Il sera reconstruit au prochain build.')) return;
    busy++;
    button.disabled = true;
    api('purge-cache', {}).then(function (r) {
      busy--;
      button.disabled = false;
      if (r.ok) {
        toast('ok', 'cache vidé · ' + fmtBytes(r.result && r.result.freedBytes) + ' libérés');
        loadDisk();
      } else {
        toast('ko', 'purge : ' + r.error);
      }
    });
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
  // Enveloppés : branchés directement, l'événement arriverait comme callback de fin de chargement.
  byId('refresh').addEventListener('click', function () { loadJobs(); });
  byId('filter-repo').addEventListener('change', function () { loadJobs(); });
  byId('filter-state').addEventListener('change', function () { loadJobs(); });
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

  // Onglet Réglages : le formulaire signale ses modifications, les blocs se chargent au premier affichage.
  byId('settings-form').addEventListener('input', updateSaveState);
  byId('settings-form').addEventListener('change', updateSaveState);
  byId('settings-form').addEventListener('submit', function (event) {
    event.preventDefault();
    if (ui.readOnly) return;
    submitSettings(byId('set-save'));
  });
  byId('set-repo-add').addEventListener('click', addRepo);
  byId('set-jira-add').addEventListener('click', addJiraProject);
  byId('set-repo-new').addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    // Sans cela, Entrée soumettrait le formulaire au lieu d'ajouter le dépôt.
    event.preventDefault();
    addRepo();
  });
  byId('diag-refresh').addEventListener('click', function () { loadDiagnostics(true); });
  byId('purge-cache').addEventListener('click', function () { purgeCache(byId('purge-cache')); });

  syncSysbar();
})();
</script>
</body>
</html>
`;
