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
npm run start -- configure summarizer --provider ollama --model llama3.1 --capture-prompts on
npm run start -- doctor
npm run start -- summarize --session latest
```

Or during development:

```bash
npm run dev -- doctor
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
- Prompt metadata by default (`promptLength` only).
- Optional full prompt capture when explicitly enabled.

### Verify capture

Run:

```bash
ctx-ledger doctor
```

The output shows local database status and current counts for sessions, events, and tool calls.

## Configure Summarizer

Configure once, then summarize sessions on demand.

### Ollama (local model)

```bash
ctx-ledger configure summarizer \
  --provider ollama \
  --model llama3.1 \
  --capture-prompts on
```

### OpenAI

```bash
ctx-ledger configure summarizer \
  --provider openai \
  --model gpt-4.1-mini \
  --capture-prompts on
```

Set API key via env var:

```bash
export OPENAI_API_KEY=...
```

Or pass it directly:

```bash
ctx-ledger configure summarizer --provider openai --model gpt-4.1-mini --api-key ...
```

### Anthropic

```bash
ctx-ledger configure summarizer \
  --provider anthropic \
  --model claude-3-7-sonnet-latest \
  --capture-prompts on
```

Set API key via env var:

```bash
export ANTHROPIC_API_KEY=...
```

### View config

```bash
ctx-ledger configure show
```

## Generate Summary

```bash
ctx-ledger summarize --session latest
```

`summarize` stores:

- Capsule summary (`capsules` table)
- Primary intent classification (`intent_labels`)
- Task/time breakdown estimates (`task_breakdowns`)
- Outcomes and extracted artifacts (files, commands, todo items, errors)

## End-to-End Capture Test (Real Claude Calls)

You can run a full e2e test that:

- Creates a temporary workspace
- Enables Claude hooks with project scope
- Sends real `claude -p` prompts
- Verifies those exact prompts were captured in ContextLedger SQLite events

Prerequisites:

- `claude` CLI installed and authenticated (`claude auth status`)

Run:

```bash
npm run test:e2e:claude-capture
```

Keep artifacts for inspection:

```bash
npm run test:e2e:claude-capture -- --keep-artifacts
```

## Commands

- `ctx-ledger enable claude` installs Claude hook wiring and enables background capture.
- `ctx-ledger configure summarizer` sets provider/model/API + prompt capture preferences.
- `ctx-ledger configure show` prints active config (API keys redacted).
- `ctx-ledger init` initializes local SQLite storage.
- `ctx-ledger doctor` validates setup and shows table counts.
- `ctx-ledger summarize` generates and stores a session capsule and work classification.
- `ctx-ledger capture|resume|stats` are scaffolded for upcoming implementation.

## Local data path

By default, ContextLedger stores data at:

`~/.context-ledger/context-ledger.db`

Use `--data-dir <path>` to override.
