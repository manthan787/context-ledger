import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { getUsageStats, listResumePacks, listSessions } from "../storage/analytics";

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
  <style>
    :root {
      --bg: #f6f7f4;
      --card: #ffffff;
      --text: #1f2933;
      --muted: #64748b;
      --accent: #0b5fff;
      --border: #e2e8f0;
      --good: #166534;
    }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      color: var(--text);
      background: linear-gradient(180deg, #eef2ff 0%, var(--bg) 30%);
    }
    .wrap {
      max-width: 1100px;
      margin: 24px auto;
      padding: 0 16px 32px;
    }
    h1 { margin: 0 0 8px; font-size: 28px; }
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
      background: #e2e8f0;
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
      background: #f1f5f9;
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
      background: white;
    }
    @media (max-width: 900px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>ContextLedger</h1>
    <div class="muted">Local-first usage analytics and session memory</div>

    <div style="margin-top:12px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <label for="range" class="muted">Range:</label>
      <select id="range">
        <option value="24h">24h</option>
        <option value="7d" selected>7d</option>
        <option value="30d">30d</option>
        <option value="all">all</option>
      </select>
      <label for="agent" class="muted">Agent:</label>
      <select id="agent">
        <option value="all" selected>all</option>
        <option value="claude">claude</option>
        <option value="codex">codex</option>
        <option value="gemini">gemini</option>
      </select>
    </div>

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
        <table id="sessions-table">
          <thead><tr><th>ID</th><th>Agent</th><th>Project</th><th>Intent</th><th>Minutes</th><th>Started</th></tr></thead>
          <tbody></tbody>
        </table>
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
    function fmt(value) { return Number(value).toLocaleString(); }

    function projectLabel(path) {
      if (!path || path === "(unknown)") return "(unknown)";
      const normalized = String(path);
      const parts = normalized.split(/[\\\\/]/).filter(Boolean);
      if (parts.length >= 2) {
        return parts.slice(-2).join("/");
      }
      return normalized;
    }

    function renderKpis(summary) {
      const el = document.getElementById("kpis");
      const items = [
        { label: "Sessions", value: fmt(summary.sessions) },
        { label: "Active Minutes", value: fmt(summary.totalMinutes.toFixed(1)) },
        { label: "Events", value: fmt(summary.events) },
        { label: "Tool Calls", value: fmt(summary.toolCalls) },
      ];
      el.innerHTML = items.map((item) => \`
        <div class="card">
          <div class="kpi-label">\${item.label}</div>
          <div class="kpi-value">\${item.value}</div>
        </div>
      \`).join("");
    }

    function renderIntent(rows) {
      const el = document.getElementById("intent");
      const max = Math.max(...rows.map((r) => r.totalMinutes), 1);
      el.innerHTML = rows.map((row) => \`
        <div style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <div>\${row.label}</div>
            <div class="muted">\${row.totalMinutes.toFixed(1)} min</div>
          </div>
          <div class="bar"><span style="width:\${(row.totalMinutes / max) * 100}%"></span></div>
        </div>
      \`).join("");
    }

    function renderTools(rows) {
      const el = document.getElementById("tools");
      const view = rows.slice(0, 12);
      const max = Math.max(...view.map((r) => r.calls), 1);
      el.innerHTML = view.map((row) => \`
        <div style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <div>\${row.toolName}</div>
            <div class="muted">\${row.calls} calls</div>
          </div>
          <div class="bar"><span style="width:\${(row.calls / max) * 100}%"></span></div>
        </div>
      \`).join("");
    }

    function renderPhase(rows) {
      const el = document.getElementById("phase");
      const view = rows || [];
      if (view.length === 0) {
        el.innerHTML = '<div class="muted">No phase data</div>';
        return;
      }
      const max = Math.max(...view.map((r) => r.totalMinutes), 1);
      el.innerHTML = view.map((row) => \`
        <div style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <div>\${row.phase}</div>
            <div class="muted">\${row.totalMinutes.toFixed(1)} min (\${(row.share * 100).toFixed(0)}%)</div>
          </div>
          <div class="bar"><span style="width:\${(row.totalMinutes / max) * 100}%;background:\${row.phase === "execution" ? "#16a34a" : "#6366f1"}"></span></div>
        </div>
      \`).join("");
    }

    function renderProjects(rows) {
      const el = document.getElementById("projects");
      const view = (rows || []).slice(0, 12);
      if (view.length === 0) {
        el.innerHTML = '<div class="muted">No project data</div>';
        return;
      }
      const max = Math.max(...view.map((r) => r.totalMinutes), 1);
      el.innerHTML = view.map((row) => \`
        <div style="margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <div><span class="project-chip" title="\${row.projectPath}">\${projectLabel(row.projectPath)}</span></div>
            <div class="muted">\${row.totalMinutes.toFixed(1)} min (\${row.sessions} sessions)</div>
          </div>
          <div class="bar"><span style="width:\${(row.totalMinutes / max) * 100}%;background:#0ea5e9"></span></div>
        </div>
      \`).join("");
    }

    function renderSessions(rows) {
      const tbody = document.querySelector("#sessions-table tbody");
      tbody.innerHTML = rows.slice(0, 30).map((row) => \`
        <tr>
          <td><code>\${row.id}</code></td>
          <td>\${row.agentDisplay || row.agent}</td>
          <td><span class="project-chip" title="\${row.repoPath || "(unknown)"}">\${projectLabel(row.repoPath || "(unknown)")}</span></td>
          <td>\${row.intentLabel || "unlabeled"}</td>
          <td>\${row.durationMinutes.toFixed(1)}</td>
          <td>\${row.startedAt}</td>
        </tr>
      \`).join("");
    }

    function renderPacks(rows) {
      const tbody = document.querySelector("#packs-table tbody");
      tbody.innerHTML = rows.slice(0, 20).map((row) => \`
        <tr>
          <td>\${row.title}</td>
          <td>\${row.sourceSessionIds.length}</td>
          <td>\${row.tokenBudget}</td>
          <td>\${row.createdAt}</td>
        </tr>
      \`).join("");
    }

    async function load(range, agent) {
      const agentQuery = agent && agent !== "all"
        ? '&agent=' + encodeURIComponent(agent)
        : '';

      const statsRes = await fetch('/api/stats?range=' + encodeURIComponent(range) + agentQuery);
      const stats = await statsRes.json();
      renderKpis(stats.summary);
      renderIntent(stats.byIntent);
      renderTools(stats.byTool);
      renderPhase(stats.byPhase);
      renderProjects(stats.byProject);

      const sessionsRes = await fetch('/api/sessions?limit=40&range=' + encodeURIComponent(range) + agentQuery);
      const sessions = await sessionsRes.json();
      renderSessions(sessions);

      const packsRes = await fetch('/api/resume-packs?limit=20');
      const packs = await packsRes.json();
      renderPacks(packs);
    }

    const rangeEl = document.getElementById("range");
    const agentEl = document.getElementById("agent");
    const reload = () => load(rangeEl.value, agentEl.value);
    rangeEl.addEventListener("change", reload);
    agentEl.addEventListener("change", reload);
    reload().catch((err) => {
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
