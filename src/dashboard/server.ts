import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { getUsageStats, listResumePacks, listSessions, loadResumeSessionContexts } from "../storage/analytics";

function json(
  res: ServerResponse<IncomingMessage>,
  status: number,
  payload: unknown,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function html(res: ServerResponse<IncomingMessage>, content: string): void {
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(content);
}

function parseRangeToSince(range: string): string | null {
  const now = Date.now();
  if (range === "24h") {
    return new Date(now - 24 * 60 * 60 * 1000).toISOString();
  }
  if (range === "7d") {
    return new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
  }
  if (range === "30d") {
    return new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  }
  return null;
}

function parseAgentFilter(input: string | null): string[] {
  if (!input) {
    return [];
  }
  const normalized = input.trim().toLowerCase();
  if (normalized.length === 0 || normalized === "all") {
    return [];
  }
  const out = new Set<string>();
  for (const value of normalized.split(",")) {
    const entry = value.trim();
    if (entry === "claude" || entry === "claude-code") {
      out.add("claude");
    } else if (entry === "codex" || entry === "gemini") {
      out.add(entry);
    }
  }
  return [...out];
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>ContextLedger Dashboard</title>
  <script>
    (function(){
      var t = localStorage.getItem('cl-theme');
      if (!t || t === 'auto') t = matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', t);
    })();
  </script>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7f4;
      --bg-gradient-start: #eef2ff;
      --card: #ffffff;
      --text: #1f2933;
      --muted: #64748b;
      --accent: #0b5fff;
      --border: #e2e8f0;
      --good: #166534;
      --bar-track: #e2e8f0;
      --chip-bg: #f1f5f9;
      --select-bg: #ffffff;
      --error-bg: #fef2f2;
      --error-border: #fecaca;
      --error-text: #991b1b;
      --header-bg: #0f172a;
    }
    [data-theme="dark"] {
      --bg: #0f172a;
      --bg-gradient-start: #0f172a;
      --card: #1e293b;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #6366f1;
      --border: #334155;
      --good: #4ade80;
      --bar-track: #334155;
      --chip-bg: #334155;
      --select-bg: #1e293b;
      --error-bg: #450a0a;
      --error-border: #7f1d1d;
      --error-text: #fca5a5;
    }
    html { background: var(--bg); }
    html.theme-transition, html.theme-transition * {
      transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease !important;
    }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      color: var(--text);
      background: linear-gradient(180deg, var(--bg-gradient-start) 0%, var(--bg) 30%);
    }
    .dashboard-header {
      background: var(--header-bg);
      padding: 16px 0;
    }
    .dashboard-header .header-inner {
      max-width: 1100px;
      margin: 0 auto;
      padding: 0 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .dashboard-header h1 { margin: 0; font-size: 22px; color: #f1f5f9; }
    .dashboard-header .subtitle { color: #94a3b8; font-size: 13px; margin-top: 2px; }
    .header-controls {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .theme-toggle {
      background: none;
      border: 1px solid #334155;
      border-radius: 8px;
      cursor: pointer;
      padding: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #94a3b8;
    }
    .theme-toggle:hover { border-color: #6366f1; color: #f1f5f9; }
    .theme-toggle svg { width: 18px; height: 18px; }
    .wrap {
      max-width: 1100px;
      margin: 20px auto;
      padding: 0 16px 32px;
    }
    .muted { color: var(--muted); }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin: 16px 0 20px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
    }
    .kpi-label { color: var(--muted); font-size: 12px; }
    .kpi-value { font-size: 24px; font-weight: 600; margin-top: 4px; }
    .panel {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px;
      margin-bottom: 12px;
    }
    .bar {
      height: 10px;
      border-radius: 999px;
      background: var(--bar-track);
      overflow: hidden;
      margin-top: 4px;
    }
    .bar > span {
      display: block;
      height: 100%;
      background: var(--accent);
    }
    .project-chip {
      display: inline-block;
      max-width: 280px;
      padding: 2px 8px;
      border-radius: 6px;
      background: var(--chip-bg);
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 12px;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      font-size: 13px;
    }
    th, td {
      border-bottom: 1px solid var(--border);
      padding: 8px 6px;
      text-align: left;
      vertical-align: top;
    }
    th { color: var(--muted); font-weight: 600; }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    select {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 8px;
      font-size: 14px;
      background: var(--select-bg);
      color: var(--text);
    }

    /* Session cards */
    .session-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 8px;
      cursor: pointer;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    }
    .session-card:hover { border-color: var(--accent); }
    .session-card.expanded {
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
    }
    [data-theme="dark"] .session-card.expanded {
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .session-card-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      flex-wrap: wrap;
    }
    .agent-pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .agent-pill.claude { background: #dbeafe; color: #1e40af; }
    .agent-pill.codex { background: #d1fae5; color: #065f46; }
    .agent-pill.gemini { background: #fef3c7; color: #92400e; }
    [data-theme="dark"] .agent-pill.claude { background: #1e3a5f; color: #93c5fd; }
    [data-theme="dark"] .agent-pill.codex { background: #064e3b; color: #6ee7b7; }
    [data-theme="dark"] .agent-pill.gemini { background: #78350f; color: #fde68a; }
    .intent-chip {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 12px;
      background: var(--chip-bg);
      color: var(--muted);
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      flex-shrink: 0;
    }
    .status-dot.active { background: #22c55e; }
    .status-dot.ended { background: var(--muted); }
    .session-meta {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 12px;
      color: var(--muted);
    }
    .capsule-icon {
      display: inline-flex;
      color: var(--muted);
      opacity: 0.5;
    }
    .capsule-icon.has-capsule { opacity: 1; color: var(--accent); }

    /* Session detail panel */
    .session-detail {
      display: none;
      padding: 0 14px 14px;
      border-top: 1px solid var(--border);
    }
    .session-card.expanded .session-detail { display: block; }
    .capsule-section { margin-top: 12px; }
    .capsule-section h4 {
      margin: 0 0 6px;
      font-size: 13px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .capsule-section ul {
      margin: 0;
      padding-left: 18px;
      font-size: 13px;
      line-height: 1.6;
    }
    .capsule-section pre {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--chip-bg);
      padding: 10px;
      border-radius: 8px;
    }
    .capsule-files {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.7;
    }
    .capsule-errors {
      background: var(--error-bg);
      border: 1px solid var(--error-border);
      border-radius: 8px;
      padding: 10px;
    }
    .capsule-errors ul { color: var(--error-text); }
    .capsule-spinner {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 16px 0;
      color: var(--muted);
      font-size: 13px;
    }
    .capsule-spinner::before {
      content: "";
      width: 16px;
      height: 16px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .no-capsule {
      color: var(--muted);
      font-size: 13px;
      padding: 12px 0;
      font-style: italic;
    }

    @media (max-width: 900px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .row { grid-template-columns: 1fr; }
      .session-card-header { gap: 6px; }
      .session-meta { margin-left: 0; width: 100%; justify-content: flex-end; }
    }
  </style>
</head>
<body>
  <div class="dashboard-header">
    <div class="header-inner">
      <div>
        <h1>ContextLedger</h1>
        <div class="subtitle">Local-first usage analytics and session memory</div>
      </div>
      <div class="header-controls">
        <label for="range" style="color:#94a3b8;font-size:13px">Range:</label>
        <select id="range" style="background:#1e293b;color:#f1f5f9;border-color:#334155">
          <option value="24h">24h</option>
          <option value="7d" selected>7d</option>
          <option value="30d">30d</option>
          <option value="all">all</option>
        </select>
        <label for="agent" style="color:#94a3b8;font-size:13px">Agent:</label>
        <select id="agent" style="background:#1e293b;color:#f1f5f9;border-color:#334155">
          <option value="all" selected>all</option>
          <option value="claude">claude</option>
          <option value="codex">codex</option>
          <option value="gemini">gemini</option>
        </select>
        <button class="theme-toggle" id="theme-toggle" title="Toggle theme">
          <svg id="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          <svg id="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
        </button>
      </div>
    </div>
  </div>

  <div class="wrap">
    <div id="kpis" class="grid"></div>

    <div class="row">
      <div class="panel">
        <h3 style="margin:0 0 8px">Time By Intent</h3>
        <div id="intent"></div>
      </div>
      <div class="panel">
        <h3 style="margin:0 0 8px">Tool Usage</h3>
        <div id="tools"></div>
      </div>
    </div>

    <div class="row">
      <div class="panel">
        <h3 style="margin:0 0 8px">Planning Vs Execution</h3>
        <div id="phase"></div>
      </div>
      <div class="panel">
        <h3 style="margin:0 0 8px">Time By Project</h3>
        <div id="projects"></div>
      </div>
    </div>

    <div class="row">
      <div class="panel">
        <h3 style="margin:0 0 8px">Recent Sessions</h3>
        <div id="sessions-list"></div>
      </div>
      <div class="panel">
        <h3 style="margin:0 0 8px">Resume Packs</h3>
        <table id="packs-table">
          <thead><tr><th>Title</th><th>Sessions</th><th>Budget</th><th>Created</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    /* --- Theme management --- */
    function getEffectiveTheme() {
      var stored = localStorage.getItem('cl-theme');
      if (stored === 'dark' || stored === 'light') return stored;
      return matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light';
    }

    function applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      var sunIcon = document.getElementById('icon-sun');
      var moonIcon = document.getElementById('icon-moon');
      if (sunIcon && moonIcon) {
        sunIcon.style.display = theme === 'dark' ? 'none' : 'block';
        moonIcon.style.display = theme === 'dark' ? 'block' : 'none';
      }
    }

    document.getElementById('theme-toggle').addEventListener('click', function() {
      document.documentElement.classList.add('theme-transition');
      var current = getEffectiveTheme();
      var next = current === 'dark' ? 'light' : 'dark';
      localStorage.setItem('cl-theme', next);
      applyTheme(next);
      setTimeout(function(){ document.documentElement.classList.remove('theme-transition'); }, 300);
    });

    matchMedia('(prefers-color-scheme:dark)').addEventListener('change', function() {
      var stored = localStorage.getItem('cl-theme');
      if (!stored || stored === 'auto') applyTheme(getEffectiveTheme());
    });

    applyTheme(getEffectiveTheme());

    /* --- Helpers --- */
    function fmt(value) { return Number(value).toLocaleString(); }
    function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    function projectLabel(path) {
      if (!path || path === "(unknown)") return "(unknown)";
      var normalized = String(path);
      var parts = normalized.split(/[\\\\/]/).filter(Boolean);
      if (parts.length >= 2) return parts.slice(-2).join("/");
      return normalized;
    }

    function relativeTime(isoStr) {
      if (!isoStr) return "";
      var diff = Date.now() - new Date(isoStr).getTime();
      var mins = Math.floor(diff / 60000);
      if (mins < 1) return "just now";
      if (mins < 60) return mins + "m ago";
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + "h ago";
      var days = Math.floor(hrs / 24);
      return days + "d ago";
    }

    /* --- Render functions --- */
    function renderKpis(summary) {
      var el = document.getElementById("kpis");
      var items = [
        { label: "Sessions", value: fmt(summary.sessions) },
        { label: "Active Minutes", value: fmt(summary.totalMinutes.toFixed(1)) },
        { label: "Events", value: fmt(summary.events) },
        { label: "Tool Calls", value: fmt(summary.toolCalls) },
      ];
      el.innerHTML = items.map(function(item) {
        return '<div class="card"><div class="kpi-label">' + item.label + '</div><div class="kpi-value">' + item.value + '</div></div>';
      }).join("");
    }

    function renderIntent(rows) {
      var el = document.getElementById("intent");
      var max = Math.max.apply(null, rows.map(function(r){ return r.totalMinutes; }).concat([1]));
      el.innerHTML = rows.map(function(row) {
        return '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;gap:8px"><div>' + esc(row.label) + '</div><div class="muted">' + row.totalMinutes.toFixed(1) + ' min</div></div><div class="bar"><span style="width:' + (row.totalMinutes / max * 100) + '%"></span></div></div>';
      }).join("");
    }

    function renderTools(rows) {
      var el = document.getElementById("tools");
      var view = rows.slice(0, 12);
      var max = Math.max.apply(null, view.map(function(r){ return r.calls; }).concat([1]));
      el.innerHTML = view.map(function(row) {
        return '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;gap:8px"><div>' + esc(row.toolName) + '</div><div class="muted">' + row.calls + ' calls</div></div><div class="bar"><span style="width:' + (row.calls / max * 100) + '%"></span></div></div>';
      }).join("");
    }

    function renderPhase(rows) {
      var el = document.getElementById("phase");
      var view = rows || [];
      if (view.length === 0) { el.innerHTML = '<div class="muted">No phase data</div>'; return; }
      var max = Math.max.apply(null, view.map(function(r){ return r.totalMinutes; }).concat([1]));
      el.innerHTML = view.map(function(row) {
        var color = row.phase === "execution" ? "#16a34a" : "#6366f1";
        return '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;gap:8px"><div>' + esc(row.phase) + '</div><div class="muted">' + row.totalMinutes.toFixed(1) + ' min (' + (row.share * 100).toFixed(0) + '%)</div></div><div class="bar"><span style="width:' + (row.totalMinutes / max * 100) + '%;background:' + color + '"></span></div></div>';
      }).join("");
    }

    function renderProjects(rows) {
      var el = document.getElementById("projects");
      var view = (rows || []).slice(0, 12);
      if (view.length === 0) { el.innerHTML = '<div class="muted">No project data</div>'; return; }
      var max = Math.max.apply(null, view.map(function(r){ return r.totalMinutes; }).concat([1]));
      el.innerHTML = view.map(function(row) {
        return '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;gap:8px"><div><span class="project-chip" title="' + esc(row.projectPath) + '">' + esc(projectLabel(row.projectPath)) + '</span></div><div class="muted">' + row.totalMinutes.toFixed(1) + ' min (' + row.sessions + ' sessions)</div></div><div class="bar"><span style="width:' + (row.totalMinutes / max * 100) + '%;background:#0ea5e9"></span></div></div>';
      }).join("");
    }

    /* --- Session cards + detail view --- */
    var capsuleCache = new Map();
    var expandedSessionId = null;

    function agentClass(agent) {
      var a = (agent || "").toLowerCase();
      if (a.includes("claude")) return "claude";
      if (a.includes("codex")) return "codex";
      if (a.includes("gemini")) return "gemini";
      return "claude";
    }

    function renderSessions(rows) {
      var el = document.getElementById("sessions-list");
      expandedSessionId = null;
      el.innerHTML = rows.slice(0, 30).map(function(row) {
        var agentCls = agentClass(row.agentKey || row.agent);
        var statusCls = row.status === "active" ? "active" : "ended";
        var capsuleCls = row.hasCapsule ? "has-capsule" : "";
        var capsuleSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/></svg>';
        return '<div class="session-card" data-id="' + esc(row.id) + '" data-has-capsule="' + (row.hasCapsule ? '1' : '0') + '">'
          + '<div class="session-card-header">'
          + '<span class="status-dot ' + statusCls + '"></span>'
          + '<span class="agent-pill ' + agentCls + '">' + esc(row.agentDisplay || row.agent) + '</span>'
          + '<span class="intent-chip">' + esc(row.intentLabel || "unlabeled") + '</span>'
          + '<span class="project-chip" title="' + esc(row.repoPath || "(unknown)") + '">' + esc(projectLabel(row.repoPath || "(unknown)")) + '</span>'
          + '<span class="session-meta">'
          + '<span>' + row.durationMinutes.toFixed(1) + ' min</span>'
          + '<span>' + relativeTime(row.startedAt) + '</span>'
          + '<span class="capsule-icon ' + capsuleCls + '">' + capsuleSvg + '</span>'
          + '</span>'
          + '</div>'
          + '<div class="session-detail" id="detail-' + esc(row.id) + '"></div>'
          + '</div>';
      }).join("");

      el.addEventListener("click", function(e) {
        var card = e.target.closest(".session-card");
        if (!card) return;
        toggleSessionDetail(card);
      });
    }

    function toggleSessionDetail(card) {
      var id = card.getAttribute("data-id");
      var hasCapsule = card.getAttribute("data-has-capsule") === "1";
      var detailEl = document.getElementById("detail-" + id);

      if (expandedSessionId === id) {
        card.classList.remove("expanded");
        expandedSessionId = null;
        return;
      }

      if (expandedSessionId) {
        var prev = document.querySelector('.session-card.expanded');
        if (prev) prev.classList.remove("expanded");
      }

      expandedSessionId = id;
      card.classList.add("expanded");

      if (capsuleCache.has(id)) {
        renderCapsuleDetail(detailEl, capsuleCache.get(id));
        return;
      }

      if (!hasCapsule) {
        detailEl.innerHTML = '<div class="no-capsule">No capsule data for this session</div>';
        capsuleCache.set(id, null);
        return;
      }

      detailEl.innerHTML = '<div class="capsule-spinner">Loading capsule...</div>';
      fetch("/api/session-capsule?id=" + encodeURIComponent(id))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) {
            detailEl.innerHTML = '<div class="no-capsule">' + esc(data.error) + '</div>';
            capsuleCache.set(id, null);
          } else {
            capsuleCache.set(id, data);
            renderCapsuleDetail(detailEl, data);
          }
        })
        .catch(function() {
          detailEl.innerHTML = '<div class="no-capsule">Failed to load capsule</div>';
        });
    }

    function renderCapsuleDetail(el, data) {
      if (!data) {
        el.innerHTML = '<div class="no-capsule">No capsule data for this session</div>';
        return;
      }
      var capsule = data.capsule;
      var html = '';

      if (capsule && capsule.summaryMarkdown) {
        html += '<div class="capsule-section"><h4>Summary</h4><pre>' + esc(capsule.summaryMarkdown) + '</pre></div>';
      }
      if (capsule && capsule.decisions && capsule.decisions.length) {
        html += '<div class="capsule-section"><h4>Decisions</h4><ul>' + capsule.decisions.map(function(d){ return '<li>' + esc(d) + '</li>'; }).join('') + '</ul></div>';
      }
      if (capsule && capsule.todos && capsule.todos.length) {
        html += '<div class="capsule-section"><h4>Todos</h4><ul>' + capsule.todos.map(function(t){ return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>';
      }
      if (capsule && capsule.files && capsule.files.length) {
        var files = capsule.files;
        var shown = files.slice(0, 15);
        var extra = files.length - 15;
        html += '<div class="capsule-section"><h4>Files</h4><div class="capsule-files">' + shown.map(function(f){ return esc(f); }).join('<br>') + (extra > 0 ? '<br><span class="muted">+' + extra + ' more</span>' : '') + '</div></div>';
      }
      if (capsule && capsule.errors && capsule.errors.length) {
        html += '<div class="capsule-section"><div class="capsule-errors"><h4 style="color:var(--error-text);margin:0 0 6px">Errors</h4><ul>' + capsule.errors.map(function(e){ return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div></div>';
      }
      if (data.taskBreakdown && data.taskBreakdown.length) {
        html += '<div class="capsule-section"><h4>Tasks</h4><ul>' + data.taskBreakdown.map(function(t){ return '<li>' + esc(t.label) + ' <span class="muted">(' + t.minutes.toFixed(1) + ' min)</span></li>'; }).join('') + '</ul></div>';
      }
      if (!html) {
        html = '<div class="no-capsule">No capsule data for this session</div>';
      }
      el.innerHTML = html;
    }

    function renderPacks(rows) {
      var tbody = document.querySelector("#packs-table tbody");
      tbody.innerHTML = rows.slice(0, 20).map(function(row) {
        return '<tr><td>' + esc(row.title) + '</td><td>' + row.sourceSessionIds.length + '</td><td>' + row.tokenBudget + '</td><td>' + esc(row.createdAt) + '</td></tr>';
      }).join("");
    }

    async function load(range, agent) {
      var agentQuery = agent && agent !== "all"
        ? '&agent=' + encodeURIComponent(agent)
        : '';

      capsuleCache.clear();

      var statsRes = await fetch('/api/stats?range=' + encodeURIComponent(range) + agentQuery);
      var stats = await statsRes.json();
      renderKpis(stats.summary);
      renderIntent(stats.byIntent);
      renderTools(stats.byTool);
      renderPhase(stats.byPhase);
      renderProjects(stats.byProject);

      var sessionsRes = await fetch('/api/sessions?limit=40&range=' + encodeURIComponent(range) + agentQuery);
      var sessions = await sessionsRes.json();
      renderSessions(sessions);

      var packsRes = await fetch('/api/resume-packs?limit=20');
      var packs = await packsRes.json();
      renderPacks(packs);
    }

    var rangeEl = document.getElementById("range");
    var agentEl = document.getElementById("agent");
    var reload = function() { return load(rangeEl.value, agentEl.value); };
    rangeEl.addEventListener("change", reload);
    agentEl.addEventListener("change", reload);
    reload().catch(function(err) {
      console.error(err);
      alert("Failed to load dashboard data. Check terminal logs.");
    });
  </script>
</body>
</html>`;
}

export function startDashboardServer(options: {
  port: number;
  dataDir?: string;
}): Promise<ReturnType<typeof createServer>> {
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = reqUrl.pathname;
    const range = reqUrl.searchParams.get("range") ?? "7d";
    const sinceIso = parseRangeToSince(range);
    const agentFilter = parseAgentFilter(reqUrl.searchParams.get("agent"));

    try {
      if (pathname === "/healthz") {
        json(res, 200, { ok: true });
        return;
      }

      if (pathname === "/api/stats") {
        json(res, 200, getUsageStats(range, sinceIso, options.dataDir, agentFilter));
        return;
      }

      if (pathname === "/api/sessions") {
        const limit = Number(reqUrl.searchParams.get("limit") ?? "50");
        const rows = listSessions(
          {
            limit: Number.isFinite(limit) ? Math.max(1, Math.min(1000, limit)) : 50,
            sinceIso,
            agentFilter,
          },
          options.dataDir,
        );
        json(res, 200, rows);
        return;
      }

      if (pathname === "/api/session-capsule") {
        const sessionId = reqUrl.searchParams.get("id");
        if (!sessionId) {
          json(res, 400, { error: "Missing id parameter" });
          return;
        }
        const contexts = loadResumeSessionContexts([sessionId], options.dataDir);
        if (contexts.length === 0) {
          json(res, 404, { error: "Session not found" });
          return;
        }
        const ctx = contexts[0];
        json(res, 200, {
          capsule: ctx.capsule,
          prompts: ctx.prompts,
          taskBreakdown: ctx.taskBreakdown,
        });
        return;
      }

      if (pathname === "/api/resume-packs") {
        const limit = Number(reqUrl.searchParams.get("limit") ?? "20");
        const rows = listResumePacks(
          Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 20,
          options.dataDir,
        );
        json(res, 200, rows);
        return;
      }

      if (pathname === "/") {
        html(res, dashboardHtml());
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { error: message });
    }
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve(server);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, "127.0.0.1");
  });
}
