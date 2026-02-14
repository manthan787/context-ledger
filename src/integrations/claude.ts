import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { loadAppConfig } from "../config";
import {
  getDataDir,
  getDatabasePath,
  initDatabase,
  recordEvent,
} from "../storage/db";

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

export type ClaudeEnableScope = "user" | "project";

export interface EnableClaudeOptions {
  scope: ClaudeEnableScope;
  cwd: string;
  dataDir?: string;
  cliEntrypointPath: string;
  nodePath: string;
}

export interface EnableClaudeResult {
  settingsPath: string;
  dataDir: string;
  dbPath: string;
  addedHooks: number;
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
  const metadata: Record<string, unknown> = {};

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
  options: { capturePrompts: boolean },
): Record<string, unknown> {
  const metadata = sanitizePayload(payload);

  if (options.capturePrompts && typeof payload.prompt === "string") {
    metadata.prompt = payload.prompt;
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

  return {
    settingsPath,
    dataDir,
    dbPath: getDatabasePath(dataDir),
    addedHooks,
  };
}

export function ingestClaudeHookPayload(
  rawPayload: string,
  explicitDataDir?: string,
): void {
  const trimmedPayload = rawPayload.trim();
  if (trimmedPayload.length === 0) {
    return;
  }

  let payload: ClaudeHookPayload;
  try {
    payload = JSON.parse(trimmedPayload) as ClaudeHookPayload;
  } catch {
    return;
  }

  const hookEventName =
    typeof payload.hook_event_name === "string"
      ? payload.hook_event_name
      : "Unknown";

  const eventType =
    EVENT_TYPE_MAP[hookEventName] ??
    `claude_${hookEventName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  const sessionId =
    typeof payload.session_id === "string" && payload.session_id.length > 0
      ? payload.session_id
      : `claude-${randomUUID()}`;
  const repoPath = typeof payload.cwd === "string" ? payload.cwd : undefined;
  const timestamp = new Date().toISOString();

  const toolName =
    typeof payload.tool_name === "string" ? payload.tool_name : undefined;
  const isToolEvent = hookEventName === "PreToolUse" || hookEventName === "PostToolUse";
  const toolCall = isToolEvent && toolName
    ? {
        toolName,
        success: true,
        startedAt: timestamp,
        finishedAt: hookEventName === "PostToolUse" ? timestamp : undefined,
      }
    : undefined;

  const appConfig = loadAppConfig(explicitDataDir);
  const capturePrompts = appConfig.privacy?.capturePrompts ?? false;

  recordEvent(
    {
      sessionId,
      provider: "anthropic",
      agent: "claude-code",
      eventType,
      timestamp,
      repoPath,
      payload: sanitizePayloadWithPrivacy(payload, { capturePrompts }),
      sessionStatus: hookEventName === "SessionEnd" ? "completed" : undefined,
      toolCall,
    },
    explicitDataDir,
  );
}
