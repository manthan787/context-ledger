import { spawnSync } from "node:child_process";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { getUsageStats, listActiveSessions, listResumePacks, listSessions, loadResumeSessionContexts } from "../storage/analytics";

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
    } else if (entry === "codex") {
      out.add(entry);
    } else if (entry === "gemini") {
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
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
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
      --bg: #fafbfc;
      --bg-gradient-start: #eef2ff;
      --card: #ffffff;
      --text: #18181b;
      --muted: #71717a;
      --accent: #6366f1;
      --accent-light: #a5b4fc;
      --border: #e4e4e7;
      --good: #166534;
      --bar-track: #e4e4e7;
      --chip-bg: #f4f4f5;
      --select-bg: #ffffff;
      --error-bg: #fef2f2;
      --error-border: #fecaca;
      --error-text: #991b1b;
      --header-bg: #18181b;
      --agent-claude: #6366f1;
      --agent-codex: #10b981;
      --agent-gemini: #f59e0b;
      --agent-claude-bg: rgba(99,102,241,0.12);
      --agent-codex-bg: rgba(16,185,129,0.12);
      --agent-gemini-bg: rgba(245,158,11,0.12);
      --hover-glow: 0 0 0 1px rgba(99,102,241,0.3);
    }
    [data-theme="dark"] {
      --bg: #09090b;
      --bg-gradient-start: #0f0f23;
      --card: #18181b;
      --text: #fafafa;
      --muted: #a1a1aa;
      --accent: #818cf8;
      --accent-light: #6366f1;
      --border: #27272a;
      --good: #4ade80;
      --bar-track: #27272a;
      --chip-bg: #27272a;
      --select-bg: #18181b;
      --error-bg: #450a0a;
      --error-border: #7f1d1d;
      --error-text: #fca5a5;
      --header-bg: #09090b;
      --agent-claude-bg: rgba(99,102,241,0.2);
      --agent-codex-bg: rgba(16,185,129,0.2);
      --agent-gemini-bg: rgba(245,158,11,0.2);
      --hover-glow: 0 0 0 1px rgba(129,140,248,0.4);
    }
    html { background: var(--bg); }
    html.theme-transition, html.theme-transition * {
      transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease !important;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      color: var(--text);
      background: linear-gradient(180deg, var(--bg-gradient-start) 0%, var(--bg) 20%);
      -webkit-font-smoothing: antialiased;
    }

    /* Header */
    .dashboard-header {
      background: var(--header-bg);
      padding: 14px 0;
      position: sticky;
      top: 0;
      z-index: 100;
      border-bottom: 1px solid var(--border);
    }
    .dashboard-header .header-inner {
      max-width: 1280px;
      margin: 0 auto;
      padding: 0 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .dashboard-header h1 { margin: 0; font-size: 20px; color: #fafafa; font-weight: 700; letter-spacing: -0.02em; }
    .dashboard-header .subtitle { color: #a1a1aa; font-size: 12px; margin-top: 1px; }
    .header-controls { display: flex; align-items: center; gap: 8px; }
    .header-controls label { color: #a1a1aa; font-size: 12px; font-weight: 500; }
    .header-controls select {
      background: #27272a; color: #fafafa; border: 1px solid #3f3f46;
      border-radius: 6px; padding: 5px 8px; font-size: 13px;
    }
    .theme-toggle {
      background: none; border: 1px solid #3f3f46; border-radius: 6px;
      cursor: pointer; padding: 5px; display: flex; align-items: center;
      justify-content: center; color: #a1a1aa;
    }
    .theme-toggle:hover { border-color: var(--accent); color: #fafafa; }
    .theme-toggle svg { width: 16px; height: 16px; }

    /* Grid system */
    .wrap {
      max-width: 1280px;
      margin: 0 auto;
      padding: 20px 24px 40px;
    }
    .grid-row {
      display: grid;
      gap: 14px;
      margin-bottom: 14px;
    }
    .grid-4 { grid-template-columns: repeat(4, 1fr); }
    .grid-8-4 { grid-template-columns: 2fr 1fr; }
    .grid-3 { grid-template-columns: repeat(3, 1fr); }
    .grid-12 { grid-template-columns: 1fr; }
    .grid-6-6 { grid-template-columns: 1fr 1fr; }
    .grid-4-4-4 { grid-template-columns: 1fr 1fr 1fr; }

    /* Cards */
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      animation: fadeIn 0.3s ease both;
    }
    .card:hover { box-shadow: var(--hover-glow); }
    .panel-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin: 0 0 12px;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

    /* KPI cards */
    .kpi-card { position: relative; overflow: hidden; }
    .kpi-label { color: var(--muted); font-size: 12px; font-weight: 500; }
    .kpi-value { font-size: 28px; font-weight: 700; margin-top: 2px; letter-spacing: -0.02em; }
    .kpi-sparkline { position: absolute; bottom: 8px; right: 12px; opacity: 0.6; }

    /* Live sidebar */
    .live-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #22c55e;
      animation: pulse 2s ease-in-out infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .sidebar-toggle {
      background: none; border: 1px solid #3f3f46; border-radius: 6px;
      cursor: pointer; padding: 5px 10px; display: none; align-items: center;
      gap: 6px; color: #a1a1aa; font-size: 13px; font-weight: 600;
    }
    .sidebar-toggle.visible { display: flex; }
    .sidebar-toggle:hover { border-color: var(--accent); color: #fafafa; }
    .sidebar-toggle .live-dot { width: 6px; height: 6px; }
    .sidebar-toggle .badge {
      background: #22c55e; color: #fff; border-radius: 999px;
      font-size: 11px; font-weight: 700; min-width: 18px; height: 18px;
      display: flex; align-items: center; justify-content: center; padding: 0 5px;
    }
    .live-sidebar {
      position: fixed; right: 0; top: 50px; width: 320px; height: calc(100vh - 50px);
      background: var(--card); border-left: 1px solid var(--border);
      z-index: 90; transform: translateX(100%); transition: transform 0.25s ease;
      overflow-y: auto; padding: 16px;
      scrollbar-width: thin; scrollbar-color: var(--border) transparent;
    }
    .live-sidebar::-webkit-scrollbar { width: 6px; }
    .live-sidebar::-webkit-scrollbar-track { background: transparent; }
    .live-sidebar::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
    .live-sidebar::-webkit-scrollbar-thumb:hover { background: var(--muted); }
    .live-sidebar.open { transform: translateX(0); }
    .sidebar-backdrop {
      position: fixed; inset: 0; top: 50px; background: rgba(0,0,0,0.3);
      z-index: 89; display: none;
    }
    .sidebar-backdrop.visible { display: block; }
    .live-sidebar-header {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 12px; font-size: 14px; font-weight: 600; color: var(--text);
    }
    .live-sidebar-header .close-sidebar {
      margin-left: auto; background: none; border: none; cursor: pointer;
      color: var(--muted); font-size: 18px; padding: 0 4px; line-height: 1;
    }
    .live-sidebar-header .close-sidebar:hover { color: var(--text); }
    .live-sessions-col {
      display: flex; flex-direction: column; gap: 10px;
    }
    .live-session-card {
      background: var(--chip-bg);
      border-left: 3px solid #22c55e;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 12px;
    }
    .live-session-card .ls-agent {
      display: flex; align-items: center; gap: 6px;
      font-weight: 600; margin-bottom: 4px;
    }
    .live-session-card .ls-agent .agent-dot {
      width: 6px; height: 6px; border-radius: 50%;
    }
    .live-session-card .ls-timer { color: var(--accent); font-weight: 600; font-variant-numeric: tabular-nums; }
    .live-session-card .ls-detail { color: var(--muted); margin-top: 2px; }

    /* Agent comparison */
    .agent-compare-card {
      border-top: 3px solid var(--border);
      text-align: center;
    }
    .agent-compare-card.claude-border { border-top-color: var(--agent-claude); }
    .agent-compare-card.codex-border { border-top-color: var(--agent-codex); }
    .agent-compare-card.gemini-border { border-top-color: var(--agent-gemini); }
    .agent-compare-name { font-size: 16px; font-weight: 700; margin-bottom: 12px; }
    .agent-stat-row {
      display: flex; justify-content: space-between;
      padding: 6px 0; border-bottom: 1px solid var(--border);
      font-size: 13px;
    }
    .agent-stat-row:last-child { border-bottom: none; }
    .agent-stat-label { color: var(--muted); }
    .agent-stat-value { font-weight: 600; }

    /* Heatmap */
    .heatmap-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 3px;
    }
    .heatmap-cell {
      aspect-ratio: 1;
      border-radius: 3px;
      background: var(--bar-track);
      min-height: 14px;
    }
    .heatmap-day-labels {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 3px;
      margin-bottom: 4px;
    }
    .heatmap-day-labels span {
      font-size: 10px;
      color: var(--muted);
      text-align: center;
    }

    /* Chart containers */
    .chart-wrap { position: relative; width: 100%; }
    .chart-wrap canvas { width: 100% !important; }

    .muted { color: var(--muted); }

    /* Tables */
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border-bottom: 1px solid var(--border); padding: 8px 6px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }

    /* Session cards */
    .session-card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      margin-bottom: 8px;
      cursor: pointer;
      border-left: 3px solid var(--border);
    }
    .session-card.agent-claude { border-left-color: var(--agent-claude); }
    .session-card.agent-codex { border-left-color: var(--agent-codex); }
    .session-card.agent-gemini { border-left-color: var(--agent-gemini); }
    .session-card:hover { box-shadow: var(--hover-glow); }
    .session-card.expanded { box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
    [data-theme="dark"] .session-card.expanded { box-shadow: 0 4px 16px rgba(0,0,0,0.4); }
    .session-card-header {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px; flex-wrap: wrap;
    }
    .agent-pill {
      display: inline-block; padding: 2px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em;
    }
    .agent-pill.claude { background: var(--agent-claude-bg); color: var(--agent-claude); }
    .agent-pill.codex { background: var(--agent-codex-bg); color: var(--agent-codex); }
    .agent-pill.gemini { background: var(--agent-gemini-bg); color: var(--agent-gemini); }
    .intent-chip {
      display: inline-block; padding: 2px 8px; border-radius: 6px;
      font-size: 12px; background: var(--chip-bg); color: var(--muted);
    }
    .project-chip {
      display: inline-block; max-width: 280px; padding: 2px 8px;
      border-radius: 6px; background: var(--chip-bg); color: var(--muted);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px;
    }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
    .status-dot.active { background: #22c55e; animation: pulse 2s ease-in-out infinite; }
    .status-dot.ended { background: var(--muted); }
    .session-meta {
      margin-left: auto; display: flex; align-items: center;
      gap: 12px; font-size: 12px; color: var(--muted);
    }
    .capsule-icon { display: inline-flex; color: var(--muted); opacity: 0.5; }
    .capsule-icon.has-capsule { opacity: 1; color: var(--accent); }
    .session-detail { display: none; padding: 0 14px 14px; border-top: 1px solid var(--border); }
    .session-card.expanded .session-detail { display: block; }
    .capsule-section { margin-top: 12px; }
    .capsule-section h4 { margin: 0 0 6px; font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    .capsule-section ul { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.6; }
    .capsule-section pre {
      margin: 0; font-size: 13px; line-height: 1.5; white-space: pre-wrap;
      word-break: break-word; background: var(--chip-bg); padding: 10px; border-radius: 8px;
    }
    .capsule-files { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.7; }
    .capsule-errors { background: var(--error-bg); border: 1px solid var(--error-border); border-radius: 8px; padding: 10px; }
    .capsule-errors ul { color: var(--error-text); }
    .capsule-spinner { display: flex; align-items: center; gap: 8px; padding: 16px 0; color: var(--muted); font-size: 13px; }
    .capsule-spinner::before {
      content: ""; width: 16px; height: 16px; border: 2px solid var(--border);
      border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .no-capsule { color: var(--muted); font-size: 13px; padding: 12px 0; font-style: italic; }
    select {
      border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px;
      font-size: 14px; background: var(--select-bg); color: var(--text);
    }

    @media (max-width: 1024px) {
      .grid-4 { grid-template-columns: repeat(2, 1fr); }
      .grid-3 { grid-template-columns: 1fr; }
      .grid-3 [style*="grid-column:span 2"],
      .grid-3 [style*="grid-column: span 2"] { grid-column: span 1; }
      .grid-8-4 { grid-template-columns: 1fr; }
      .grid-6-6 { grid-template-columns: 1fr; }
      .grid-4-4-4 { grid-template-columns: 1fr; }
    }
    /* Handoff button */
    .handoff-btn {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border);
      background: var(--chip-bg); color: var(--muted); font-size: 11px; font-weight: 600;
      cursor: pointer; white-space: nowrap; transition: all 0.15s ease;
    }
    .handoff-btn:hover { border-color: var(--accent); color: var(--accent); box-shadow: 0 0 0 2px rgba(99,102,241,0.15); }
    .handoff-btn:active { transform: scale(0.96); }
    .handoff-btn.launching { opacity: 0.6; pointer-events: none; }
    .handoff-btn svg { width: 12px; height: 12px; flex-shrink: 0; }

    /* Handoff agent picker */
    .handoff-popover {
      position: absolute; z-index: 50; right: 0; top: 100%;
      margin-top: 4px; background: var(--card); border: 1px solid var(--border);
      border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.15);
      padding: 6px; min-width: 150px; animation: fadeIn 0.15s ease;
    }
    [data-theme="dark"] .handoff-popover { box-shadow: 0 8px 24px rgba(0,0,0,0.4); }
    .handoff-popover-title {
      font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase;
      letter-spacing: 0.04em; padding: 4px 8px 6px; border-bottom: 1px solid var(--border); margin-bottom: 4px;
    }
    .handoff-agent-option {
      display: flex; align-items: center; gap: 8px; width: 100%;
      padding: 7px 8px; border: none; background: none; border-radius: 6px;
      cursor: pointer; font-size: 13px; font-weight: 500; color: var(--text);
      transition: background 0.1s ease;
    }
    .handoff-agent-option:hover { background: var(--chip-bg); }
    .handoff-agent-option .agent-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .session-meta { position: relative; }

    @media (max-width: 640px) {
      .grid-4 { grid-template-columns: 1fr; }
      .wrap { padding: 12px 12px 32px; }
      .session-card-header { gap: 6px; }
      .session-meta { margin-left: 0; width: 100%; justify-content: flex-end; }
    }
  </style>
</head>
<body>
  <!-- Row 0: Header -->
  <div class="dashboard-header">
    <div class="header-inner">
      <div>
        <h1>ContextLedger</h1>
        <div class="subtitle">Local-first usage analytics and session memory</div>
      </div>
      <div class="header-controls">
        <label for="range">Range</label>
        <select id="range">
          <option value="24h">24h</option>
          <option value="7d" selected>7d</option>
          <option value="30d">30d</option>
          <option value="all">All</option>
        </select>
        <label for="agent">Agent</label>
        <select id="agent">
          <option value="all" selected>All</option>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
          <option value="gemini">Gemini</option>
        </select>
        <button class="sidebar-toggle" id="sidebar-toggle" title="Active sessions">
          <span class="live-dot"></span>
          <span class="badge" id="sidebar-badge">0</span>
        </button>
        <button class="theme-toggle" id="theme-toggle" title="Toggle theme">
          <svg id="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          <svg id="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
        </button>
      </div>
    </div>
  </div>

  <div class="wrap">
    <!-- Row 1: KPI Cards -->
    <div class="grid-row grid-4" id="kpis"></div>

    <!-- Row 2: Activity Timeline (2 cols) + Agent Donut (1 col) -->
    <div class="grid-row grid-3">
      <div class="card" style="grid-column:span 2">
        <div class="panel-title">Activity Timeline</div>
        <div class="chart-wrap"><canvas id="chart-timeline" height="140"></canvas></div>
      </div>
      <div class="card">
        <div class="panel-title">Sessions by Agent</div>
        <div class="chart-wrap" style="max-width:180px;margin:0 auto"><canvas id="chart-agent-donut" height="180"></canvas></div>
      </div>
    </div>

    <!-- Row 3: Agent Comparison (1 col each) + Heatmap (1 col) -->
    <div class="grid-row grid-3">
      <div id="agent-compare-row" style="display:none;grid-column:span 2"></div>
      <div class="card">
        <div class="panel-title">Activity Heatmap</div>
        <div id="heatmap-container"></div>
      </div>
    </div>

    <!-- Row 5: Intent + Tools -->
    <div class="grid-row grid-6-6">
      <div class="card">
        <div class="panel-title">Intent Distribution</div>
        <div class="chart-wrap"><canvas id="chart-intent" height="250"></canvas></div>
      </div>
      <div class="card">
        <div class="panel-title">Tool Usage</div>
        <div class="chart-wrap"><canvas id="chart-tools" height="250"></canvas></div>
      </div>
    </div>

    <!-- Row 6: Phase Donut + Projects -->
    <div class="grid-row grid-6-6">
      <div class="card">
        <div class="panel-title">Planning vs Execution</div>
        <div class="chart-wrap" style="max-width:200px;margin:0 auto"><canvas id="chart-phase" height="200"></canvas></div>
      </div>
      <div class="card">
        <div class="panel-title">Top Projects</div>
        <div class="chart-wrap"><canvas id="chart-projects" height="200"></canvas></div>
      </div>
    </div>

    <!-- Row 7: Recent Sessions -->
    <div class="grid-row grid-12">
      <div class="card">
        <div class="panel-title">Recent Sessions</div>
        <div id="sessions-list"></div>
      </div>
    </div>

    <!-- Row 8: Resume Packs -->
    <div class="grid-row grid-12">
      <div class="card">
        <div class="panel-title">Resume Packs</div>
        <table id="packs-table">
          <thead><tr><th>Title</th><th>Sessions</th><th>Budget</th><th>Created</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Live Sessions Sidebar -->
  <div class="sidebar-backdrop" id="sidebar-backdrop"></div>
  <div class="live-sidebar" id="live-sidebar">
    <div class="live-sidebar-header">
      <span class="live-dot"></span>
      <span id="live-count">0</span> Active Session(s)
      <button class="close-sidebar" id="close-sidebar">&times;</button>
    </div>
    <div class="live-sessions-col" id="live-sessions-col"></div>
  </div>

  <script>
    /* ========== Theme ========== */
    function getEffectiveTheme() {
      var s = localStorage.getItem('cl-theme');
      if (s === 'dark' || s === 'light') return s;
      return matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light';
    }
    function applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme);
      var sun = document.getElementById('icon-sun');
      var moon = document.getElementById('icon-moon');
      if (sun && moon) { sun.style.display = theme === 'dark' ? 'none' : 'block'; moon.style.display = theme === 'dark' ? 'block' : 'none'; }
    }
    document.getElementById('theme-toggle').addEventListener('click', function() {
      document.documentElement.classList.add('theme-transition');
      var next = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
      localStorage.setItem('cl-theme', next);
      applyTheme(next);
      setTimeout(function(){ document.documentElement.classList.remove('theme-transition'); }, 300);
    });
    matchMedia('(prefers-color-scheme:dark)').addEventListener('change', function() {
      var s = localStorage.getItem('cl-theme');
      if (!s || s === 'auto') applyTheme(getEffectiveTheme());
    });
    applyTheme(getEffectiveTheme());

    /* ========== Helpers ========== */
    function fmt(v) { return Number(v).toLocaleString(); }
    function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    function projectLabel(path) {
      if (!path || path === '(unknown)') return '(unknown)';
      var parts = String(path).split(/[\\\\/]/).filter(Boolean);
      return parts.length >= 2 ? parts.slice(-2).join('/') : String(path);
    }
    function relativeTime(iso) {
      if (!iso) return '';
      var diff = Date.now() - new Date(iso).getTime();
      var mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      return Math.floor(hrs / 24) + 'd ago';
    }
    function isDark() { return getEffectiveTheme() === 'dark'; }
    var AGENT_COLORS = { claude: '#6366f1', codex: '#10b981', gemini: '#f59e0b' };
    function agentColor(key) { return AGENT_COLORS[key] || '#6366f1'; }
    function chartTextColor() { return isDark() ? '#a1a1aa' : '#71717a'; }
    function chartGridColor() { return isDark() ? 'rgba(63,63,70,0.5)' : 'rgba(228,228,231,0.8)'; }

    /* ========== Chart Instance Tracker ========== */
    var charts = {};
    function destroyChart(key) { if (charts[key]) { charts[key].destroy(); delete charts[key]; } }

    /* ========== Chart.js Defaults ========== */
    function setChartDefaults() {
      Chart.defaults.color = chartTextColor();
      Chart.defaults.borderColor = chartGridColor();
      Chart.defaults.font.family = "ui-sans-serif, system-ui, -apple-system, sans-serif";
      Chart.defaults.font.size = 11;
      Chart.defaults.plugins.legend.display = false;
      Chart.defaults.plugins.tooltip.backgroundColor = isDark() ? '#27272a' : '#18181b';
      Chart.defaults.plugins.tooltip.titleColor = '#fafafa';
      Chart.defaults.plugins.tooltip.bodyColor = '#d4d4d8';
      Chart.defaults.plugins.tooltip.cornerRadius = 8;
      Chart.defaults.plugins.tooltip.padding = 8;
    }

    /* ========== KPI Sparklines ========== */
    function drawSparkline(canvasId, values, color) {
      var c = document.getElementById(canvasId);
      if (!c || !values || values.length < 2) return;
      var ctx = c.getContext('2d');
      var w = c.width, h = c.height;
      ctx.clearRect(0, 0, w, h);
      var max = Math.max.apply(null, values) || 1;
      var min = Math.min.apply(null, values);
      var range = max - min || 1;
      var step = w / (values.length - 1);
      ctx.beginPath();
      ctx.strokeStyle = color || '#6366f1';
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      for (var i = 0; i < values.length; i++) {
        var x = i * step;
        var y = h - ((values[i] - min) / range) * (h - 4) - 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    var kpisInitialized = false;
    function renderKpis(summary, byDay) {
      var el = document.getElementById('kpis');
      var last7 = (byDay || []).slice(-7);
      var items = [
        { label: 'Sessions', value: fmt(summary.sessions), spark: last7.map(function(d){return d.sessions;}), color: '#6366f1' },
        { label: 'Active Minutes', value: fmt(summary.totalMinutes.toFixed(1)), spark: last7.map(function(d){return d.totalMinutes;}), color: '#10b981' },
        { label: 'Events', value: fmt(summary.events), spark: null, color: '#f59e0b' },
        { label: 'Tool Calls', value: fmt(summary.toolCalls), spark: null, color: '#ec4899' },
      ];
      if (!kpisInitialized) {
        el.innerHTML = items.map(function(item, idx) {
          var sparkId = 'sparkline-' + idx;
          var sparkHtml = item.spark ? '<canvas id="' + sparkId + '" class="kpi-sparkline" width="60" height="24"></canvas>' : '';
          return '<div class="card kpi-card" style="animation-delay:' + (idx * 0.05) + 's">'
            + '<div class="kpi-label">' + item.label + '</div>'
            + '<div class="kpi-value" id="kpi-val-' + idx + '">' + item.value + '</div>'
            + sparkHtml + '</div>';
        }).join('');
        kpisInitialized = true;
      } else {
        items.forEach(function(item, idx) {
          var valEl = document.getElementById('kpi-val-' + idx);
          if (valEl && valEl.textContent !== item.value) valEl.textContent = item.value;
        });
      }
      items.forEach(function(item, idx) {
        if (item.spark) drawSparkline('sparkline-' + idx, item.spark, item.color);
      });
    }

    /* ========== Chart In-Place Update Helper ========== */
    function updateChartData(key, labels, datasets) {
      var chart = charts[key];
      if (!chart) return false;
      chart.data.labels = labels;
      for (var i = 0; i < datasets.length; i++) {
        if (chart.data.datasets[i]) {
          chart.data.datasets[i].data = datasets[i].data;
          if (datasets[i].backgroundColor) chart.data.datasets[i].backgroundColor = datasets[i].backgroundColor;
        }
      }
      // remove extra datasets if count changed
      if (chart.data.datasets.length !== datasets.length) return false;
      chart.update('none');
      return true;
    }

    /* ========== Activity Timeline (stacked area) ========== */
    function renderTimeline(byAgentByDay) {
      setChartDefaults();
      var ctx = document.getElementById('chart-timeline');
      if (!ctx) return;
      var dayMap = {};
      (byAgentByDay || []).forEach(function(r) {
        if (!dayMap[r.day]) dayMap[r.day] = {};
        dayMap[r.day][r.agentKey] = (dayMap[r.day][r.agentKey] || 0) + r.totalMinutes;
      });
      var days = Object.keys(dayMap).sort();
      var agents = Object.keys(AGENT_COLORS);
      var datasets = agents.map(function(agent) {
        return {
          label: agent.charAt(0).toUpperCase() + agent.slice(1),
          data: days.map(function(d) { return (dayMap[d] && dayMap[d][agent]) || 0; }),
          borderColor: agentColor(agent),
          backgroundColor: agentColor(agent) + '33',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          pointHoverRadius: 4,
        };
      }).filter(function(ds) { return ds.data.some(function(v){return v > 0;}); });
      var labels = days.map(function(d){return d.slice(5);});
      if (updateChartData('timeline', labels, datasets)) return;
      destroyChart('timeline');
      charts.timeline = new Chart(ctx, {
        type: 'line',
        data: { labels: labels, datasets: datasets },
        options: {
          responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
          plugins: { legend: { display: datasets.length > 1, position: 'top', labels: { boxWidth: 12, padding: 8 } },
            tooltip: { callbacks: { label: function(c) { return c.dataset.label + ': ' + c.parsed.y.toFixed(1) + ' min'; } } }
          },
          scales: {
            x: { grid: { display: false }, ticks: { maxRotation: 0 } },
            y: { beginAtZero: true, grid: { color: chartGridColor() }, ticks: { callback: function(v){return v + 'm';} } }
          }
        }
      });
    }

    /* ========== Agent Donut ========== */
    function renderAgentDonut(byAgent) {
      setChartDefaults();
      var ctx = document.getElementById('chart-agent-donut');
      if (!ctx || !byAgent || byAgent.length === 0) return;
      var total = byAgent.reduce(function(a,r){return a+r.sessions;},0);
      var labels = byAgent.map(function(r){return r.agentDisplay;});
      var data = byAgent.map(function(r){return r.sessions;});
      var bgColors = byAgent.map(function(r){return agentColor(r.agentKey);});
      if (charts.agentDonut) {
        charts.agentDonut._centerTotal = total;
        updateChartData('agentDonut', labels, [{ data: data, backgroundColor: bgColors }]);
        return;
      }
      charts.agentDonut = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: byAgent.map(function(r){return r.agentDisplay;}),
          datasets: [{
            data: byAgent.map(function(r){return r.sessions;}),
            backgroundColor: byAgent.map(function(r){return agentColor(r.agentKey);}),
            borderWidth: 0, hoverOffset: 6
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '70%',
          plugins: {
            legend: { display: true, position: 'bottom', labels: { boxWidth: 10, padding: 6 } },
            tooltip: { callbacks: { label: function(c) { return c.label + ': ' + c.parsed + ' sessions'; } } }
          }
        },
        plugins: [{
          id: 'centerText',
          afterDraw: function(chart) {
            var ctx2 = chart.ctx;
            var w = chart.chartArea.left + (chart.chartArea.right - chart.chartArea.left) / 2;
            var h = chart.chartArea.top + (chart.chartArea.bottom - chart.chartArea.top) / 2;
            ctx2.save();
            ctx2.font = 'bold 22px ui-sans-serif, system-ui, sans-serif';
            ctx2.fillStyle = chartTextColor();
            ctx2.textAlign = 'center';
            ctx2.textBaseline = 'middle';
            ctx2.fillText(chart._centerTotal || total, w, h);
            ctx2.restore();
          }
        }]
      });
    }

    /* ========== Intent Chart ========== */
    function renderIntentChart(rows) {
      setChartDefaults();
      var ctx = document.getElementById('chart-intent');
      if (!ctx) return;
      var view = (rows || []).slice(0, 10);
      var labels = view.map(function(r){return r.label;});
      var data = view.map(function(r){return r.totalMinutes;});
      if (updateChartData('intent', labels, [{ data: data }])) return;
      destroyChart('intent');
      charts.intent = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: view.map(function(r){return r.label;}),
          datasets: [{
            data: view.map(function(r){return r.totalMinutes;}),
            backgroundColor: '#6366f1', borderRadius: 4, barPercentage: 0.7
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, indexAxis: 'y',
          plugins: { tooltip: { callbacks: { label: function(c){return c.parsed.x.toFixed(1) + ' min';} } } },
          scales: {
            x: { beginAtZero: true, grid: { color: chartGridColor() }, ticks: { callback: function(v){return v + 'm';} } },
            y: { grid: { display: false } }
          }
        }
      });
    }

    /* ========== Tools Chart ========== */
    function renderToolsChart(rows) {
      setChartDefaults();
      var ctx = document.getElementById('chart-tools');
      if (!ctx) return;
      var view = (rows || []).slice(0, 10);
      var labels = view.map(function(r){return r.toolName;});
      var data = view.map(function(r){return r.calls;});
      if (updateChartData('tools', labels, [{ data: data }])) return;
      destroyChart('tools');
      charts.tools = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: view.map(function(r){return r.toolName;}),
          datasets: [{
            data: view.map(function(r){return r.calls;}),
            backgroundColor: '#10b981', borderRadius: 4, barPercentage: 0.7
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, indexAxis: 'y',
          plugins: { tooltip: { callbacks: { label: function(c){return c.parsed.x + ' calls';} } } },
          scales: {
            x: { beginAtZero: true, grid: { color: chartGridColor() } },
            y: { grid: { display: false } }
          }
        }
      });
    }

    /* ========== Phase Donut ========== */
    function renderPhaseDonut(byPhase) {
      setChartDefaults();
      var ctx = document.getElementById('chart-phase');
      if (!ctx || !byPhase || byPhase.length === 0) return;
      var labels = byPhase.map(function(r){return r.phase.charAt(0).toUpperCase()+r.phase.slice(1);});
      var data = byPhase.map(function(r){return r.totalMinutes;});
      if (updateChartData('phase', labels, [{ data: data }])) return;
      destroyChart('phase');
      charts.phase = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: byPhase.map(function(r){return r.phase.charAt(0).toUpperCase()+r.phase.slice(1);}),
          datasets: [{
            data: byPhase.map(function(r){return r.totalMinutes;}),
            backgroundColor: ['#6366f1', '#10b981'],
            borderWidth: 0, hoverOffset: 4
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, cutout: '65%',
          plugins: {
            legend: { display: true, position: 'bottom', labels: { boxWidth: 10, padding: 6 } },
            tooltip: { callbacks: { label: function(c){
              var total = c.dataset.data.reduce(function(a,b){return a+b;},0);
              var pct = total > 0 ? (c.parsed / total * 100).toFixed(0) : 0;
              return c.label + ': ' + c.parsed.toFixed(1) + ' min (' + pct + '%)';
            } } }
          }
        }
      });
    }

    /* ========== Projects Chart ========== */
    function renderProjectsChart(rows) {
      setChartDefaults();
      var ctx = document.getElementById('chart-projects');
      if (!ctx) return;
      var view = (rows || []).slice(0, 8);
      var labels = view.map(function(r){return projectLabel(r.projectPath);});
      var data = view.map(function(r){return r.totalMinutes;});
      if (updateChartData('projects', labels, [{ data: data }])) return;
      destroyChart('projects');
      charts.projects = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: view.map(function(r){return projectLabel(r.projectPath);}),
          datasets: [{
            data: view.map(function(r){return r.totalMinutes;}),
            backgroundColor: '#0ea5e9', borderRadius: 4, barPercentage: 0.7
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false, indexAxis: 'y',
          plugins: { tooltip: { callbacks: { label: function(c){return c.parsed.x.toFixed(1) + ' min';} } } },
          scales: {
            x: { beginAtZero: true, grid: { color: chartGridColor() } },
            y: { grid: { display: false }, ticks: { font: { size: 10 } } }
          }
        }
      });
    }

    /* ========== Heatmap ========== */
    function renderHeatmap(byDay) {
      var container = document.getElementById('heatmap-container');
      if (!container) return;
      if (!byDay || byDay.length === 0) { container.innerHTML = '<div class="muted" style="font-size:12px;padding:8px">No activity data</div>'; return; }
      var dayNames = ['S','M','T','W','T','F','S'];
      var dayMap = {};
      byDay.forEach(function(r){ dayMap[r.day] = r.sessions; });
      var allDays = Object.keys(dayMap).sort();
      if (allDays.length === 0) { container.innerHTML = '<div class="muted" style="font-size:12px;padding:8px">No data</div>'; return; }
      var maxSessions = Math.max.apply(null, Object.values(dayMap)) || 1;
      var end = new Date(allDays[allDays.length - 1]);
      var start = new Date(end);
      start.setDate(start.getDate() - 27);
      var cells = [];
      var cur = new Date(start);
      while (cur <= end) {
        var key = cur.toISOString().slice(0, 10);
        var count = dayMap[key] || 0;
        var intensity = count / maxSessions;
        var color;
        if (count === 0) color = isDark() ? '#27272a' : '#e4e4e7';
        else if (intensity < 0.25) color = isDark() ? '#1e3a5f' : '#c7d2fe';
        else if (intensity < 0.5) color = isDark() ? '#3730a3' : '#a5b4fc';
        else if (intensity < 0.75) color = isDark() ? '#4f46e5' : '#818cf8';
        else color = isDark() ? '#6366f1' : '#6366f1';
        cells.push('<div class="heatmap-cell" style="background:' + color + '" title="' + key + ': ' + count + ' sessions"></div>');
        cur.setDate(cur.getDate() + 1);
      }
      var firstDow = new Date(start).getDay();
      var padCells = '';
      for (var p = 0; p < firstDow; p++) padCells += '<div></div>';
      container.innerHTML =
        '<div class="heatmap-day-labels">' + dayNames.map(function(d){return '<span>'+d+'</span>';}).join('') + '</div>'
        + '<div class="heatmap-grid">' + padCells + cells.join('') + '</div>';
    }

    /* ========== Agent Comparison ========== */
    function renderAgentComparison(sessions, byTool) {
      var row = document.getElementById('agent-compare-row');
      if (!row) return;
      var agentMap = {};
      (sessions || []).forEach(function(s) {
        var key = (s.agentKey || 'unknown').toLowerCase();
        if (!agentMap[key]) agentMap[key] = { sessions: [], tools: {} };
        agentMap[key].sessions.push(s);
      });
      var agents = Object.keys(agentMap).filter(function(k){return agentMap[k].sessions.length > 0;});
      if (agents.length === 0) { row.style.display = 'none'; return; }

      (sessions || []).forEach(function(s) {
        var key = (s.agentKey || 'unknown').toLowerCase();
        if (agentMap[key]) {
          var intent = s.intentLabel || 'unlabeled';
          agentMap[key].tools[intent] = (agentMap[key].tools[intent] || 0) + 1;
        }
      });

      row.style.display = 'grid';
      row.style.gridTemplateColumns = 'repeat(' + Math.min(agents.length, 4) + ', 1fr)';
      row.style.gap = '14px';
      row.style.gridColumn = 'span 2';
      row.innerHTML = agents.map(function(agent) {
        var data = agentMap[agent];
        var totalMin = data.sessions.reduce(function(a,s){return a+s.durationMinutes;},0);
        var avgMin = data.sessions.length > 0 ? (totalMin / data.sessions.length) : 0;
        var topIntent = Object.keys(data.tools).sort(function(a,b){return data.tools[b]-data.tools[a];})[0] || '-';
        var displayName = agent.charAt(0).toUpperCase() + agent.slice(1);
        return '<div class="card agent-compare-card" style="border-top:3px solid ' + agentColor(agent) + ';text-align:center">'
          + '<div class="agent-compare-name" style="color:' + agentColor(agent) + ';font-size:14px">' + esc(displayName) + '</div>'
          + '<div class="agent-stat-row"><span class="agent-stat-label">Sessions</span><span class="agent-stat-value">' + data.sessions.length + '</span></div>'
          + '<div class="agent-stat-row"><span class="agent-stat-label">Total Minutes</span><span class="agent-stat-value">' + totalMin.toFixed(1) + '</span></div>'
          + '<div class="agent-stat-row"><span class="agent-stat-label">Avg Session</span><span class="agent-stat-value">' + avgMin.toFixed(1) + 'm</span></div>'
          + '<div class="agent-stat-row"><span class="agent-stat-label">Top Intent</span><span class="agent-stat-value">' + esc(topIntent) + '</span></div>'
          + '</div>';
      }).join('');
    }

    /* ========== Live Sessions Sidebar ========== */
    var liveTimerInterval = null;
    function openSidebar() {
      document.getElementById('live-sidebar').classList.add('open');
      document.getElementById('sidebar-backdrop').classList.add('visible');
    }
    function closeSidebar() {
      document.getElementById('live-sidebar').classList.remove('open');
      document.getElementById('sidebar-backdrop').classList.remove('visible');
    }
    function renderLiveSidebar(activeSessions) {
      var toggleBtn = document.getElementById('sidebar-toggle');
      var badgeEl = document.getElementById('sidebar-badge');
      var countEl = document.getElementById('live-count');
      var colEl = document.getElementById('live-sessions-col');
      if (!activeSessions || activeSessions.length === 0) {
        toggleBtn.classList.remove('visible');
        closeSidebar();
        if (liveTimerInterval) { clearInterval(liveTimerInterval); liveTimerInterval = null; }
        return;
      }
      toggleBtn.classList.add('visible');
      badgeEl.textContent = activeSessions.length;
      countEl.textContent = activeSessions.length;
      colEl.innerHTML = activeSessions.map(function(s) {
        var dotColor = agentColor(s.agentKey);
        var proj = projectLabel(s.repoPath || '');
        return '<div class="live-session-card" data-started="' + esc(s.startedAt) + '">'
          + '<div class="ls-agent"><span class="agent-dot" style="background:' + dotColor + '"></span>' + esc(s.agentDisplay) + '</div>'
          + '<div class="ls-timer" data-started="' + esc(s.startedAt) + '">--:--</div>'
          + '<div class="ls-detail">' + esc(s.lastTool || 'idle') + (proj ? ' &middot; ' + esc(proj) : '') + '</div>'
          + '</div>';
      }).join('');
      updateLiveTimers();
      if (liveTimerInterval) clearInterval(liveTimerInterval);
      liveTimerInterval = setInterval(updateLiveTimers, 1000);
    }
    function updateLiveTimers() {
      var timers = document.querySelectorAll('.ls-timer[data-started]');
      var now = Date.now();
      timers.forEach(function(el) {
        var started = new Date(el.getAttribute('data-started')).getTime();
        var diff = Math.max(0, Math.floor((now - started) / 1000));
        var mm = String(Math.floor(diff / 60)).padStart(2, '0');
        var ss = String(diff % 60).padStart(2, '0');
        el.textContent = mm + ':' + ss;
      });
    }

    /* ========== Session Cards ========== */
    var capsuleCache = new Map();
    var expandedSessionId = null;
    function agentClass(agent) {
      var a = (agent || '').toLowerCase();
      if (a.includes('claude')) return 'claude';
      if (a.includes('codex')) return 'codex';
      if (a.includes('gemini')) return 'gemini';
      return 'claude';
    }
    function renderSessions(rows) {
      var el = document.getElementById('sessions-list');
      var prevExpanded = expandedSessionId;
      expandedSessionId = null;
      el.innerHTML = rows.slice(0, 30).map(function(row) {
        var agentCls = agentClass(row.agentKey || row.agent);
        var statusCls = row.status === 'active' ? 'active' : 'ended';
        var capsuleCls = row.hasCapsule ? 'has-capsule' : '';
        var capsuleSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/></svg>';
        return '<div class="session-card agent-' + agentCls + '" data-id="' + esc(row.id) + '" data-has-capsule="' + (row.hasCapsule ? '1' : '0') + '">'
          + '<div class="session-card-header">'
          + '<span class="status-dot ' + statusCls + '"></span>'
          + '<span class="agent-pill ' + agentCls + '">' + esc(row.agentDisplay || row.agent) + '</span>'
          + '<span class="intent-chip">' + esc(row.intentLabel || 'unlabeled') + '</span>'
          + '<span class="project-chip" title="' + esc(row.repoPath || '(unknown)') + '">' + esc(projectLabel(row.repoPath || '(unknown)')) + '</span>'
          + '<span class="session-meta">'
          + '<span>' + row.durationMinutes.toFixed(1) + ' min</span>'
          + '<span>' + relativeTime(row.startedAt) + '</span>'
          + '<span class="capsule-icon ' + capsuleCls + '">' + capsuleSvg + '</span>'
          + '<button class="handoff-btn" title="Open handoff in terminal"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>Handoff</button>'
          + '</span></div>'
          + '<div class="session-detail" id="detail-' + esc(row.id) + '"></div></div>';
      }).join('');
      if (prevExpanded) {
        var prevCard = document.querySelector('.session-card[data-id="' + prevExpanded + '"]');
        if (prevCard) { prevCard.classList.add('expanded'); expandedSessionId = prevExpanded; }
      }
    }
    function toggleSessionDetail(card) {
      var id = card.getAttribute('data-id');
      var hasCapsule = card.getAttribute('data-has-capsule') === '1';
      var detailEl = document.getElementById('detail-' + id);
      if (expandedSessionId === id) { card.classList.remove('expanded'); expandedSessionId = null; return; }
      if (expandedSessionId) { var prev = document.querySelector('.session-card.expanded'); if (prev) prev.classList.remove('expanded'); }
      expandedSessionId = id;
      card.classList.add('expanded');
      if (capsuleCache.has(id)) { renderCapsuleDetail(detailEl, capsuleCache.get(id)); return; }
      if (!hasCapsule) { detailEl.innerHTML = '<div class="no-capsule">No capsule data for this session</div>'; capsuleCache.set(id, null); return; }
      detailEl.innerHTML = '<div class="capsule-spinner">Loading capsule...</div>';
      fetch('/api/session-capsule?id=' + encodeURIComponent(id))
        .then(function(r){return r.json();})
        .then(function(data) {
          if (data.error) { detailEl.innerHTML = '<div class="no-capsule">' + esc(data.error) + '</div>'; capsuleCache.set(id, null); }
          else { capsuleCache.set(id, data); renderCapsuleDetail(detailEl, data); }
        })
        .catch(function(){ detailEl.innerHTML = '<div class="no-capsule">Failed to load capsule</div>'; });
    }
    function renderCapsuleDetail(el, data) {
      if (!data) { el.innerHTML = '<div class="no-capsule">No capsule data for this session</div>'; return; }
      var capsule = data.capsule;
      var h = '';
      if (capsule && capsule.summaryMarkdown) h += '<div class="capsule-section"><h4>Summary</h4><pre>' + esc(capsule.summaryMarkdown) + '</pre></div>';
      if (capsule && capsule.decisions && capsule.decisions.length) h += '<div class="capsule-section"><h4>Decisions</h4><ul>' + capsule.decisions.map(function(d){return '<li>'+esc(d)+'</li>';}).join('') + '</ul></div>';
      if (capsule && capsule.todos && capsule.todos.length) h += '<div class="capsule-section"><h4>Todos</h4><ul>' + capsule.todos.map(function(t){return '<li>'+esc(t)+'</li>';}).join('') + '</ul></div>';
      if (capsule && capsule.activity && capsule.activity.length) h += '<div class="capsule-section"><h4>Activity</h4><ul>' + capsule.activity.slice(0,20).map(function(a){return '<li>'+esc(a)+'</li>';}).join('') + (capsule.activity.length > 20 ? '<li class="muted">+' + (capsule.activity.length - 20) + ' more</li>' : '') + '</ul></div>';
      if (capsule && capsule.handoffNotes && capsule.handoffNotes.length) h += '<div class="capsule-section"><h4>Handoff Notes</h4><ul>' + capsule.handoffNotes.map(function(n){return '<li>'+esc(n)+'</li>';}).join('') + '</ul></div>';
      if (capsule && capsule.sessionFacts && capsule.sessionFacts.length) h += '<div class="capsule-section"><h4>Session Facts</h4><ul>' + capsule.sessionFacts.map(function(f){return '<li>'+esc(f)+'</li>';}).join('') + '</ul></div>';
      if (capsule && capsule.files && capsule.files.length) {
        var files = capsule.files, shown = files.slice(0,15), extra = files.length - 15;
        h += '<div class="capsule-section"><h4>Files</h4><div class="capsule-files">' + shown.map(function(f){return esc(f);}).join('<br>') + (extra > 0 ? '<br><span class="muted">+' + extra + ' more</span>' : '') + '</div></div>';
      }
      if (capsule && capsule.errors && capsule.errors.length) h += '<div class="capsule-section"><div class="capsule-errors"><h4 style="color:var(--error-text);margin:0 0 6px">Errors</h4><ul>' + capsule.errors.map(function(e){return '<li>'+esc(e)+'</li>';}).join('') + '</ul></div></div>';
      if (data.taskBreakdown && data.taskBreakdown.length) h += '<div class="capsule-section"><h4>Tasks</h4><ul>' + data.taskBreakdown.map(function(t){return '<li>' + esc(t.label) + ' <span class="muted">(' + t.minutes.toFixed(1) + ' min)</span></li>';}).join('') + '</ul></div>';
      if (!h) h = '<div class="no-capsule">No capsule data for this session</div>';
      el.innerHTML = h;
    }

    /* ========== Resume Packs ========== */
    function renderPacks(rows) {
      var tbody = document.querySelector('#packs-table tbody');
      tbody.innerHTML = rows.slice(0, 20).map(function(row) {
        return '<tr><td>' + esc(row.title) + '</td><td>' + row.sourceSessionIds.length + '</td><td>' + row.tokenBudget + '</td><td>' + esc(row.createdAt) + '</td></tr>';
      }).join('');
    }

    /* ========== Main Load (hash-based smart refresh) ========== */
    var lastHash = {};

    async function load(range, agent, forceAll) {
      var agentQuery = agent && agent !== 'all' ? '&agent=' + encodeURIComponent(agent) : '';
      var [statsRes, sessionsRes, packsRes, activeRes] = await Promise.all([
        fetch('/api/stats?range=' + encodeURIComponent(range) + agentQuery),
        fetch('/api/sessions?limit=40&range=' + encodeURIComponent(range) + agentQuery),
        fetch('/api/resume-packs?limit=20'),
        fetch('/api/active-sessions')
      ]);
      var statsRaw = await statsRes.text();
      var sessionsRaw = await sessionsRes.text();
      var packsRaw = await packsRes.text();
      var activeRaw = await activeRes.text();

      if (forceAll || statsRaw !== lastHash.stats) {
        lastHash.stats = statsRaw;
        var stats = JSON.parse(statsRaw);
        renderKpis(stats.summary, stats.byDay);
        renderTimeline(stats.byAgentByDay);
        renderAgentDonut(stats.byAgent);
        renderIntentChart(stats.byIntent);
        renderToolsChart(stats.byTool);
        renderPhaseDonut(stats.byPhase);
        renderProjectsChart(stats.byProject);
        renderHeatmap(stats.byDay);
      }

      if (forceAll || sessionsRaw !== lastHash.sessions) {
        lastHash.sessions = sessionsRaw;
        var sessions = JSON.parse(sessionsRaw);
        var statsObj = JSON.parse(lastHash.stats || statsRaw);
        renderAgentComparison(sessions, statsObj.byTool);
        renderSessions(sessions);
      }

      if (forceAll || packsRaw !== lastHash.packs) {
        lastHash.packs = packsRaw;
        renderPacks(JSON.parse(packsRaw));
      }

      if (forceAll || activeRaw !== lastHash.active) {
        lastHash.active = activeRaw;
        renderLiveSidebar(JSON.parse(activeRaw));
      }
    }

    /* ========== Init ========== */
    var rangeEl = document.getElementById('range');
    var agentEl = document.getElementById('agent');
    function closeHandoffPopover() {
      var existing = document.querySelector('.handoff-popover');
      if (existing) existing.remove();
    }
    function launchHandoff(btn, sessionId, agent) {
      closeHandoffPopover();
      btn.classList.add('launching');
      var origText = btn.innerHTML;
      btn.innerHTML = 'Launching...';
      fetch('/api/handoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, agent: agent })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) { alert('Handoff error: ' + data.error); }
        setTimeout(function() { btn.innerHTML = origText; btn.classList.remove('launching'); }, 1500);
      })
      .catch(function(err) {
        alert('Handoff failed: ' + err.message);
        btn.innerHTML = origText;
        btn.classList.remove('launching');
      });
    }
    document.addEventListener('click', function(e) {
      if (!e.target.closest('.handoff-popover') && !e.target.closest('.handoff-btn')) {
        closeHandoffPopover();
      }
    });
    document.getElementById('sessions-list').addEventListener('click', function(e) {
      var agentOption = e.target.closest('.handoff-agent-option');
      if (agentOption) {
        e.stopPropagation();
        var agent = agentOption.getAttribute('data-agent');
        var popover = agentOption.closest('.handoff-popover');
        var card = agentOption.closest('.session-card');
        var btn = card ? card.querySelector('.handoff-btn') : null;
        var sessionId = card ? card.getAttribute('data-id') : null;
        if (btn && sessionId) launchHandoff(btn, sessionId, agent);
        return;
      }
      var handoffBtn = e.target.closest('.handoff-btn');
      if (handoffBtn) {
        e.stopPropagation();
        var existing = document.querySelector('.handoff-popover');
        if (existing && existing.parentNode === handoffBtn.parentNode) {
          closeHandoffPopover();
          return;
        }
        closeHandoffPopover();
        var popover = document.createElement('div');
        popover.className = 'handoff-popover';
        popover.innerHTML = '<div class="handoff-popover-title">Hand off to</div>'
          + '<button class="handoff-agent-option" data-agent="claude"><span class="agent-dot" style="background:var(--agent-claude)"></span>Claude</button>'
          + '<button class="handoff-agent-option" data-agent="codex"><span class="agent-dot" style="background:var(--agent-codex)"></span>Codex</button>';
        handoffBtn.parentNode.appendChild(popover);
        return;
      }
      var card = e.target.closest('.session-card');
      if (card) toggleSessionDetail(card);
    });
    document.getElementById('sidebar-toggle').addEventListener('click', function() {
      var sidebar = document.getElementById('live-sidebar');
      if (sidebar.classList.contains('open')) closeSidebar(); else openSidebar();
    });
    document.getElementById('close-sidebar').addEventListener('click', closeSidebar);
    document.getElementById('sidebar-backdrop').addEventListener('click', closeSidebar);

    var loading = false, hasShownError = false;
    var reload = async function(silent) {
      if (loading) return;
      loading = true;
      try { await load(rangeEl.value, agentEl.value, !silent); hasShownError = false; }
      catch (err) { console.error(err); if (!silent && !hasShownError) { hasShownError = true; alert('Failed to load dashboard data. Check terminal logs.'); } }
      finally { loading = false; }
    };
    function fullReset() {
      lastHash = {}; capsuleCache.clear(); kpisInitialized = false;
      Object.keys(charts).forEach(function(k){ destroyChart(k); });
    }
    rangeEl.addEventListener('change', function(){ fullReset(); reload(false); });
    agentEl.addEventListener('change', function(){ fullReset(); reload(false); });
    reload(false);
    setInterval(function(){ reload(true); }, 3000);
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

      if (pathname === "/api/active-sessions") {
        json(res, 200, listActiveSessions(options.dataDir));
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

      if (pathname === "/api/handoff" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            const sessionId = body.sessionId;
            let agent = (body.agent || "claude").toLowerCase();
            if (agent !== "claude" && agent !== "codex") agent = "claude";
            if (!sessionId || typeof sessionId !== "string") {
              json(res, 400, { error: "Missing sessionId" });
              return;
            }

            const command = `ctx-ledger handoff --agent ${agent} --from ${sessionId}`;

            if (process.platform === "darwin") {
              const result = spawnSync("osascript", [
                "-e",
                `tell application "iTerm2"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow
    write text "${command}"
  end tell
end tell`,
              ]);
              if (result.error) {
                json(res, 500, { error: `Failed to open terminal: ${result.error.message}` });
                return;
              }
              json(res, 200, { ok: true, command });
            } else if (process.platform === "linux") {
              let result = spawnSync("gnome-terminal", ["--", "bash", "-c", `${command}; exec bash`]);
              if (result.error) {
                result = spawnSync("xterm", ["-e", `bash -c '${command}; exec bash'`]);
              }
              if (result.error) {
                json(res, 500, { error: `Failed to open terminal: ${result.error.message}` });
                return;
              }
              json(res, 200, { ok: true, command });
            } else {
              json(res, 501, { error: `Unsupported platform: ${process.platform}` });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            json(res, 500, { error: message });
          }
        });
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
