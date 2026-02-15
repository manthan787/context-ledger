import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadAppConfig, saveAppConfig } from "../config";
import { redactText } from "../privacy/redaction";
import {
  getDataDir,
  getDatabasePath,
  initDatabase,
  recordEvent,
} from "../storage/db";
import {
  buildPromptPayload,
  extractOptionalString,
  normalizeTimestamp,
  readIncrementalJsonLines,
} from "./shared";

type ClaudeHookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStop"
  | "PreCompact"
  | "Notification";

interface ClaudeCommandHook {
  type: "command";
  command: string;
  async?: boolean;
  timeout?: number;
}

interface ClaudeHookMatcher {
  matcher?: string;
  hooks: ClaudeCommandHook[];
}

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookMatcher[]>;
  [key: string]: unknown;
}

interface ClaudeHookPayload {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: unknown;
  prompt?: string;
  [key: string]: unknown;
}

interface ClaudeProjectRecord {
  type?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string | number;
  uuid?: string;
  requestId?: string;
  sourceToolAssistantUUID?: string;
  message?: unknown;
  toolUseResult?: unknown;
  [key: string]: unknown;
}

interface ClaudeBackfillOpenToolCall {
  toolName: string;
  toolId?: string;
  startedAt: string;
}

export type ClaudeEnableScope = "user" | "project";

export interface EnableClaudeOptions {
  scope: ClaudeEnableScope;
  cwd: string;
  dataDir?: string;
  projectsPath?: string;
  cliEntrypointPath: string;
  nodePath: string;
}

export interface EnableClaudeResult {
  settingsPath: string;
  dataDir: string;
  dbPath: string;
  addedHooks: number;
  projectsPath: string;
  trackedSessionFiles: number;
}

export interface SyncClaudeBackfillOptions {
  dataDir?: string;
  projectsPath?: string;
  force?: boolean;
}

export interface SyncClaudeBackfillResult {
  status: "ok" | "skipped";
  projectsPath: string;
  inserted: number;
  skipped: number;
  touchedSessionIds: string[];
  reason?: string;
}

export interface IngestClaudeHookResult {
  sessionId: string;
  hookEventName: string;
  eventType: string;
}

const CLAUDE_HOOKS: Array<{ event: ClaudeHookEventName; matcher?: string }> = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
  { event: "PreToolUse", matcher: "*" },
  { event: "PostToolUse", matcher: "*" },
  { event: "Stop" },
  { event: "SessionEnd" },
];

const EVENT_TYPE_MAP: Record<string, string> = {
  SessionStart: "session_started",
  SessionEnd: "session_ended",
  UserPromptSubmit: "request_sent",
  PreToolUse: "tool_pre_use",
  PostToolUse: "tool_post_use",
  Stop: "session_stopped",
  SubagentStop: "subagent_stopped",
  PreCompact: "pre_compact",
  Notification: "notification",
};

const CLAUDE_HOOK_SOURCE = "claude_hook";
const CLAUDE_PROJECTS_SOURCE = "claude_projects_jsonl";

function shellQuote(input: string): string {
  return `'${input.replace(/'/g, "'\\''")}'`;
}

function buildHookCommand(
  nodePath: string,
  cliEntrypointPath: string,
  dataDir: string,
): string {
  const args = [
    nodePath,
    cliEntrypointPath,
    "internal-hook-ingest",
    "--agent",
    "claude",
    "--data-dir",
    dataDir,
  ];
  return `${args.map(shellQuote).join(" ")} >/dev/null 2>&1 || true`;
}

function getSettingsPath(scope: ClaudeEnableScope, cwd: string): string {
  if (scope === "project") {
    return join(cwd, ".claude", "settings.local.json");
  }
  return join(homedir(), ".claude", "settings.json");
}

function getDefaultProjectsPath(): string {
  return join(homedir(), ".claude", "projects");
}

function normalizeProjectsPath(input?: string): string {
  return input && input.trim().length > 0 ? input.trim() : getDefaultProjectsPath();
}

function normalizeClaudeSessionId(raw: string | undefined): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function inferSessionIdFromProjectFile(filePath: string): string | null {
  const fileName = basename(filePath);
  const match = fileName.match(/([0-9a-f-]{36})\.jsonl$/i);
  if (!match) {
    return null;
  }
  return match[1];
}

function listClaudeProjectSessionFiles(rootDir: string): string[] {
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
      if (entry.isFile() && entryName.endsWith(".jsonl")) {
        out.push(fullPath);
      }
    }
  }

  return out.sort((a, b) => a.localeCompare(b));
}

function parseClaudeProjectLine(line: string): ClaudeProjectRecord | null {
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

  return parsed as ClaudeProjectRecord;
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

function extractUserPromptFromClaudeMessage(message: unknown): string {
  if (typeof message === "string") {
    return message.trim();
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return "";
  }

  const raw = message as Record<string, unknown>;
  const content = raw.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const typed = item as Record<string, unknown>;
    if (typed.type !== "text") {
      continue;
    }
    if (typeof typed.text === "string" && typed.text.trim().length > 0) {
      parts.push(typed.text.trim());
    }
  }
  return parts.join("\n").trim();
}

function extractAssistantToolUses(message: unknown): Array<{
  toolName: string;
  toolId?: string;
  toolInputKeys?: string[];
}> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return [];
  }

  const raw = message as Record<string, unknown>;
  const content = raw.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const out: Array<{ toolName: string; toolId?: string; toolInputKeys?: string[] }> = [];
  for (const item of content) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const typed = item as Record<string, unknown>;
    if (typed.type !== "tool_use") {
      continue;
    }
    const toolName = typeof typed.name === "string" ? typed.name.trim() : "unknown_tool";
    if (toolName.length === 0) {
      continue;
    }
    const toolId = typeof typed.id === "string" && typed.id.trim().length > 0
      ? typed.id.trim()
      : undefined;
    const toolInputKeys =
      typed.input && typeof typed.input === "object" && !Array.isArray(typed.input)
        ? Object.keys(typed.input as Record<string, unknown>)
        : undefined;
    out.push({
      toolName,
      toolId,
      toolInputKeys,
    });
  }

  return out;
}

function inferClaudeToolResult(output: unknown): {
  success: boolean;
  metadata: Record<string, unknown> | undefined;
} {
  let success = true;
  const metadata: Record<string, unknown> = {};

  const setExitCode = (value: unknown): void => {
    if (typeof value === "number" && Number.isFinite(value)) {
      metadata.exitCode = value;
      if (value !== 0) {
        success = false;
      }
    }
  };

  if (typeof output === "string") {
    metadata.resultType = "string";
    metadata.outputLength = output.length;
    if (/\b(rejected|interrupted|error|failed)\b/i.test(output)) {
      success = false;
    }
  } else if (output && typeof output === "object" && !Array.isArray(output)) {
    const raw = output as Record<string, unknown>;
    metadata.resultType = "object";
    metadata.resultKeys = Object.keys(raw).slice(0, 12);

    if (raw.is_error === true || raw.interrupted === true || raw.error) {
      success = false;
    }

    if (typeof raw.stderr === "string") {
      metadata.stderrLength = raw.stderr.length;
    }
    if (typeof raw.stdout === "string") {
      metadata.stdoutLength = raw.stdout.length;
    }

    setExitCode(raw.exitCode);
    setExitCode(raw.exit_code);
  } else {
    metadata.resultType = typeof output;
  }

  return {
    success,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function loadSettings(settingsPath: string): ClaudeSettings {
  if (!existsSync(settingsPath)) {
    return {};
  }

  const raw = readFileSync(settingsPath, "utf8").trim();
  if (raw.length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Failed to parse Claude settings JSON: ${settingsPath}`, {
      cause: error,
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Claude settings must contain a JSON object: ${settingsPath}`);
  }

  return parsed as ClaudeSettings;
}

function addHook(
  settings: ClaudeSettings,
  event: ClaudeHookEventName,
  matcher: string | undefined,
  hook: ClaudeCommandHook,
): boolean {
  if (!settings.hooks) {
    settings.hooks = {};
  }

  if (!settings.hooks[event]) {
    settings.hooks[event] = [];
  }

  const groups = settings.hooks[event];
  const normalizedMatcher = matcher ?? null;

  let group = groups.find((candidate) => {
    const existingMatcher = candidate.matcher ?? null;
    return existingMatcher === normalizedMatcher;
  });

  if (!group) {
    group = matcher ? { matcher, hooks: [] } : { hooks: [] };
    groups.push(group);
  }

  const alreadyExists = group.hooks.some((candidate) => {
    return candidate.type === hook.type && candidate.command === hook.command;
  });

  if (alreadyExists) {
    return false;
  }

  group.hooks.push(hook);
  return true;
}

function sanitizePayload(payload: ClaudeHookPayload): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    source: CLAUDE_HOOK_SOURCE,
  };

  if (typeof payload.hook_event_name === "string") {
    metadata.hookEventName = payload.hook_event_name;
  }
  if (typeof payload.cwd === "string") {
    metadata.cwd = payload.cwd;
  }
  if (typeof payload.transcript_path === "string") {
    metadata.transcriptPath = payload.transcript_path;
  }
  if (typeof payload.tool_name === "string") {
    metadata.toolName = payload.tool_name;
  }
  if (typeof payload.prompt === "string") {
    metadata.promptLength = payload.prompt.length;
  }
  if (
    payload.tool_input &&
    typeof payload.tool_input === "object" &&
    !Array.isArray(payload.tool_input)
  ) {
    metadata.toolInputKeys = Object.keys(payload.tool_input as Record<string, unknown>);
  }

  return metadata;
}

function sanitizePayloadWithPrivacy(
  payload: ClaudeHookPayload,
  options: { capturePrompts: boolean; redactPrompt: (input: string) => string },
): Record<string, unknown> {
  const metadata = sanitizePayload(payload);

  if (options.capturePrompts && typeof payload.prompt === "string") {
    metadata.prompt = options.redactPrompt(payload.prompt);
  }

  return metadata;
}

export function enableClaude(options: EnableClaudeOptions): EnableClaudeResult {
  const scope = options.scope;
  const settingsPath = getSettingsPath(scope, options.cwd);
  const settingsDir = dirname(settingsPath);
  mkdirSync(settingsDir, { recursive: true });

  const dataDir = getDataDir(options.dataDir);
  const { dbPath } = initDatabase(dataDir);
  const projectsPath = normalizeProjectsPath(options.projectsPath);
  const hookCommand = buildHookCommand(
    options.nodePath,
    options.cliEntrypointPath,
    dataDir,
  );
  const commandHook: ClaudeCommandHook = {
    type: "command",
    command: hookCommand,
    async: true,
    timeout: 5,
  };

  const settings = loadSettings(settingsPath);
  let addedHooks = 0;

  for (const hook of CLAUDE_HOOKS) {
    const changed = addHook(
      settings,
      hook.event,
      hook.matcher,
      commandHook,
    );
    if (changed) {
      addedHooks += 1;
    }
  }

  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const config = loadAppConfig(options.dataDir);
  const existingClaude = config.integrations?.claude;
  const isSameProjectsPath = existingClaude?.projectsPath === projectsPath;
  const sessionFileCursors = isSameProjectsPath
    ? (existingClaude?.sessionFileCursors ?? {})
    : {};
  const sessionFileState = isSameProjectsPath
    ? (existingClaude?.sessionFileState ?? {})
    : {};
  const backfillComplete =
    isSameProjectsPath && existingClaude
      ? (existingClaude.backfillComplete ?? false)
      : false;

  saveAppConfig(
    {
      ...config,
      integrations: {
        ...config.integrations,
        claude: {
          enabled: true,
          projectsPath,
          sessionFileCursors,
          sessionFileState,
          backfillComplete,
        },
      },
    },
    options.dataDir,
  );

  return {
    settingsPath,
    dataDir,
    dbPath: getDatabasePath(dataDir),
    addedHooks,
    projectsPath,
    trackedSessionFiles: Object.keys(sessionFileCursors).length,
  };
}

export function syncClaudeBackfill(
  options: SyncClaudeBackfillOptions,
): SyncClaudeBackfillResult {
  const config = loadAppConfig(options.dataDir);
  const integration = config.integrations?.claude;
  const projectsPath = normalizeProjectsPath(options.projectsPath ?? integration?.projectsPath);

  if (integration?.backfillComplete && !options.force) {
    return {
      status: "skipped",
      projectsPath,
      inserted: 0,
      skipped: 0,
      touchedSessionIds: [],
      reason: "Claude backfill already completed (hooks handle live capture).",
    };
  }

  const sessionFiles = listClaudeProjectSessionFiles(projectsPath);
  if (!existsSync(projectsPath) || sessionFiles.length === 0) {
    saveAppConfig(
      {
        ...config,
        integrations: {
          ...config.integrations,
          claude: {
            enabled: true,
            projectsPath,
            sessionFileCursors: integration?.sessionFileCursors,
            sessionFileState: integration?.sessionFileState,
            backfillComplete: true,
          },
        },
      },
      options.dataDir,
    );
    return {
      status: "skipped",
      projectsPath,
      inserted: 0,
      skipped: 0,
      touchedSessionIds: [],
      reason: !existsSync(projectsPath)
        ? "Claude projects directory does not exist"
        : "No Claude session files found",
    };
  }

  const nextSessionFileCursors: Record<string, number> = {};
  const nextSessionFileState: Record<string, { sessionId?: string; repoPath?: string; branch?: string }> = {};
  const touchedSessionIds = new Set<string>();
  let inserted = 0;
  let skipped = 0;

  for (const filePath of sessionFiles) {
    const existingCursor =
      options.force === true
        ? 0
        : (integration?.sessionFileCursors?.[filePath] ?? 0);
    const { lines, nextCursor } = readIncrementalJsonLines(filePath, existingCursor);
    nextSessionFileCursors[filePath] = nextCursor;

    const persistedState = integration?.sessionFileState?.[filePath];
    const state = {
      sessionId:
        normalizeClaudeSessionId(persistedState?.sessionId) ??
        inferSessionIdFromProjectFile(filePath),
      repoPath: persistedState?.repoPath,
      branch: persistedState?.branch,
      openToolCalls: new Map<string, ClaudeBackfillOpenToolCall[]>(),
    };
    let recordedSessionStart = existingCursor > 0;

    for (const line of lines) {
      const record = parseClaudeProjectLine(line);
      if (!record) {
        if (line.trim().length > 0) {
          skipped += 1;
        }
        continue;
      }

      const timestamp = toIsoTimestamp(record.timestamp, new Date().toISOString());
      const sessionId =
        normalizeClaudeSessionId(record.sessionId) ?? state.sessionId;
      if (!sessionId) {
        skipped += 1;
        continue;
      }

      state.sessionId = sessionId;
      state.repoPath =
        extractOptionalString(record, ["cwd", "projectPath", "project_path"]) ??
        state.repoPath;
      state.branch =
        extractOptionalString(record, ["gitBranch", "git_branch", "branch"]) ??
        state.branch;

      if (!recordedSessionStart) {
        recordEvent(
          {
            sessionId,
            provider: "anthropic",
            agent: "claude-code",
            eventType: "session_started",
            timestamp,
            repoPath: state.repoPath,
            branch: state.branch,
            payload: {
              source: CLAUDE_PROJECTS_SOURCE,
              recordType: "session_start_backfill",
            },
          },
          options.dataDir,
        );
        touchedSessionIds.add(sessionId);
        inserted += 1;
        recordedSessionStart = true;
      }

      if (record.type === "assistant") {
        const assistantUuid = extractOptionalString(record, ["uuid"]);
        const requestId = extractOptionalString(record, ["requestId", "request_id"]);
        const toolUses = extractAssistantToolUses(record.message);
        for (const toolUse of toolUses) {
          if (assistantUuid) {
            const queue = state.openToolCalls.get(assistantUuid) ?? [];
            queue.push({
              toolName: toolUse.toolName,
              toolId: toolUse.toolId,
              startedAt: timestamp,
            });
            state.openToolCalls.set(assistantUuid, queue);
          }

          recordEvent(
            {
              sessionId,
              provider: "anthropic",
              agent: "claude-code",
              eventType: "tool_pre_use",
              timestamp,
              repoPath: state.repoPath,
              branch: state.branch,
              payload: {
                source: CLAUDE_PROJECTS_SOURCE,
                assistantUuid,
                requestId,
                toolName: toolUse.toolName,
                toolId: toolUse.toolId,
                toolInputKeys: toolUse.toolInputKeys,
              },
            },
            options.dataDir,
          );
          touchedSessionIds.add(sessionId);
          inserted += 1;
        }
        continue;
      }

      if (record.type !== "user") {
        continue;
      }

      const hasToolResult = Object.prototype.hasOwnProperty.call(record, "toolUseResult");
      if (hasToolResult) {
        const sourceToolAssistantUUID = extractOptionalString(record, [
          "sourceToolAssistantUUID",
          "source_tool_assistant_uuid",
        ]);
        const queue = sourceToolAssistantUUID
          ? state.openToolCalls.get(sourceToolAssistantUUID)
          : undefined;
        const openCall = queue && queue.length > 0 ? queue.shift() : undefined;
        if (queue && queue.length === 0 && sourceToolAssistantUUID) {
          state.openToolCalls.delete(sourceToolAssistantUUID);
        }

        const toolName = openCall?.toolName ?? "unknown_tool";
        const toolStart = openCall?.startedAt ?? timestamp;
        const durationMs = Math.max(
          0,
          Date.parse(timestamp) - Date.parse(toolStart),
        );
        const toolResult = inferClaudeToolResult(record.toolUseResult);

        recordEvent(
          {
            sessionId,
            provider: "anthropic",
            agent: "claude-code",
            eventType: "tool_post_use",
            timestamp,
            repoPath: state.repoPath,
            branch: state.branch,
            payload: {
              source: CLAUDE_PROJECTS_SOURCE,
              sourceToolAssistantUUID,
              toolName,
              toolId: openCall?.toolId,
            },
            toolCall: {
              toolName,
              success: toolResult.success,
              startedAt: toolStart,
              finishedAt: timestamp,
              durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
              metadata: toolResult.metadata,
            },
          },
          options.dataDir,
        );
        touchedSessionIds.add(sessionId);
        inserted += 1;
        continue;
      }

      const prompt = extractUserPromptFromClaudeMessage(record.message);
      if (prompt.length === 0) {
        continue;
      }

      recordEvent(
        {
          sessionId,
          provider: "anthropic",
          agent: "claude-code",
          eventType: "request_sent",
          timestamp,
          repoPath: state.repoPath,
          branch: state.branch,
          payload: buildPromptPayload(prompt, CLAUDE_PROJECTS_SOURCE, config.privacy, {
            recordType: "user_message",
          }),
        },
        options.dataDir,
      );
      touchedSessionIds.add(sessionId);
      inserted += 1;
    }

    nextSessionFileState[filePath] = {
      sessionId: state.sessionId ?? undefined,
      repoPath: state.repoPath,
      branch: state.branch,
    };
  }

  saveAppConfig(
    {
      ...config,
      integrations: {
        ...config.integrations,
        claude: {
          enabled: true,
          projectsPath,
          sessionFileCursors: nextSessionFileCursors,
          sessionFileState: nextSessionFileState,
          backfillComplete: true,
        },
      },
    },
    options.dataDir,
  );

  return {
    status: "ok",
    projectsPath,
    inserted,
    skipped,
    touchedSessionIds: [...touchedSessionIds],
  };
}

export function ingestClaudeHookPayload(
  rawPayload: string,
  explicitDataDir?: string,
): IngestClaudeHookResult | null {
  const trimmedPayload = rawPayload.trim();
  if (trimmedPayload.length === 0) {
    return null;
  }

  let payload: ClaudeHookPayload;
  try {
    payload = JSON.parse(trimmedPayload) as ClaudeHookPayload;
  } catch {
    return null;
  }

  const hookEventName =
    typeof payload.hook_event_name === "string"
      ? payload.hook_event_name
      : "Unknown";

  const eventType =
    EVENT_TYPE_MAP[hookEventName] ??
    `claude_${hookEventName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  const sessionId = normalizeClaudeSessionId(payload.session_id) ?? `claude-${randomUUID()}`;
  const repoPath = typeof payload.cwd === "string" ? payload.cwd : undefined;
  const timestamp = new Date().toISOString();

  const toolName =
    typeof payload.tool_name === "string" ? payload.tool_name : undefined;
  // Record tool_calls only when a tool finishes to avoid double-counting.
  const toolCall = hookEventName === "PostToolUse" && toolName
    ? {
        toolName,
        success: true,
        startedAt: timestamp,
        finishedAt: timestamp,
      }
    : undefined;

  const appConfig = loadAppConfig(explicitDataDir);
  const capturePrompts = appConfig.privacy.capturePrompts;

  recordEvent(
    {
      sessionId,
      provider: "anthropic",
      agent: "claude-code",
      eventType,
      timestamp,
      repoPath,
      payload: sanitizePayloadWithPrivacy(payload, {
        capturePrompts,
        redactPrompt: (input) => redactText(input, appConfig.privacy),
      }),
      sessionStatus: hookEventName === "SessionEnd" ? "completed" : undefined,
      toolCall,
    },
    explicitDataDir,
  );

  return {
    sessionId,
    hookEventName,
    eventType,
  };
}
