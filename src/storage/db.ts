import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const APP_NAME = "ContextLedger";
export const DEFAULT_DATA_DIR = join(homedir(), ".context-ledger");
export const DB_FILENAME = "context-ledger.db";

export type SessionStatus = "active" | "completed" | "abandoned";

export interface InitDatabaseResult {
  dbPath: string;
  dataDir: string;
}

export interface RecordToolCallInput {
  toolName: string;
  success: boolean;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  metadata?: unknown;
}

export interface RecordEventInput {
  sessionId: string;
  provider: string;
  agent: string;
  eventType: string;
  timestamp?: string;
  repoPath?: string;
  branch?: string;
  payload?: unknown;
  sessionStatus?: SessionStatus;
  toolCall?: RecordToolCallInput;
}

export function getDataDir(explicitDataDir?: string): string {
  return explicitDataDir ?? DEFAULT_DATA_DIR;
}

export function getDatabasePath(dataDir: string): string {
  return join(dataDir, DB_FILENAME);
}

function createSchema(db: Database.Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      agent TEXT NOT NULL,
      repo_path TEXT,
      branch TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'abandoned')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      duration_ms INTEGER,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      event_id TEXT,
      tool_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER,
      success INTEGER NOT NULL CHECK (success IN (0, 1)),
      metadata_json TEXT,
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name);

    CREATE TABLE IF NOT EXISTS intent_labels (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      label TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      source TEXT NOT NULL,
      reason_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_intent_labels_session_id ON intent_labels(session_id);
    CREATE INDEX IF NOT EXISTS idx_intent_labels_label ON intent_labels(label);

    CREATE TABLE IF NOT EXISTS capsules (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      summary_markdown TEXT NOT NULL,
      decisions_json TEXT,
      todos_json TEXT,
      files_json TEXT,
      commands_json TEXT,
      errors_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS resume_packs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_session_ids_json TEXT NOT NULL,
      token_budget INTEGER NOT NULL,
      content_markdown TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export function initDatabase(explicitDataDir?: string): InitDatabaseResult {
  const dataDir = getDataDir(explicitDataDir);
  mkdirSync(dataDir, { recursive: true });
  const dbPath = getDatabasePath(dataDir);
  const db = new Database(dbPath);

  try {
    createSchema(db);
  } finally {
    db.close();
  }

  return { dbPath, dataDir };
}

function openWritableDatabase(explicitDataDir?: string): Database.Database {
  const dataDir = getDataDir(explicitDataDir);
  mkdirSync(dataDir, { recursive: true });
  const dbPath = getDatabasePath(dataDir);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 3000");
  createSchema(db);
  return db;
}

function safeJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

export function recordEvent(
  input: RecordEventInput,
  explicitDataDir?: string,
): { eventId: string } {
  const db = openWritableDatabase(explicitDataDir);
  const timestamp = input.timestamp ?? new Date().toISOString();
  const eventId = randomUUID();

  const tx = db.transaction(() => {
    const existingSession = db
      .prepare("SELECT id FROM sessions WHERE id = ?")
      .get(input.sessionId) as { id: string } | undefined;

    if (!existingSession) {
      db.prepare(
        `
          INSERT INTO sessions (
            id,
            provider,
            agent,
            repo_path,
            branch,
            started_at,
            status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        input.sessionId,
        input.provider,
        input.agent,
        input.repoPath ?? null,
        input.branch ?? null,
        timestamp,
        input.sessionStatus ?? "active",
      );
    } else {
      db.prepare(
        `
          UPDATE sessions
          SET
            repo_path = COALESCE(repo_path, ?),
            branch = COALESCE(branch, ?),
            updated_at = datetime('now')
          WHERE id = ?
        `,
      ).run(input.repoPath ?? null, input.branch ?? null, input.sessionId);
    }

    db.prepare(
      `
        INSERT INTO events (
          id,
          session_id,
          event_type,
          timestamp,
          duration_ms,
          payload_json
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `,
    ).run(
      eventId,
      input.sessionId,
      input.eventType,
      timestamp,
      input.toolCall?.durationMs ?? null,
      safeJson(input.payload),
    );

    if (input.toolCall) {
      db.prepare(
        `
          INSERT INTO tool_calls (
            id,
            session_id,
            event_id,
            tool_name,
            started_at,
            finished_at,
            duration_ms,
            success,
            metadata_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      ).run(
        randomUUID(),
        input.sessionId,
        eventId,
        input.toolCall.toolName,
        input.toolCall.startedAt ?? timestamp,
        input.toolCall.finishedAt ?? null,
        input.toolCall.durationMs ?? null,
        input.toolCall.success ? 1 : 0,
        safeJson(input.toolCall.metadata),
      );
    }

    if (
      input.sessionStatus === "completed" ||
      input.sessionStatus === "abandoned" ||
      input.eventType === "session_ended"
    ) {
      db.prepare(
        `
          UPDATE sessions
          SET
            status = ?,
            ended_at = COALESCE(ended_at, ?),
            updated_at = datetime('now')
          WHERE id = ?
        `,
      ).run(
        input.sessionStatus ?? "completed",
        timestamp,
        input.sessionId,
      );
    }
  });

  try {
    tx();
  } finally {
    db.close();
  }

  return { eventId };
}

export function inspectDatabase(explicitDataDir?: string): {
  dbPath: string;
  dataDir: string;
  sessions: number;
  events: number;
  toolCalls: number;
  capsules: number;
} {
  const dataDir = getDataDir(explicitDataDir);
  const dbPath = getDatabasePath(dataDir);
  const db = new Database(dbPath, { readonly: true });

  try {
    const sessions = db.prepare("SELECT COUNT(*) as value FROM sessions").get() as {
      value: number;
    };
    const events = db.prepare("SELECT COUNT(*) as value FROM events").get() as {
      value: number;
    };
    const toolCalls = db
      .prepare("SELECT COUNT(*) as value FROM tool_calls")
      .get() as {
      value: number;
    };
    const capsules = db.prepare("SELECT COUNT(*) as value FROM capsules").get() as {
      value: number;
    };

    return {
      dbPath,
      dataDir,
      sessions: sessions.value,
      events: events.value,
      toolCalls: toolCalls.value,
      capsules: capsules.value,
    };
  } finally {
    db.close();
  }
}
