# ContextLedger

Capture session context. Resume with intent.

ContextLedger is a local-first CLI for tracking AI-assisted work sessions and building reusable memory handoffs for future sessions.

## Stack

- TypeScript + Node.js
- Commander CLI
- SQLite (`better-sqlite3`)

## Quickstart

```bash
npm install
npm run build
npm run start -- enable claude
npm run start -- doctor
```

Or during development:

```bash
npm run dev -- init
```

## Enable Claude

Use one command to enable Claude Code capture:

```bash
ctx-ledger enable claude
```

You can also run through npm during local development:

```bash
npm run start -- enable claude
```

### Scope

- `ctx-ledger enable claude --scope user` writes to `~/.claude/settings.json` (default).
- `ctx-ledger enable claude --scope project` writes to `.claude/settings.local.json` in the current repository.

### How it works

- ContextLedger registers Claude command hooks for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, and `SessionEnd`.
- Hooks run asynchronously and call an internal ingestion command.
- Hook handlers are configured to avoid blocking or interrupting normal Claude sessions.

### What gets captured (v0)

- Session boundaries and timestamps.
- Event stream metadata.
- Tool usage metadata (tool name, success flag, timing when available).
- Prompt metadata only (length), not full prompt content.

### Verify capture

Run:

```bash
ctx-ledger doctor
```

The output shows local database status and current counts for sessions, events, and tool calls.

## Commands

- `ctx-ledger enable claude` installs Claude hook wiring and enables background capture.
- `ctx-ledger init` initializes local SQLite storage.
- `ctx-ledger doctor` validates setup and shows table counts.
- `ctx-ledger capture|summarize|resume|stats` are scaffolded for upcoming implementation.

## Local data path

By default, ContextLedger stores data at:

`~/.context-ledger/context-ledger.db`

Use `--data-dir <path>` to override.
