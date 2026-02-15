import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { loadAppConfig, saveAppConfig } from "../config";
import { recordEvent, type RecordToolCallInput } from "../storage/db";
import {
  buildPromptPayload,
  extractOptionalString,
  normalizeTimestamp,
  readIncrementalJsonLines,
} from "./shared";

interface CodexHistoryEntry {
  session_id: string;
  ts: number;
  text: string;
  repoPath?: string;
}

interface CodexRolloutRecord {
  type: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

interface OpenToolCall {
  toolName: string;
  startedAt: string;
}

interface CodexRolloutFileState {
  sessionId: string | null;
  repoPath?: string;
  branch?: string;
  openToolCalls: Map<string, OpenToolCall>;
}

interface PersistedRolloutFileState {
  sessionId?: string;
  repoPath?: string;
  branch?: string;
}

export interface EnableCodexOptions {
  dataDir?: string;
  historyPath?: string;
  sessionsPath?: string;
}

export interface EnableCodexResult {
  historyPath: string;
  cursor: number;
  sessionsPath: string;
  trackedSessionFiles: number;
}

export interface SyncCodexOptions {
  dataDir?: string;
  historyPath?: string;
  sessionsPath?: string;
}

export interface SyncCodexResult {
  status: "ok" | "skipped";
  historyPath: string;
  sessionsPath: string;
  inserted: number;
  skipped: number;
  cursor: number;
  touchedSessionIds: string[];
  summarySessionIds: string[];
  reason?: string;
}

const CODEX_HISTORY_SOURCE = "codex_history_jsonl";
const CODEX_SESSIONS_SOURCE = "codex_sessions_jsonl";

function getDefaultHistoryPath(): string {
  return join(homedir(), ".codex", "history.jsonl");
}

function getDefaultSessionsPath(): string {
  return join(homedir(), ".codex", "sessions");
}

function normalizeHistoryPath(input?: string): string {
  return input && input.trim().length > 0 ? input.trim() : getDefaultHistoryPath();
}

function normalizeSessionsPath(input?: string): string {
  return input && input.trim().length > 0 ? input.trim() : getDefaultSessionsPath();
}

function parseHistoryLine(line: string): CodexHistoryEntry | null {
  if (line.trim().length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const raw = parsed as Record<string, unknown>;
  const sessionId = typeof raw.session_id === "string" ? raw.session_id.trim() : "";
  const ts = typeof raw.ts === "number" ? raw.ts : Number(raw.ts);
  const text = typeof raw.text === "string" ? raw.text : "";
  const repoPath = extractOptionalString(raw, [
    "cwd",
    "repo_path",
    "repoPath",
    "workspace",
    "workspace_path",
    "project_path",
    "projectPath",
  ]);

  if (sessionId.length === 0 || !Number.isFinite(ts) || text.trim().length === 0) {
    return null;
  }

  return {
    session_id: sessionId,
    ts,
    text,
    repoPath,
  };
}

function parseRolloutLine(line: string): CodexRolloutRecord | null {
  if (line.trim().length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const raw = parsed as Record<string, unknown>;
  if (typeof raw.type !== "string" || raw.type.trim().length === 0) {
    return null;
  }

  const payload =
    raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
      ? (raw.payload as Record<string, unknown>)
      : undefined;

  return {
    type: raw.type,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : undefined,
    payload,
  };
}

function listRolloutFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) {
    return [];
  }

  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }

    let entries: Array<{
      name: string | Buffer;
      isDirectory: () => boolean;
      isFile: () => boolean;
    }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Array<{
        name: string | Buffer;
        isDirectory: () => boolean;
        isFile: () => boolean;
      }>;
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryName = String(entry.name);
      const fullPath = join(dir, entryName);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (
        entry.isFile() &&
        entryName.startsWith("rollout-") &&
        entryName.endsWith(".jsonl")
      ) {
        out.push(fullPath);
      }
    }
  }

  return out.sort((a, b) => a.localeCompare(b));
}

function inferSessionIdFromRolloutFile(filePath: string): string | null {
  const fileName = basename(filePath);
  const match = fileName.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  if (!match) {
    return null;
  }
  return `codex-${match[1]}`;
}

function extractBranchFromMeta(
  metaPayload: Record<string, unknown> | undefined,
): string | undefined {
  if (!metaPayload) {
    return undefined;
  }

  const git =
    metaPayload.git && typeof metaPayload.git === "object" && !Array.isArray(metaPayload.git)
      ? (metaPayload.git as Record<string, unknown>)
      : null;
  if (!git) {
    return undefined;
  }

  return extractOptionalString(git, [
    "branch",
    "current_branch",
    "currentBranch",
    "name",
  ]);
}

function toIsoTimestamp(raw: unknown, fallback?: string): string {
  const normalized = normalizeTimestamp(raw);
  if (normalized !== null) {
    return new Date(normalized).toISOString();
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return fallback ?? new Date().toISOString();
}

function resolveToolInputKeys(raw: unknown): string[] | undefined {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.keys(parsed as Record<string, unknown>);
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return Object.keys(raw as Record<string, unknown>);
  }
  return undefined;
}

function parseJsonObjectString(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function inferToolResult(output: unknown): {
  success: boolean;
  metadata: Record<string, unknown> | undefined;
} {
  let success = true;
  const metadata: Record<string, unknown> = {};

  const checkExitCode = (value: unknown): void => {
    if (typeof value === "number" && Number.isFinite(value)) {
      metadata.exitCode = value;
      if (value !== 0) {
        success = false;
      }
    }
  };

  if (typeof output === "string") {
    metadata.outputLength = output.length;

    const parsed = parseJsonObjectString(output);
    if (parsed) {
      const parsedMetadata =
        parsed.metadata &&
        typeof parsed.metadata === "object" &&
        !Array.isArray(parsed.metadata)
          ? (parsed.metadata as Record<string, unknown>)
          : null;
      if (parsedMetadata) {
        checkExitCode(parsedMetadata.exit_code);
        checkExitCode(parsedMetadata.exitCode);
      }
      checkExitCode(parsed.exit_code);
      checkExitCode(parsed.exitCode);
    }

    const processExitMatch = output.match(/Process exited with code\s+(-?\d+)/i);
    if (processExitMatch) {
      const code = Number(processExitMatch[1]);
      if (Number.isFinite(code)) {
        metadata.exitCode = code;
        if (code !== 0) {
          success = false;
        }
      }
    }
  } else if (output && typeof output === "object" && !Array.isArray(output)) {
    const raw = output as Record<string, unknown>;
    checkExitCode(raw.exit_code);
    checkExitCode(raw.exitCode);
  }

  return {
    success,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function extractUserMessageText(payload: Record<string, unknown>): string {
  const message = payload.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return message.trim();
  }
  return "";
}

function recordCodexEvent(input: {
  sessionId: string;
  eventType: string;
  timestamp: string;
  repoPath?: string;
  branch?: string;
  payload?: Record<string, unknown>;
  toolCall?: RecordToolCallInput;
  dataDir?: string;
}): void {
  recordEvent(
    {
      sessionId: input.sessionId,
      provider: "openai",
      agent: "codex",
      eventType: input.eventType,
      timestamp: input.timestamp,
      repoPath: input.repoPath,
      branch: input.branch,
      payload: input.payload,
      toolCall: input.toolCall,
    },
    input.dataDir,
  );
}

function normalizeCodexSessionId(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.startsWith("codex-") ? trimmed : `codex-${trimmed}`;
}

export function enableCodex(options: EnableCodexOptions): EnableCodexResult {
  const historyPath = normalizeHistoryPath(options.historyPath);
  const sessionsPath = normalizeSessionsPath(options.sessionsPath);
  const config = loadAppConfig(options.dataDir);
  const integration = config.integrations?.codex;
  const existingCursor = integration?.cursor ?? 0;
  const existingSessionFileCursors = integration?.sessionFileCursors ?? {};
  const existingSessionFileState = integration?.sessionFileState ?? {};

  saveAppConfig(
    {
      ...config,
      integrations: {
        ...config.integrations,
        codex: {
          enabled: true,
          historyPath,
          cursor: existingCursor,
          sessionsPath,
          sessionFileCursors: existingSessionFileCursors,
          sessionFileState: existingSessionFileState,
        },
      },
    },
    options.dataDir,
  );

  return {
    historyPath,
    cursor: existingCursor,
    sessionsPath,
    trackedSessionFiles: Object.keys(existingSessionFileCursors).length,
  };
}

export function syncCodexHistory(options: SyncCodexOptions): SyncCodexResult {
  const config = loadAppConfig(options.dataDir);
  const integration = config.integrations?.codex;
  const historyPath = normalizeHistoryPath(options.historyPath ?? integration?.historyPath);
  const sessionsPath = normalizeSessionsPath(options.sessionsPath ?? integration?.sessionsPath);
  const rolloutFiles = listRolloutFiles(sessionsPath);
  const usingRolloutSource = rolloutFiles.length > 0;
  const historyExists = existsSync(historyPath);

  if (rolloutFiles.length === 0 && !historyExists) {
    return {
      status: "skipped",
      historyPath,
      sessionsPath,
      inserted: 0,
      skipped: 0,
      cursor: integration?.cursor ?? 0,
      touchedSessionIds: [],
      summarySessionIds: [],
      reason: "Codex sessions directory and history file are both missing",
    };
  }

  let inserted = 0;
  let skipped = 0;
  const touchedSessionIds = new Set<string>();
  const summarySessionIds = new Set<string>();
  let nextHistoryCursor = integration?.cursor ?? 0;
  const nextSessionFileCursors: Record<string, number> = {
    ...(integration?.sessionFileCursors ?? {}),
  };
  const nextSessionFileState: Record<string, PersistedRolloutFileState> = {
    ...(integration?.sessionFileState ?? {}),
  };

  if (rolloutFiles.length > 0) {
    const activeFiles = new Set(rolloutFiles);
    for (const path of Object.keys(nextSessionFileCursors)) {
      if (!activeFiles.has(path)) {
        delete nextSessionFileCursors[path];
      }
    }
    for (const path of Object.keys(nextSessionFileState)) {
      if (!activeFiles.has(path)) {
        delete nextSessionFileState[path];
      }
    }

    for (const filePath of rolloutFiles) {
      const { lines, nextCursor } = readIncrementalJsonLines(
        filePath,
        nextSessionFileCursors[filePath] ?? 0,
      );
      nextSessionFileCursors[filePath] = nextCursor;
      const persistedState = nextSessionFileState[filePath];

      const state: CodexRolloutFileState = {
        sessionId: persistedState?.sessionId ?? inferSessionIdFromRolloutFile(filePath),
        repoPath: persistedState?.repoPath,
        branch: persistedState?.branch,
        openToolCalls: new Map<string, OpenToolCall>(),
      };

      for (const line of lines) {
        const record = parseRolloutLine(line);
        if (!record) {
          if (line.trim().length > 0) {
            skipped += 1;
          }
          continue;
        }

        const timestamp = toIsoTimestamp(record.timestamp, new Date().toISOString());

        if (record.type === "session_meta") {
          const metaPayload = record.payload;
          const rawSessionId = extractOptionalString(metaPayload ?? {}, ["id"]);
          const sessionId = normalizeCodexSessionId(rawSessionId) ?? state.sessionId;
          if (!sessionId) {
            skipped += 1;
            continue;
          }

          state.sessionId = sessionId;
          state.repoPath = extractOptionalString(metaPayload ?? {}, ["cwd"]) ?? state.repoPath;
          state.branch = extractBranchFromMeta(metaPayload) ?? state.branch;

          const payload: Record<string, unknown> = {
            source: CODEX_SESSIONS_SOURCE,
            recordType: "session_meta",
          };
          if (metaPayload) {
            if (typeof metaPayload.model_provider === "string") {
              payload.modelProvider = metaPayload.model_provider;
            }
            if (typeof metaPayload.originator === "string") {
              payload.originator = metaPayload.originator;
            }
            if (typeof metaPayload.source === "string") {
              payload.sourceClient = metaPayload.source;
            }
            if (typeof metaPayload.cli_version === "string") {
              payload.cliVersion = metaPayload.cli_version;
            }
          }

          recordCodexEvent({
            sessionId,
            eventType: "session_started",
            timestamp,
            repoPath: state.repoPath,
            branch: state.branch,
            payload,
            dataDir: options.dataDir,
          });
          touchedSessionIds.add(sessionId);
          inserted += 1;
          continue;
        }

        if (record.type === "turn_context") {
          const turnPayload = record.payload;
          if (turnPayload) {
            state.repoPath =
              extractOptionalString(turnPayload, ["cwd", "repo_path", "repoPath"]) ??
              state.repoPath;
          }
          continue;
        }

        if (!state.sessionId) {
          skipped += 1;
          continue;
        }

        if (record.type === "event_msg") {
          const eventPayload = record.payload ?? {};
          const eventType =
            typeof eventPayload.type === "string" ? eventPayload.type : "unknown";

          if (eventType === "user_message") {
            const prompt = extractUserMessageText(eventPayload);
            if (prompt.length === 0) {
              continue;
            }

            recordCodexEvent({
              sessionId: state.sessionId,
              eventType: "request_sent",
              timestamp,
              repoPath: state.repoPath,
              branch: state.branch,
              payload: buildPromptPayload(
                prompt,
                CODEX_SESSIONS_SOURCE,
                config.privacy,
                { eventType: "user_message" },
              ),
              dataDir: options.dataDir,
            });
            touchedSessionIds.add(state.sessionId);
            inserted += 1;
            continue;
          }

          if (eventType === "task_complete") {
            recordCodexEvent({
              sessionId: state.sessionId,
              eventType: "session_stopped",
              timestamp,
              repoPath: state.repoPath,
              branch: state.branch,
              payload: {
                source: CODEX_SESSIONS_SOURCE,
                eventType: "task_complete",
              },
              dataDir: options.dataDir,
            });
            touchedSessionIds.add(state.sessionId);
            summarySessionIds.add(state.sessionId);
            inserted += 1;
            continue;
          }

          continue;
        }

        if (record.type !== "response_item") {
          continue;
        }

        const payload = record.payload ?? {};
        const payloadType =
          typeof payload.type === "string" ? payload.type : "unknown";

        if (payloadType === "function_call" || payloadType === "custom_tool_call") {
          const toolName = extractOptionalString(payload, ["name"]) ?? "unknown_tool";
          const callId = extractOptionalString(payload, ["call_id"]) ?? "";

          if (callId.length > 0) {
            state.openToolCalls.set(callId, {
              toolName,
              startedAt: timestamp,
            });
          }

          recordCodexEvent({
            sessionId: state.sessionId,
            eventType: "tool_pre_use",
            timestamp,
            repoPath: state.repoPath,
            branch: state.branch,
            payload: {
              source: CODEX_SESSIONS_SOURCE,
              payloadType,
              toolName,
              callId,
              toolInputKeys: resolveToolInputKeys(payload.arguments ?? payload.input),
            },
            dataDir: options.dataDir,
          });
          touchedSessionIds.add(state.sessionId);
          inserted += 1;
          continue;
        }

        if (
          payloadType === "function_call_output" ||
          payloadType === "custom_tool_call_output"
        ) {
          const callId = extractOptionalString(payload, ["call_id"]) ?? "";
          const openCall =
            callId.length > 0 ? state.openToolCalls.get(callId) : undefined;
          if (callId.length > 0) {
            state.openToolCalls.delete(callId);
          }

          const toolName = openCall?.toolName ?? "unknown_tool";
          const toolStart = openCall?.startedAt ?? timestamp;
          const durationMs = Math.max(
            0,
            Date.parse(timestamp) - Date.parse(toolStart),
          );
          const toolResult = inferToolResult(payload.output);

          recordCodexEvent({
            sessionId: state.sessionId,
            eventType: "tool_post_use",
            timestamp,
            repoPath: state.repoPath,
            branch: state.branch,
            payload: {
              source: CODEX_SESSIONS_SOURCE,
              payloadType,
              toolName,
              callId,
            },
            toolCall: {
              toolName,
              success: toolResult.success,
              startedAt: toolStart,
              finishedAt: timestamp,
              durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
              metadata: toolResult.metadata,
            },
            dataDir: options.dataDir,
          });
          touchedSessionIds.add(state.sessionId);
          inserted += 1;
          continue;
        }
      }

      nextSessionFileState[filePath] = {
        sessionId: state.sessionId ?? undefined,
        repoPath: state.repoPath,
        branch: state.branch,
      };
    }
  } else if (historyExists) {
    const { lines, nextCursor } = readIncrementalJsonLines(
      historyPath,
      integration?.cursor ?? 0,
    );
    nextHistoryCursor = nextCursor;

    for (const line of lines) {
      const entry = parseHistoryLine(line);
      if (!entry) {
        if (line.trim().length > 0) {
          skipped += 1;
        }
        continue;
      }

      const sessionId = normalizeCodexSessionId(entry.session_id);
      if (!sessionId) {
        skipped += 1;
        continue;
      }

      recordCodexEvent({
        sessionId,
        eventType: "request_sent",
        timestamp: new Date(entry.ts * 1000).toISOString(),
        repoPath: entry.repoPath,
        payload: buildPromptPayload(
          entry.text,
          CODEX_HISTORY_SOURCE,
          config.privacy,
        ),
        dataDir: options.dataDir,
      });
      touchedSessionIds.add(sessionId);
      inserted += 1;
    }
  }

  saveAppConfig(
    {
      ...config,
      integrations: {
        ...config.integrations,
        codex: {
          enabled: true,
          historyPath,
          cursor: nextHistoryCursor,
          sessionsPath,
          sessionFileCursors: nextSessionFileCursors,
          sessionFileState: nextSessionFileState,
        },
      },
    },
    options.dataDir,
  );

  return {
    status: "ok",
    historyPath,
    sessionsPath,
    inserted,
    skipped,
    cursor: nextHistoryCursor,
    touchedSessionIds: [...touchedSessionIds],
    summarySessionIds: usingRolloutSource
      ? [...summarySessionIds]
      : [...touchedSessionIds],
  };
}
