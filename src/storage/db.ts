import Database from "better-sqlite3";
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
