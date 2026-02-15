import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { getDataDir, getDatabasePath, initDatabase } from "./db";

export interface UsageStatsSummary {
  sessions: number;
  events: number;
  toolCalls: number;
  totalMinutes: number;
  planningMinutes: number;
  executionMinutes: number;
}

export interface UsageStatsIntentRow {
  label: string;
  sessions: number;
  totalMinutes: number;
  avgConfidence: number;
}

export interface UsageStatsToolRow {
  toolName: string;
  calls: number;
  successCalls: number;
  totalSeconds: number;
}

export interface UsageStatsAgentRow {
  agentKey: string;
  agentDisplay: string;
  provider: string;
  sessions: number;
  totalMinutes: number;
}

export interface UsageStatsDayRow {
  day: string;
  sessions: number;
  totalMinutes: number;
}

export interface UsageStatsPhaseRow {
  phase: "planning" | "execution";
  totalMinutes: number;
  share: number;
}

export interface UsageStatsProjectRow {
  projectPath: string;
  sessions: number;
  totalMinutes: number;
}

export interface UsageStatsResult {
  rangeLabel: string;
  sinceIso: string | null;
  summary: UsageStatsSummary;
  byIntent: UsageStatsIntentRow[];
  byTool: UsageStatsToolRow[];
  byAgent: UsageStatsAgentRow[];
  byDay: UsageStatsDayRow[];
  byPhase: UsageStatsPhaseRow[];
  byProject: UsageStatsProjectRow[];
}

export interface SessionListItem {
  id: string;
  provider: string;
  agent: string;
  agentKey: string;
  agentDisplay: string;
  repoPath: string | null;
  branch: string | null;
  startedAt: string;
  endedAt: string | null;
  status: string;
  durationMinutes: number;
  intentLabel: string | null;
  intentConfidence: number | null;
  hasCapsule: boolean;
}

export interface CapsuleData {
  summaryMarkdown: string;
  decisions: string[];
  todos: string[];
  files: string[];
  commands: string[];
  errors: string[];
}

export interface TaskBreakdownData {
  label: string;
  minutes: number;
  confidence: number;
  source: string;
}

export interface ResumeSessionContext {
  session: SessionListItem;
  capsule: CapsuleData | null;
  prompts: string[];
  taskBreakdown: TaskBreakdownData[];
}

export interface SaveResumePackInput {
  title: string;
  sourceSessionIds: string[];
  tokenBudget: number;
  contentMarkdown: string;
  metadata?: unknown;
}

export interface ResumePackRecord {
  id: string;
  title: string;
  sourceSessionIds: string[];
  tokenBudget: number;
  contentMarkdown: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

function openReadonly(explicitDataDir?: string): Database.Database {
  const dataDir = getDataDir(explicitDataDir);
  const dbPath = getDatabasePath(dataDir);
  initDatabase(explicitDataDir);
  return new Database(dbPath, { readonly: true });
}

function openWritable(explicitDataDir?: string): Database.Database {
  const dataDir = getDataDir(explicitDataDir);
  const dbPath = getDatabasePath(dataDir);
  initDatabase(explicitDataDir);
  return new Database(dbPath);
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // no-op
  }
  return null;
}

function parseJsonStringArray(raw: string | null): string[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function durationExprSql(): string {
  return `
    CASE
      WHEN julianday(COALESCE(
        s.ended_at,
        (SELECT MAX(e.timestamp) FROM events e WHERE e.session_id = s.id),
        s.started_at
      )) > julianday(s.started_at)
      THEN (julianday(COALESCE(
        s.ended_at,
        (SELECT MAX(e.timestamp) FROM events e WHERE e.session_id = s.id),
        s.started_at
      )) - julianday(s.started_at)) * 24.0 * 60.0
      ELSE 0
    END
  `;
}

function normalizedAgentExprSql(sessionAlias = "s"): string {
  return `
    CASE
      WHEN LOWER(${sessionAlias}.agent) IN ('claude', 'claude-code') THEN 'claude'
      WHEN LOWER(${sessionAlias}.agent) = 'codex' THEN 'codex'
      WHEN LOWER(${sessionAlias}.agent) = 'gemini' THEN 'gemini'
      ELSE LOWER(${sessionAlias}.agent)
    END
  `;
}

function agentDisplayExprSql(sessionAlias = "s"): string {
  return `
    CASE
      WHEN LOWER(${sessionAlias}.agent) IN ('claude', 'claude-code') THEN 'Claude Code'
      WHEN LOWER(${sessionAlias}.agent) = 'codex' THEN 'Codex'
      WHEN LOWER(${sessionAlias}.agent) = 'gemini' THEN 'Gemini'
      ELSE ${sessionAlias}.agent
    END
  `;
}

function normalizeAgentFilterValues(values?: string[]): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  const normalized = new Set<string>();
  for (const value of values) {
    const parts = value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    for (const part of parts) {
      if (part === "claude" || part === "claude-code") {
        normalized.add("claude");
      } else if (part === "codex") {
        normalized.add("codex");
      } else if (part === "gemini") {
        normalized.add("gemini");
      } else {
        normalized.add(part);
      }
    }
  }

  return [...normalized];
}

function inferredIntentLabelExprSql(): string {
  return `
    CASE
      WHEN EXISTS(
        SELECT 1
        FROM events e3
        WHERE e3.session_id = s.id
          AND e3.event_type = 'request_sent'
          AND e3.payload_json IS NOT NULL
          AND (
            LOWER(e3.payload_json) LIKE '%sql%'
            OR LOWER(e3.payload_json) LIKE '%query%'
            OR LOWER(e3.payload_json) LIKE '%select%'
            OR LOWER(e3.payload_json) LIKE '%join%'
            OR LOWER(e3.payload_json) LIKE '%postgres%'
            OR LOWER(e3.payload_json) LIKE '%mysql%'
          )
      )
      THEN 'sql'
      WHEN EXISTS(SELECT 1 FROM tool_calls tc3 WHERE tc3.session_id = s.id)
      THEN 'coding'
      WHEN s.status = 'active'
      THEN 'in_progress'
      ELSE NULL
    END
  `;
}

function inferredIntentConfidenceExprSql(): string {
  return `
    CASE
      WHEN EXISTS(
        SELECT 1
        FROM events e4
        WHERE e4.session_id = s.id
          AND e4.event_type = 'request_sent'
          AND e4.payload_json IS NOT NULL
          AND (
            LOWER(e4.payload_json) LIKE '%sql%'
            OR LOWER(e4.payload_json) LIKE '%query%'
            OR LOWER(e4.payload_json) LIKE '%select%'
            OR LOWER(e4.payload_json) LIKE '%join%'
            OR LOWER(e4.payload_json) LIKE '%postgres%'
            OR LOWER(e4.payload_json) LIKE '%mysql%'
          )
      )
      THEN 0.56
      WHEN EXISTS(SELECT 1 FROM tool_calls tc4 WHERE tc4.session_id = s.id)
      THEN 0.5
      WHEN s.status = 'active'
      THEN 0.3
      ELSE NULL
    END
  `;
}

function getSessionsWhereClause(
  sinceIso: string | null,
  agentFilter?: string[],
): {
  whereSql: string;
  params: unknown[];
} {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (sinceIso) {
    clauses.push("datetime(s.started_at) >= datetime(?)");
    params.push(sinceIso);
  }

  const normalizedAgents = normalizeAgentFilterValues(agentFilter);
  if (normalizedAgents.length > 0) {
    clauses.push(
      `${normalizedAgentExprSql("s")} IN (${normalizedAgents.map(() => "?").join(",")})`,
    );
    params.push(...normalizedAgents);
  }

  if (clauses.length === 0) {
    return { whereSql: "", params: [] };
  }

  return {
    whereSql: `WHERE ${clauses.join(" AND ")}`,
    params,
  };
}

function getEventToolWhereClauseForSessions(
  sinceIso: string | null,
  agentFilter?: string[],
): {
  whereSql: string;
  params: unknown[];
} {
  const normalizedAgents = normalizeAgentFilterValues(agentFilter);
  if (!sinceIso && normalizedAgents.length === 0) {
    return { whereSql: "", params: [] };
  }

  const { whereSql, params } = getSessionsWhereClause(sinceIso, normalizedAgents);
  return {
    whereSql: `WHERE session_id IN (SELECT id FROM sessions s ${whereSql})`,
    params,
  };
}

export function listSessions(
  options?: { limit?: number; sinceIso?: string | null; agentFilter?: string[] },
  explicitDataDir?: string,
): SessionListItem[] {
  const db = openReadonly(explicitDataDir);
  const limit = options?.limit ?? 50;
  const sinceIso = options?.sinceIso ?? null;
  const agentFilter = options?.agentFilter;
  const durationExpr = durationExprSql();
  const inferredIntentLabelExpr = inferredIntentLabelExprSql();
  const inferredIntentConfidenceExpr = inferredIntentConfidenceExprSql();
  const normalizedAgentExpr = normalizedAgentExprSql();
  const agentDisplayExpr = agentDisplayExprSql();
  const { whereSql, params } = getSessionsWhereClause(sinceIso, agentFilter);

  try {
    const rows = db
      .prepare(
        `
          SELECT
            s.id,
            s.provider,
            s.agent,
            ${normalizedAgentExpr} as agentKey,
            ${agentDisplayExpr} as agentDisplay,
            s.repo_path as repoPath,
            s.branch,
            s.started_at as startedAt,
            s.ended_at as endedAt,
            s.status,
            ${durationExpr} as durationMinutes,
            COALESCE(li.label, ${inferredIntentLabelExpr}) as intentLabel,
            COALESCE(li.confidence, ${inferredIntentConfidenceExpr}) as intentConfidence,
            CASE WHEN c.session_id IS NOT NULL THEN 1 ELSE 0 END as hasCapsule
          FROM sessions s
          LEFT JOIN intent_labels li
            ON li.id = (
              SELECT il2.id
              FROM intent_labels il2
              WHERE il2.session_id = s.id
              ORDER BY datetime(il2.created_at) DESC
              LIMIT 1
            )
          LEFT JOIN capsules c ON c.session_id = s.id
          ${whereSql}
          ORDER BY datetime(s.started_at) DESC
          LIMIT ?
        `,
      )
      .all(...params, limit) as Array<{
      id: string;
      provider: string;
      agent: string;
      agentKey: string;
      agentDisplay: string;
      repoPath: string | null;
      branch: string | null;
      startedAt: string;
      endedAt: string | null;
      status: string;
      durationMinutes: number | null;
      intentLabel: string | null;
      intentConfidence: number | null;
      hasCapsule: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      agent: row.agent,
      agentKey: row.agentKey,
      agentDisplay: row.agentDisplay,
      repoPath: row.repoPath,
      branch: row.branch,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      status: row.status,
      durationMinutes: Number(row.durationMinutes ?? 0),
      intentLabel: row.intentLabel,
      intentConfidence:
        row.intentConfidence === null ? null : Number(row.intentConfidence),
      hasCapsule: row.hasCapsule === 1,
    }));
  } finally {
    db.close();
  }
}

function groupBy<T>(
  items: T[],
  keyFn: (item: T) => string,
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

const UNKNOWN_PROJECT_LABEL = "(unknown)";

function getExecutionMinutesBySession(
  db: Database.Database,
  eventWhereSql: string,
  eventParams: unknown[],
): Map<string, number> {
  const phaseWhereSql = eventWhereSql.length > 0
    ? `${eventWhereSql} AND event_type IN ('tool_pre_use', 'tool_post_use')`
    : "WHERE event_type IN ('tool_pre_use', 'tool_post_use')";
  const phaseRows = db
    .prepare(
      `
        SELECT
          e.session_id as sessionId,
          e.event_type as eventType,
          e.timestamp as timestamp
        FROM events e
        ${phaseWhereSql}
        ORDER BY e.session_id ASC, datetime(e.timestamp) ASC, e.id ASC
      `,
    )
    .all(...eventParams) as Array<{
    sessionId: string;
    eventType: string;
    timestamp: string;
  }>;

  const executionMsBySession = new Map<string, number>();
  const openToolStarts = new Map<string, number[]>();

  for (const row of phaseRows) {
    const timestampMs = Date.parse(row.timestamp);
    if (!Number.isFinite(timestampMs)) {
      continue;
    }

    if (row.eventType === "tool_pre_use") {
      const stack = openToolStarts.get(row.sessionId);
      if (stack) {
        stack.push(timestampMs);
      } else {
        openToolStarts.set(row.sessionId, [timestampMs]);
      }
      continue;
    }

    const stack = openToolStarts.get(row.sessionId);
    if (!stack || stack.length === 0) {
      continue;
    }

    const startMs = stack.pop();
    if (typeof startMs !== "number" || timestampMs <= startMs) {
      continue;
    }

    const prev = executionMsBySession.get(row.sessionId) ?? 0;
    executionMsBySession.set(row.sessionId, prev + (timestampMs - startMs));
  }

  const toolDurationRows = db
    .prepare(
      `
        SELECT
          tc.session_id as sessionId,
          SUM(COALESCE(tc.duration_ms, 0)) as totalDurationMs
        FROM tool_calls tc
        ${eventWhereSql}
        GROUP BY tc.session_id
      `,
    )
    .all(...eventParams) as Array<{
    sessionId: string;
    totalDurationMs: number | null;
  }>;

  for (const row of toolDurationRows) {
    const durationMs = Number(row.totalDurationMs ?? 0);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      continue;
    }
    const existing = executionMsBySession.get(row.sessionId) ?? 0;
    if (durationMs > existing) {
      executionMsBySession.set(row.sessionId, durationMs);
    }
  }

  const executionMinutesBySession = new Map<string, number>();
  for (const [sessionId, durationMs] of executionMsBySession.entries()) {
    executionMinutesBySession.set(sessionId, durationMs / (1000 * 60));
  }
  return executionMinutesBySession;
}

export function getUsageStats(
  rangeLabel: string,
  sinceIso: string | null,
  explicitDataDir?: string,
  agentFilter?: string[],
): UsageStatsResult {
  const sessions = listSessions(
    {
      limit: 100_000,
      sinceIso,
      agentFilter,
    },
    explicitDataDir,
  );

  const { whereSql: eventWhereSql, params: eventParams } =
    getEventToolWhereClauseForSessions(sinceIso, agentFilter);
  const db = openReadonly(explicitDataDir);
  try {
    const eventsRow = db
      .prepare(`SELECT COUNT(*) as value FROM events ${eventWhereSql}`)
      .get(...eventParams) as { value: number };
    const toolCallsRow = db
      .prepare(`SELECT COUNT(*) as value FROM tool_calls ${eventWhereSql}`)
      .get(...eventParams) as { value: number };
    const executionMinutesBySession = getExecutionMinutesBySession(
      db,
      eventWhereSql,
      eventParams,
    );

    let totalMinutesRaw = 0;
    let executionMinutesRaw = 0;
    let planningMinutesRaw = 0;
    for (const session of sessions) {
      const sessionMinutes = Math.max(0, session.durationMinutes);
      const executionMinutes = Math.max(
        0,
        Math.min(
          sessionMinutes,
          executionMinutesBySession.get(session.id) ?? 0,
        ),
      );
      const planningMinutes = Math.max(0, sessionMinutes - executionMinutes);

      totalMinutesRaw += sessionMinutes;
      executionMinutesRaw += executionMinutes;
      planningMinutesRaw += planningMinutes;
    }

    const summary: UsageStatsSummary = {
      sessions: sessions.length,
      events: eventsRow.value,
      toolCalls: toolCallsRow.value,
      totalMinutes: Number(totalMinutesRaw.toFixed(2)),
      planningMinutes: Number(planningMinutesRaw.toFixed(2)),
      executionMinutes: Number(executionMinutesRaw.toFixed(2)),
    };

    const byIntentMap = groupBy(
      sessions,
      (row) => row.intentLabel ?? "unlabeled",
    );
    const byIntent: UsageStatsIntentRow[] = [...byIntentMap.entries()]
      .map(([label, rows]) => {
        const confidenceValues = rows
          .map((row) => row.intentConfidence)
          .filter((value): value is number => typeof value === "number");
        const avgConfidence =
          confidenceValues.length > 0
            ? confidenceValues.reduce((acc, value) => acc + value, 0) /
              confidenceValues.length
            : 0;

        return {
          label,
          sessions: rows.length,
          totalMinutes: Number(
            rows.reduce((acc, row) => acc + row.durationMinutes, 0).toFixed(2),
          ),
          avgConfidence: Number(avgConfidence.toFixed(3)),
        };
      })
      .sort((a, b) => b.totalMinutes - a.totalMinutes);

    const byAgentMap = groupBy(
      sessions,
      (row) => `${row.agentKey}||${row.provider}`,
    );
    const byAgent: UsageStatsAgentRow[] = [...byAgentMap.entries()]
      .map(([composite, rows]) => {
        const [agentKey, provider] = composite.split("||");
        return {
          agentKey,
          agentDisplay: rows[0]?.agentDisplay ?? agentKey,
          provider,
          sessions: rows.length,
          totalMinutes: Number(
            rows.reduce((acc, row) => acc + row.durationMinutes, 0).toFixed(2),
          ),
        };
      })
      .sort((a, b) => b.totalMinutes - a.totalMinutes);

    const byDayMap = groupBy(
      sessions,
      (row) => row.startedAt.slice(0, 10),
    );
    const byDay: UsageStatsDayRow[] = [...byDayMap.entries()]
      .map(([day, rows]) => ({
        day,
        sessions: rows.length,
        totalMinutes: Number(
          rows.reduce((acc, row) => acc + row.durationMinutes, 0).toFixed(2),
        ),
      }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

    const byPhase: UsageStatsPhaseRow[] = [
      {
        phase: "planning",
        totalMinutes: summary.planningMinutes,
        share:
          summary.totalMinutes > 0
            ? Number((summary.planningMinutes / summary.totalMinutes).toFixed(3))
            : 0,
      },
      {
        phase: "execution",
        totalMinutes: summary.executionMinutes,
        share:
          summary.totalMinutes > 0
            ? Number((summary.executionMinutes / summary.totalMinutes).toFixed(3))
            : 0,
      },
    ];

    const byProjectMap = groupBy(sessions, (row) => {
      const repoPath = row.repoPath?.trim();
      return repoPath && repoPath.length > 0 ? repoPath : UNKNOWN_PROJECT_LABEL;
    });
    const byProject: UsageStatsProjectRow[] = [...byProjectMap.entries()]
      .map(([projectPath, rows]) => ({
        projectPath,
        sessions: rows.length,
        totalMinutes: Number(
          rows.reduce((acc, row) => acc + row.durationMinutes, 0).toFixed(2),
        ),
      }))
      .sort((a, b) => {
        if (b.totalMinutes !== a.totalMinutes) {
          return b.totalMinutes - a.totalMinutes;
        }
        if (b.sessions !== a.sessions) {
          return b.sessions - a.sessions;
        }
        return a.projectPath.localeCompare(b.projectPath);
      });

    const toolRows = db
      .prepare(
        `
          SELECT
            tc.tool_name as toolName,
            COUNT(*) as calls,
            SUM(CASE WHEN tc.success = 1 THEN 1 ELSE 0 END) as successCalls,
            SUM(COALESCE(tc.duration_ms, 0)) / 1000.0 as totalSeconds
          FROM tool_calls tc
          ${eventWhereSql}
          GROUP BY tc.tool_name
          ORDER BY calls DESC, totalSeconds DESC
        `,
      )
      .all(...eventParams) as Array<{
      toolName: string;
      calls: number;
      successCalls: number;
      totalSeconds: number | null;
    }>;

    const byTool: UsageStatsToolRow[] = toolRows.map((row) => ({
      toolName: row.toolName,
      calls: row.calls,
      successCalls: row.successCalls,
      totalSeconds: Number((row.totalSeconds ?? 0).toFixed(2)),
    }));

    return {
      rangeLabel,
      sinceIso,
      summary,
      byIntent,
      byTool,
      byAgent,
      byDay,
      byPhase,
      byProject,
    };
  } finally {
    db.close();
  }
}

function resolveSessionRef(db: Database.Database, sessionRef: string): string | null {
  if (sessionRef !== "latest") {
    return sessionRef;
  }

  const row = db
    .prepare(
      `
        SELECT id
        FROM sessions
        ORDER BY datetime(started_at) DESC
        LIMIT 1
      `,
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

function loadSessionById(db: Database.Database, sessionId: string): SessionListItem | null {
  const durationExpr = durationExprSql();
  const inferredIntentLabelExpr = inferredIntentLabelExprSql();
  const inferredIntentConfidenceExpr = inferredIntentConfidenceExprSql();
  const normalizedAgentExpr = normalizedAgentExprSql();
  const agentDisplayExpr = agentDisplayExprSql();
  const row = db
    .prepare(
      `
        SELECT
          s.id,
          s.provider,
          s.agent,
          ${normalizedAgentExpr} as agentKey,
          ${agentDisplayExpr} as agentDisplay,
          s.repo_path as repoPath,
          s.branch,
          s.started_at as startedAt,
          s.ended_at as endedAt,
          s.status,
          ${durationExpr} as durationMinutes,
          COALESCE(li.label, ${inferredIntentLabelExpr}) as intentLabel,
          COALESCE(li.confidence, ${inferredIntentConfidenceExpr}) as intentConfidence,
          CASE WHEN c.session_id IS NOT NULL THEN 1 ELSE 0 END as hasCapsule
        FROM sessions s
        LEFT JOIN intent_labels li
          ON li.id = (
            SELECT il2.id
            FROM intent_labels il2
            WHERE il2.session_id = s.id
            ORDER BY datetime(il2.created_at) DESC
            LIMIT 1
          )
        LEFT JOIN capsules c ON c.session_id = s.id
        WHERE s.id = ?
      `,
    )
    .get(sessionId) as
    | {
        id: string;
        provider: string;
        agent: string;
        agentKey: string;
        agentDisplay: string;
        repoPath: string | null;
        branch: string | null;
        startedAt: string;
        endedAt: string | null;
        status: string;
        durationMinutes: number | null;
        intentLabel: string | null;
        intentConfidence: number | null;
        hasCapsule: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    provider: row.provider,
    agent: row.agent,
    agentKey: row.agentKey,
    agentDisplay: row.agentDisplay,
    repoPath: row.repoPath,
    branch: row.branch,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    status: row.status,
    durationMinutes: Number(row.durationMinutes ?? 0),
    intentLabel: row.intentLabel,
    intentConfidence:
      row.intentConfidence === null ? null : Number(row.intentConfidence),
    hasCapsule: row.hasCapsule === 1,
  };
}

export function loadResumeSessionContexts(
  sessionRefs: string[],
  explicitDataDir?: string,
): ResumeSessionContext[] {
  const db = openReadonly(explicitDataDir);
  try {
    const resolvedIds: string[] = [];
    for (const ref of sessionRefs) {
      const resolved = resolveSessionRef(db, ref);
      if (resolved && !resolvedIds.includes(resolved)) {
        resolvedIds.push(resolved);
      }
    }

    const contexts: ResumeSessionContext[] = [];
    for (const sessionId of resolvedIds) {
      const session = loadSessionById(db, sessionId);
      if (!session) {
        continue;
      }

      const capsuleRow = db
        .prepare(
          `
            SELECT
              summary_markdown as summaryMarkdown,
              decisions_json as decisionsJson,
              todos_json as todosJson,
              files_json as filesJson,
              commands_json as commandsJson,
              errors_json as errorsJson
            FROM capsules
            WHERE session_id = ?
          `,
        )
        .get(sessionId) as
        | {
            summaryMarkdown: string;
            decisionsJson: string | null;
            todosJson: string | null;
            filesJson: string | null;
            commandsJson: string | null;
            errorsJson: string | null;
          }
        | undefined;

      const promptRows = db
        .prepare(
          `
            SELECT payload_json as payloadJson
            FROM events
            WHERE session_id = ?
              AND event_type = 'request_sent'
            ORDER BY datetime(timestamp) ASC
            LIMIT 20
          `,
        )
        .all(sessionId) as Array<{ payloadJson: string | null }>;

      const prompts: string[] = [];
      for (const row of promptRows) {
        const payload = parseJsonObject(row.payloadJson);
        const prompt = payload?.prompt;
        if (typeof prompt === "string" && prompt.trim().length > 0) {
          prompts.push(prompt.trim());
        }
      }

      const taskRows = db
        .prepare(
          `
            SELECT
              task_label as label,
              duration_minutes as minutes,
              confidence,
              source
            FROM task_breakdowns
            WHERE session_id = ?
            ORDER BY duration_minutes DESC, confidence DESC
          `,
        )
        .all(sessionId) as Array<{
        label: string;
        minutes: number;
        confidence: number;
        source: string;
      }>;

      contexts.push({
        session,
        capsule: capsuleRow
          ? {
              summaryMarkdown: capsuleRow.summaryMarkdown,
              decisions: parseJsonStringArray(capsuleRow.decisionsJson),
              todos: parseJsonStringArray(capsuleRow.todosJson),
              files: parseJsonStringArray(capsuleRow.filesJson),
              commands: parseJsonStringArray(capsuleRow.commandsJson),
              errors: parseJsonStringArray(capsuleRow.errorsJson),
            }
          : null,
        prompts,
        taskBreakdown: taskRows.map((row) => ({
          label: row.label,
          minutes: Number(row.minutes),
          confidence: Number(row.confidence),
          source: row.source,
        })),
      });
    }

    return contexts.sort((a, b) =>
      a.session.startedAt < b.session.startedAt ? -1 : 1,
    );
  } finally {
    db.close();
  }
}

export function saveResumePack(
  input: SaveResumePackInput,
  explicitDataDir?: string,
): { id: string } {
  const db = openWritable(explicitDataDir);
  const id = randomUUID();
  try {
    db.prepare(
      `
        INSERT INTO resume_packs (
          id,
          title,
          source_session_ids_json,
          token_budget,
          content_markdown,
          metadata_json
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    ).run(
      id,
      input.title,
      JSON.stringify(input.sourceSessionIds),
      input.tokenBudget,
      input.contentMarkdown,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    );
  } finally {
    db.close();
  }
  return { id };
}

export function listResumePacks(
  limit = 20,
  explicitDataDir?: string,
): ResumePackRecord[] {
  const db = openReadonly(explicitDataDir);
  try {
    const rows = db
      .prepare(
        `
          SELECT
            id,
            title,
            source_session_ids_json as sourceSessionIdsJson,
            token_budget as tokenBudget,
            content_markdown as contentMarkdown,
            metadata_json as metadataJson,
            created_at as createdAt
          FROM resume_packs
          ORDER BY datetime(created_at) DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<{
      id: string;
      title: string;
      sourceSessionIdsJson: string;
      tokenBudget: number;
      contentMarkdown: string;
      metadataJson: string | null;
      createdAt: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      sourceSessionIds: parseJsonStringArray(row.sourceSessionIdsJson),
      tokenBudget: row.tokenBudget,
      contentMarkdown: row.contentMarkdown,
      metadata: parseJsonObject(row.metadataJson),
      createdAt: row.createdAt,
    }));
  } finally {
    db.close();
  }
}
