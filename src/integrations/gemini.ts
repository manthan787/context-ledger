import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAppConfig, saveAppConfig } from "../config";
import { redactText } from "../privacy/redaction";
import { recordEvent } from "../storage/db";

interface GeminiHistoryEntry {
  sessionId: string;
  timestampMs: number;
  prompt: string;
}

export interface EnableGeminiOptions {
  dataDir?: string;
  historyPath?: string;
}

export interface EnableGeminiResult {
  historyPath: string;
  cursor: number;
}

export interface SyncGeminiOptions {
  dataDir?: string;
  historyPath?: string;
}

export interface SyncGeminiResult {
  status: "ok" | "skipped";
  historyPath: string;
  inserted: number;
  skipped: number;
  cursor: number;
  touchedSessionIds: string[];
  reason?: string;
}

function getDefaultHistoryPath(): string {
  return join(homedir(), ".gemini", "history.jsonl");
}

function normalizeHistoryPath(input?: string): string {
  return input && input.trim().length > 0 ? input.trim() : getDefaultHistoryPath();
}

function normalizeTimestamp(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1000_000_000_000 ? raw : raw * 1000;
  }

  if (typeof raw === "string" && raw.trim().length > 0) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      return numeric > 1000_000_000_000 ? numeric : numeric * 1000;
    }

    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseGeminiHistoryLine(line: string): GeminiHistoryEntry | null {
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
  const sessionId =
    (typeof raw.session_id === "string" && raw.session_id.trim()) ||
    (typeof raw.sessionId === "string" && raw.sessionId.trim()) ||
    (typeof raw.conversation_id === "string" && raw.conversation_id.trim()) ||
    (typeof raw.chat_id === "string" && raw.chat_id.trim()) ||
    "";
  const prompt =
    (typeof raw.text === "string" && raw.text) ||
    (typeof raw.prompt === "string" && raw.prompt) ||
    (typeof raw.input === "string" && raw.input) ||
    (typeof raw.message === "string" && raw.message) ||
    "";
  const timestampMs =
    normalizeTimestamp(raw.ts) ??
    normalizeTimestamp(raw.timestamp) ??
    normalizeTimestamp(raw.created_at) ??
    normalizeTimestamp(raw.createdAt) ??
    normalizeTimestamp(raw.time);

  if (sessionId.length === 0 || prompt.trim().length === 0 || timestampMs === null) {
    return null;
  }

  return {
    sessionId,
    timestampMs,
    prompt,
  };
}

export function enableGemini(options: EnableGeminiOptions): EnableGeminiResult {
  const historyPath = normalizeHistoryPath(options.historyPath);
  const config = loadAppConfig(options.dataDir);
  const existingCursor = config.integrations?.gemini?.cursor ?? 0;

  saveAppConfig(
    {
      ...config,
      integrations: {
        ...config.integrations,
        gemini: {
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

export function syncGeminiHistory(options: SyncGeminiOptions): SyncGeminiResult {
  const config = loadAppConfig(options.dataDir);
  const integration = config.integrations?.gemini;
  const historyPath = normalizeHistoryPath(options.historyPath ?? integration?.historyPath);

  if (!existsSync(historyPath)) {
    return {
      status: "skipped",
      historyPath,
      inserted: 0,
      skipped: 0,
      cursor: integration?.cursor ?? 0,
      touchedSessionIds: [],
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
  const touchedSessionIds = new Set<string>();

  for (const line of lines) {
    const entry = parseGeminiHistoryLine(line);
    if (!entry) {
      if (line.trim().length > 0) {
        skipped += 1;
      }
      continue;
    }

    const prompt = redactText(entry.prompt, config.privacy);
    const payload: Record<string, unknown> = {
      source: "gemini_history_jsonl",
      promptLength: prompt.length,
    };
    if (config.privacy.capturePrompts) {
      payload.prompt = prompt;
    }

    const sessionId = `gemini-${entry.sessionId}`;
    recordEvent(
      {
        sessionId,
        provider: "google",
        agent: "gemini",
        eventType: "request_sent",
        timestamp: new Date(entry.timestampMs).toISOString(),
        payload,
      },
      options.dataDir,
    );
    touchedSessionIds.add(sessionId);
    inserted += 1;
  }

  const nextCursor = currentLength;
  saveAppConfig(
    {
      ...config,
      integrations: {
        ...config.integrations,
        gemini: {
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
    touchedSessionIds: [...touchedSessionIds],
  };
}
