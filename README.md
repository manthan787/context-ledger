# ContextLedger

Capture session context. Resume with intent.

ContextLedger is a local-first CLI for tracking AI-assisted work across coding agents and carrying useful context into the next session.
<img width="2813" height="2145" alt="pretty_snap_2026_1_14_20_48" src="https://github.com/user-attachments/assets/92fc1a3c-5942-4aa3-9dd3-624eb634ec7e" />

## Stack

- TypeScript + Node.js
- SQLite (`better-sqlite3`)
- Commander CLI

## Quickstart

```bash
npm install
npm run build

# Enable agent capture
ctx-ledger enable claude
ctx-ledger enable codex
# Optional if you use Gemini CLI/history:
ctx-ledger enable gemini

# Configure privacy/summarizer
ctx-ledger configure privacy --capture-prompts on --redact-secrets on --redact-emails on
ctx-ledger configure summarizer --provider ollama --model llama3.1

# Analyze and generate memory handoff
# (summaries/intents are auto-generated after session updates once summarizer is configured)
ctx-ledger stats --range 7d
ctx-ledger resume --from latest --budget 2000
ctx-ledger handoff --agent claude --from latest --no-launch --out ./handoff.md
```

## Integrations

### Claude

`ctx-ledger enable claude` installs async command hooks into Claude settings.

- User scope (default): `~/.claude/settings.json`
- Project scope: `.claude/settings.local.json`

Captured events:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `Stop`
- `SessionEnd`

### Codex

`ctx-ledger enable codex` enables incremental ingestion from Codex history JSONL.

- Default source: `~/.codex/history.jsonl`
- Custom source: `ctx-ledger enable codex --history-path /path/to/history.jsonl`

### Gemini

`ctx-ledger enable gemini` enables incremental ingestion from Gemini history JSONL.

- Default source: `~/.gemini/history.jsonl`
- Custom source: `ctx-ledger enable gemini --history-path /path/to/history.jsonl`

### Sync

```bash
ctx-ledger sync all
ctx-ledger sync codex
ctx-ledger sync gemini
```

`stats`, `summarize`, `resume`, `handoff`, and `dashboard` automatically run sync for enabled Codex/Gemini integrations.

## Privacy & Redaction

Configure privacy settings:

```bash
ctx-ledger configure privacy \
  --capture-prompts on \
  --redact-secrets on \
  --redact-emails on \
  --allow-remote-prompt-transfer off
```

Defaults:

- `capturePrompts`: `off`
- `redactSecrets`: `on`
- `redactEmails`: `off`
- `allowRemotePromptTransfer`: `off`

Custom regex redaction patterns:

```bash
ctx-ledger configure privacy --add-redaction-pattern "my-secret-pattern"
```

## Summarizer Configuration

### Ollama (local)

```bash
ctx-ledger configure summarizer --provider ollama --model llama3.1
```

### OpenAI

```bash
ctx-ledger configure summarizer --provider openai --model gpt-4.1-mini
export OPENAI_API_KEY=...
```

### Anthropic

```bash
ctx-ledger configure summarizer --provider anthropic --model claude-3-7-sonnet-latest
export ANTHROPIC_API_KEY=...
```

If remote prompt transfer is disabled, captured prompt samples are excluded from remote summarizer requests.

## Stats

```bash
ctx-ledger stats --range 7d
ctx-ledger stats --range 30d --group-by tool
ctx-ledger stats --range all --format json
ctx-ledger stats --range all --group-by agent --agent claude
ctx-ledger stats --range all --group-by phase
ctx-ledger stats --range all --group-by project
```

Supported groups:

- `intent`
- `tool`
- `agent`
- `day`
- `phase` (planning vs execution)
- `project` (working directory / repo path)
- `all`

`summary` now includes `planningMinutes` and `executionMinutes` alongside `totalMinutes`.

Agent filter values:

- `claude`
- `codex`
- `gemini`

## Summaries

```bash
ctx-ledger summarize --session latest
ctx-ledger summarize --pending --limit 20
```

This stores:

- `capsules` (session summary, outcomes, files/commands/errors/todos)
- `intent_labels` (primary intent + confidence)
- `task_breakdowns` (estimated time split)

Intent labels support granular paths. Examples:

- `coding`
- `coding/frontend`
- `coding/frontend/design`
- `research`
- `research/tech-qna`
- `sql`, `deploy`, `incident`, `docs`, `other`

Automatic behavior:

- Claude sessions auto-summarize on `Stop` (turn-level) and `SessionEnd` hook events.
- Codex/Gemini sessions auto-summarize after sync imports new events.
- `summarize` remains available as a manual/force command.

## Resume Packs

```bash
ctx-ledger resume --from latest --budget 2000
ctx-ledger resume --from session-a --from session-b --format json
ctx-ledger resume --from latest --out ./resume.md
```

`resume` builds a handoff document for your next session by combining saved capsule data (summary/outcomes/todos/files/commands/errors), task breakdowns, and captured prompt samples when available.

Stored in `resume_packs`.  
List saved packs:

```bash
ctx-ledger resume-packs
```

## Agent Handoff

Start a coding agent with verify-first context injected from stored session data:

```bash
ctx-ledger handoff --agent claude --from latest
ctx-ledger handoff --agent codex --from latest --from session-a
```

Generate only (without launching an agent):

```bash
ctx-ledger handoff --agent claude --from latest --no-launch --format markdown --out ./handoff.md
ctx-ledger handoff --agent codex --from latest --no-launch --format json
```

## Dashboard

```bash
ctx-ledger dashboard --port 4173
```

Open:

- `http://127.0.0.1:4173/`
- API: `/api/stats`, `/api/sessions`, `/api/resume-packs`, `/healthz`
- Optional API filter: `?agent=claude|codex|gemini` on `/api/stats` and `/api/sessions`
- UI includes planning vs execution and project-time breakdowns, plus project path in recent sessions

## End-to-End Tests

Real Claude capture test (requires authenticated Claude CLI):

```bash
npm run test:e2e:claude-capture
```

Full workflow test (stats + summarize + resume + dashboard + codex/gemini sync with fixtures):

```bash
npm run test:e2e:full
```

Keep temporary artifacts for inspection:

```bash
npm run test:e2e:full -- --keep-artifacts
```

## Commands

- `ctx-ledger enable <claude|codex|gemini>`
- `ctx-ledger sync <codex|gemini|all>`
- `ctx-ledger configure summarizer`
- `ctx-ledger configure privacy`
- `ctx-ledger configure show`
- `ctx-ledger summarize`
- `ctx-ledger resume`
- `ctx-ledger handoff`
- `ctx-ledger resume-packs`
- `ctx-ledger stats`
- `ctx-ledger dashboard`
- `ctx-ledger doctor`

## Data Path

Default data directory:

`~/.context-ledger`

Default database:

`~/.context-ledger/context-ledger.db`

Override with:

`--data-dir <path>`
