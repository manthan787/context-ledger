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
npm run start -- init
npm run start -- doctor
```

Or during development:

```bash
npm run dev -- init
```

## Commands (scaffold)

- `ctx-ledger init` initializes local SQLite storage.
- `ctx-ledger doctor` validates setup and shows table counts.
- `ctx-ledger capture|summarize|resume|stats` are scaffolded for upcoming implementation.

## Local data path

By default, ContextLedger stores data at:

`~/.context-ledger/context-ledger.db`

Use `--data-dir <path>` to override.
