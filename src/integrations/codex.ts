import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAppConfig, saveAppConfig } from "../config";
import { redactText } from "../privacy/redaction";
import { recordEvent } from "../storage/db";

interface CodexHistoryEntry {
  session_id: string;
  ts: number;
  text: string;
}

export interface EnableCodexOptions {
  dataDir?: string;
  historyPath?: string;
}

export interface EnableCodexResult {
  historyPath: string;
  cursor: number;
}

export interface SyncCodexOptions {
  dataDir?: string;
  historyPath?: string;
}

export interface SyncCodexResult {
  status: "ok" | "skipped";
  historyPath: string;
  inserted: number;
  skipped: number;
  cursor: number;
  reason?: string;
}

function getDefaultHistoryPath(): string {
  return join(homedir(), ".codex", "history.jsonl");
}

function normalizeHistoryPath(input?: string): string {
  return input && input.trim().length > 0 ? input.trim() : getDefaultHistoryPath();
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

  if (sessionId.length === 0 || !Number.isFinite(ts) || text.trim().length === 0) {
    return null;
  }

  return {
    session_id: sessionId,
    ts,
    text,
  };
}

export function enableCodex(options: EnableCodexOptions): EnableCodexResult {
  const historyPath = normalizeHistoryPath(options.historyPath);
  const config = loadAppConfig(options.dataDir);
  const existingCursor = config.integrations?.codex?.cursor ?? 0;

  saveAppConfig(
    {
      ...config,
      integrations: {
        ...config.integrations,
        codex: {
          enabled: true,
          historyPath,
          cursor: existingCursor,
        },
      },
    },
    options.dataDir,
  );

  return {
    historyPath,
    cursor: existingCursor,
  };
}

export function syncCodexHistory(options: SyncCodexOptions): SyncCodexResult {
  const config = loadAppConfig(options.dataDir);
  const integration = config.integrations?.codex;
  const historyPath = normalizeHistoryPath(options.historyPath ?? integration?.historyPath);

  if (!existsSync(historyPath)) {
    return {
      status: "skipped",
      historyPath,
      inserted: 0,
      skipped: 0,
      cursor: integration?.cursor ?? 0,
      reason: "History file does not exist",
    };
  }

  const contentBuffer = readFileSync(historyPath);
  const currentLength = contentBuffer.length;
  let cursor = integration?.cursor ?? 0;
  if (!Number.isFinite(cursor) || cursor < 0 || cursor > currentLength) {
    cursor = 0;
  }

  const chunk = contentBuffer.toString("utf8", cursor);
  const lines = chunk.split(/\r?\n/);

  let inserted = 0;
  let skipped = 0;

  for (const line of lines) {
    const entry = parseHistoryLine(line);
    if (!entry) {
      if (line.trim().length > 0) {
        skipped += 1;
      }
      continue;
    }

    const timestampIso = new Date(entry.ts * 1000).toISOString();
    const prompt = redactText(entry.text, config.privacy);
    const payload: Record<string, unknown> = {
      source: "codex_history_jsonl",
      promptLength: prompt.length,
    };
    if (config.privacy.capturePrompts) {
      payload.prompt = prompt;
    }

    recordEvent(
      {
        sessionId: `codex-${entry.session_id}`,
        provider: "openai",
        agent: "codex",
        eventType: "request_sent",
        timestamp: timestampIso,
        payload,
      },
      options.dataDir,
    );
    inserted += 1;
  }

  const nextCursor = currentLength;
  saveAppConfig(
    {
      ...config,
      integrations: {
        ...config.integrations,
        codex: {
          enabled: true,
          historyPath,
          cursor: nextCursor,
        },
      },
    },
    options.dataDir,
  );

  return {
    status: "ok",
    historyPath,
    inserted,
    skipped,
    cursor: nextCursor,
  };
}
