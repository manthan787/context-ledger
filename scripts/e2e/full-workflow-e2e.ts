import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import Database from "better-sqlite3";

interface CliArgs {
  keepArtifacts: boolean;
  workspaceDir?: string;
  dataDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { keepArtifacts: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep-artifacts") {
      args.keepArtifacts = true;
      continue;
    }
    if (arg === "--workspace-dir") {
      args.workspaceDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--data-dir") {
      args.dataDir = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return args;
}

function run(
  cmd: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    allowFailure?: boolean;
  },
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(cmd, args, {
    cwd: options?.cwd,
    env: options?.env ?? process.env,
    input: options?.input,
    encoding: "utf8",
    stdio: "pipe",
  });

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const status = result.status ?? 1;

  if (status !== 0 && !options?.allowFailure) {
    throw new Error(
      [
        `Command failed: ${cmd} ${args.join(" ")}`,
        `Exit code: ${status}`,
        stdout ? `stdout:\n${stdout}` : "",
        stderr ? `stderr:\n${stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return { stdout, stderr, status };
}

async function waitForCondition(
  check: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const intervalMs = options?.intervalMs ?? 300;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

async function waitForConditionAsync(
  check: () => Promise<boolean>,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const intervalMs = options?.intervalMs ?? 300;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  throw new Error("Timed out waiting for async condition.");
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function countCodexRequestEvents(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `
          SELECT COUNT(*) as value
          FROM events e
          INNER JOIN sessions s ON s.id = e.session_id
          WHERE e.event_type = 'request_sent'
            AND LOWER(s.agent) = 'codex'
        `,
      )
      .get() as { value: number };
    return row.value;
  } finally {
    db.close();
  }
}

function countToolCallsForSession(
  dbPath: string,
  sessionId: string,
  toolName: string,
): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `
          SELECT COUNT(*) as value
          FROM tool_calls
          WHERE session_id = ? AND tool_name = ?
        `,
      )
      .get(sessionId, toolName) as { value: number };
    return row.value;
  } finally {
    db.close();
  }
}

function cleanup(path: string | undefined): void {
  if (!path || !existsSync(path)) {
    return;
  }
  rmSync(path, { recursive: true, force: true });
}

async function findFreePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  if (!address || typeof address === "string") {
    probe.close();
    throw new Error("Failed to resolve free port.");
  }
  const port = address.port;
  probe.close();
  return port;
}

async function startMockOpenAIServer(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((req, res) => {
    if (req.url === "/chat/completions" && req.method === "POST") {
      const response = {
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "Worked on fixing CI and reducing flaky test noise.",
                keyOutcomes: ["Root cause identified", "Patch drafted"],
                filesTouched: ["src/api/client.ts", "src/tests/client.test.ts"],
                commands: ["npm run test", "git diff"],
                errors: ["Flaky timeout in integration test"],
                todoItems: ["Verify in CI after merge"],
                primaryIntent: "coding",
                intentConfidence: 0.89,
                tasks: [
                  { name: "debugging", minutes: 18, confidence: 0.9 },
                  { name: "implementation", minutes: 22, confidence: 0.86 },
                ],
              }),
            },
          },
        ],
      };
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response));
      return;
    }

    res.statusCode = 404;
    res.end("not found");
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock summarizer failed to bind.");
  }

  return {
    port: address.port,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = resolve(__dirname, "..", "..");
  const distCli = join(rootDir, "dist", "index.js");
  const workspaceDir =
    args.workspaceDir ?? mkdtempSync(join(tmpdir(), "context-ledger-full-e2e-ws-"));
  const dataDir =
    args.dataDir ?? mkdtempSync(join(tmpdir(), "context-ledger-full-e2e-data-"));
  const shouldCleanupWorkspace = !args.workspaceDir && !args.keepArtifacts;
  const shouldCleanupData = !args.dataDir && !args.keepArtifacts;

  const codexHistoryPath = join(workspaceDir, "codex-history.jsonl");
  const codexSessionsPath = join(workspaceDir, "codex-sessions");
  const geminiHistoryPath = join(workspaceDir, "gemini-history.jsonl");
  const codexProjectPath = join(workspaceDir, "apps", "checkout");
  const codexProjectPathLatest = join(workspaceDir, "apps", "checkout-v2");
  const geminiProjectPath = join(workspaceDir, "analytics");
  const codexRolloutSessionRaw = "019c470b-3e61-7bd0-892d-b3fa345edb18";
  const codexRolloutSessionId = `codex-${codexRolloutSessionRaw}`;
  const codexRolloutFile = join(
    codexSessionsPath,
    "2026",
    "02",
    "14",
    `rollout-2026-02-14T09-00-00-${codexRolloutSessionRaw}.jsonl`,
  );
  const dbPath = join(dataDir, "context-ledger.db");
  let mockServer: { port: number; close: () => Promise<void> } | null = null;
  let dashboardChild: ReturnType<typeof spawn> | null = null;

  try {
    run("npm", ["run", "build"], { cwd: rootDir });

    mkdirSync(dirname(codexRolloutFile), { recursive: true });
    writeFileSync(
      codexRolloutFile,
      [
        JSON.stringify({
          timestamp: "2026-02-14T09:00:00.000Z",
          type: "session_meta",
          payload: {
            id: codexRolloutSessionRaw,
            timestamp: "2026-02-14T09:00:00.000Z",
            cwd: codexProjectPath,
            model_provider: "openai",
            originator: "Codex Desktop",
            source: "vscode",
            cli_version: "0.100.0-alpha.10",
            git: {
              branch: "main",
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-14T09:00:05.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Deploy checkout service using token sk-THIS_SHOULD_HIDE",
            images: [],
            local_images: [],
            text_elements: [],
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-14T09:00:07.000Z",
          type: "response_item",
          payload: {
            type: "function_call",
            name: "exec_command",
            call_id: "call-codex-e2e-1",
            arguments: JSON.stringify({ cmd: "npm run deploy" }),
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-14T09:00:08.000Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-codex-e2e-1",
            output:
              "Chunk ID: codex-e2e\\nProcess exited with code 0\\nOutput:\\ndeploy ok\\n",
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-14T09:00:09.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "codex-turn-1",
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-14T09:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Investigate alerts with email ops@example.com",
            images: [],
            local_images: [],
            text_elements: [],
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-14T09:01:12.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "codex-turn-2",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    writeFileSync(
      geminiHistoryPath,
      [
        JSON.stringify({
          conversation_id: "gemini-c1",
          timestamp: 1771000600,
          prompt: "Write SQL for user growth trends",
          cwd: geminiProjectPath,
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    run(
      "node",
      [
        distCli,
        "configure",
        "privacy",
        "--capture-prompts",
        "on",
        "--redact-secrets",
        "on",
        "--redact-emails",
        "on",
        "--data-dir",
        dataDir,
      ],
      { cwd: rootDir },
    );

    run(
      "node",
      [
        distCli,
        "enable",
        "codex",
        "--history-path",
        codexHistoryPath,
        "--sessions-path",
        codexSessionsPath,
        "--data-dir",
        dataDir,
      ],
      { cwd: rootDir },
    );

    run(
      "node",
      [
        distCli,
        "enable",
        "gemini",
        "--history-path",
        geminiHistoryPath,
        "--data-dir",
        dataDir,
      ],
      { cwd: rootDir },
    );

    const initialCodexCount = countCodexRequestEvents(dbPath);
    assert(initialCodexCount === 2, "Initial codex sync should ingest two request events.");
    assert(
      countToolCallsForSession(dbPath, codexRolloutSessionId, "exec_command") >= 1,
      "Codex rollout sync should ingest tool calls from response_item function call events.",
    );

    const codexTurnContext = JSON.stringify({
      timestamp: "2026-02-14T09:09:59.000Z",
      type: "turn_context",
      payload: {
        turn_id: "codex-turn-3",
        cwd: codexProjectPathLatest,
      },
    });
    const partialCodexEntry = JSON.stringify({
      timestamp: "2026-02-14T09:10:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Partial codex entry should be ingested only after line completion",
        images: [],
        local_images: [],
        text_elements: [],
      },
    });
    const codexTaskComplete = JSON.stringify({
      timestamp: "2026-02-14T09:10:10.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "codex-turn-3",
      },
    });
    const splitIndex = Math.floor(partialCodexEntry.length / 2);
    writeFileSync(codexRolloutFile, `${codexTurnContext}\n`, {
      encoding: "utf8",
      flag: "a",
    });
    writeFileSync(codexRolloutFile, partialCodexEntry.slice(0, splitIndex), {
      encoding: "utf8",
      flag: "a",
    });
    run(
      "node",
      [distCli, "sync", "codex", "--data-dir", dataDir],
      { cwd: rootDir },
    );

    const codexAfterPartial = countCodexRequestEvents(dbPath);
    assert(
      codexAfterPartial === initialCodexCount,
      "Incomplete JSONL line should not advance codex cursor or be ingested.",
    );

    writeFileSync(
      codexRolloutFile,
      `${partialCodexEntry.slice(splitIndex)}\n${codexTaskComplete}\n`,
      {
        encoding: "utf8",
        flag: "a",
      },
    );
    run(
      "node",
      [distCli, "sync", "codex", "--data-dir", dataDir],
      { cwd: rootDir },
    );

    const codexAfterComplete = countCodexRequestEvents(dbPath);
    assert(
      codexAfterComplete === initialCodexCount + 1,
      "Completed Codex rollout line should be ingested exactly once.",
    );

    writeFileSync(codexHistoryPath, `${JSON.stringify({
      session_id: "codex-history-fallback",
      ts: 1771001200,
      text: "Fallback history line should not be ingested when rollout files exist",
      cwd: codexProjectPathLatest,
    })}\n`, {
      encoding: "utf8",
      flag: "a",
    });
    run(
      "node",
      [distCli, "sync", "codex", "--data-dir", dataDir],
      { cwd: rootDir },
    );
    assert(
      countCodexRequestEvents(dbPath) === codexAfterComplete,
      "Codex rollout mode should prefer sessions logs and avoid duplicate history ingestion.",
    );

    const claudeSessionId = "claude-e2e-session";
    run(
      "node",
      [
        distCli,
        "internal-hook-ingest",
        "--agent",
        "claude",
        "--data-dir",
        dataDir,
      ],
      {
        cwd: rootDir,
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: claudeSessionId,
          cwd: workspaceDir,
        }),
      },
    );

    run(
      "node",
      [
        distCli,
        "internal-hook-ingest",
        "--agent",
        "claude",
        "--data-dir",
        dataDir,
      ],
      {
        cwd: rootDir,
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: claudeSessionId,
          cwd: workspaceDir,
          prompt:
            "Fix failing CI and rotate key sk-ANOTHER_SECRET and notify admin@example.com",
        }),
      },
    );
    run(
      "node",
      [
        distCli,
        "internal-hook-ingest",
        "--agent",
        "claude",
        "--data-dir",
        dataDir,
      ],
      {
        cwd: rootDir,
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: claudeSessionId,
          cwd: workspaceDir,
          tool_name: "Read",
        }),
      },
    );
    run(
      "node",
      [
        distCli,
        "internal-hook-ingest",
        "--agent",
        "claude",
        "--data-dir",
        dataDir,
      ],
      {
        cwd: rootDir,
        input: JSON.stringify({
          hook_event_name: "PostToolUse",
          session_id: claudeSessionId,
          cwd: workspaceDir,
          tool_name: "Read",
        }),
      },
    );
    assert(
      countToolCallsForSession(dbPath, claudeSessionId, "Read") === 1,
      "Claude PreToolUse/PostToolUse pair should produce one tool call record.",
    );

    const claudeDesignSessionId = "claude-design-e2e-session";
    run(
      "node",
      [
        distCli,
        "internal-hook-ingest",
        "--agent",
        "claude",
        "--data-dir",
        dataDir,
      ],
      {
        cwd: rootDir,
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: claudeDesignSessionId,
          cwd: workspaceDir,
        }),
      },
    );
    run(
      "node",
      [
        distCli,
        "internal-hook-ingest",
        "--agent",
        "claude",
        "--data-dir",
        dataDir,
      ],
      {
        cwd: rootDir,
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: claudeDesignSessionId,
          cwd: workspaceDir,
          prompt:
            "Redesign the frontend dashboard UI. Improve layout, typography, color palette, spacing, and component styling with Tailwind.",
        }),
      },
    );

    const claudeResearchSessionId = "claude-research-e2e-session";
    run(
      "node",
      [
        distCli,
        "internal-hook-ingest",
        "--agent",
        "claude",
        "--data-dir",
        dataDir,
      ],
      {
        cwd: rootDir,
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: claudeResearchSessionId,
          cwd: workspaceDir,
        }),
      },
    );
    run(
      "node",
      [
        distCli,
        "internal-hook-ingest",
        "--agent",
        "claude",
        "--data-dir",
        dataDir,
      ],
      {
        cwd: rootDir,
        input: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: claudeResearchSessionId,
          cwd: workspaceDir,
          prompt:
            "What is the difference between Kafka and RabbitMQ, and when should I use each in production?",
        }),
      },
    );

    mockServer = await startMockOpenAIServer();
    run(
      "node",
      [
        distCli,
        "configure",
        "summarizer",
        "--provider",
        "openai",
        "--model",
        "gpt-test",
        "--base-url",
        `http://127.0.0.1:${mockServer.port}`,
        "--api-key",
        "dummy",
        "--capture-prompts",
        "on",
        "--data-dir",
        dataDir,
      ],
      { cwd: rootDir },
    );

    run(
      "node",
      [
        distCli,
        "internal-hook-ingest",
        "--agent",
        "claude",
        "--data-dir",
        dataDir,
      ],
      {
        cwd: rootDir,
        input: JSON.stringify({
          hook_event_name: "Stop",
          session_id: claudeDesignSessionId,
          cwd: workspaceDir,
        }),
      },
    );

    await waitForCondition(() => {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare(
            `
              SELECT label
              FROM intent_labels
              WHERE session_id = ?
              ORDER BY datetime(created_at) DESC
              LIMIT 1
            `,
          )
          .get(claudeDesignSessionId) as { label: string } | undefined;
        return row?.label === "coding/frontend/design";
      } finally {
        db.close();
      }
    });

    run(
      "node",
      [
        distCli,
        "internal-hook-ingest",
        "--agent",
        "claude",
        "--data-dir",
        dataDir,
      ],
      {
        cwd: rootDir,
        input: JSON.stringify({
          hook_event_name: "Stop",
          session_id: claudeResearchSessionId,
          cwd: workspaceDir,
        }),
      },
    );

    await waitForCondition(() => {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare(
            `
              SELECT label
              FROM intent_labels
              WHERE session_id = ?
              ORDER BY datetime(created_at) DESC
              LIMIT 1
            `,
          )
          .get(claudeResearchSessionId) as { label: string } | undefined;
        return row?.label === "research/tech-qna";
      } finally {
        db.close();
      }
    });

    run(
      "node",
      [
        distCli,
        "internal-hook-ingest",
        "--agent",
        "claude",
        "--data-dir",
        dataDir,
      ],
      {
        cwd: rootDir,
        input: JSON.stringify({
          hook_event_name: "Stop",
          session_id: claudeSessionId,
          cwd: workspaceDir,
        }),
      },
    );

    await waitForCondition(() => {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare(
            "SELECT COUNT(*) as value FROM intent_labels WHERE session_id = ? AND source = ?",
          )
          .get(claudeSessionId, "auto_claude_turn_stop") as { value: number };
        return row.value >= 1;
      } finally {
        db.close();
      }
    });

    run(
      "node",
      [
        distCli,
        "internal-hook-ingest",
        "--agent",
        "claude",
        "--data-dir",
        dataDir,
      ],
      {
        cwd: rootDir,
        input: JSON.stringify({
          hook_event_name: "SessionEnd",
          session_id: claudeSessionId,
          cwd: workspaceDir,
        }),
      },
    );

    await waitForCondition(() => {
      const db = new Database(dbPath, { readonly: true });
      try {
        const count = (
          db.prepare("SELECT COUNT(*) as value FROM capsules").get() as { value: number }
        ).value;
        return count >= 1;
      } finally {
        db.close();
      }
    });

    const statsRun = run(
      "node",
      [distCli, "stats", "--range", "all", "--format", "json", "--data-dir", dataDir],
      { cwd: rootDir },
    );
    const stats = JSON.parse(statsRun.stdout) as {
      summary: {
        sessions: number;
        totalMinutes: number;
        planningMinutes: number;
        executionMinutes: number;
      };
      byIntent: Array<{ label: string }>;
      byTool: Array<{ toolName: string }>;
      byAgent: Array<{ agentKey: string }>;
      byPhase: Array<{ phase: string }>;
      byProject: Array<{ projectPath: string }>;
    };
    assert(stats.summary.sessions >= 3, "Expected at least 3 sessions in stats.");
    assert(
      stats.summary.planningMinutes >= 0 && stats.summary.executionMinutes >= 0,
      "Expected planning/execution summary fields in stats output.",
    );
    assert(
      Math.abs(
        stats.summary.totalMinutes -
          (stats.summary.planningMinutes + stats.summary.executionMinutes),
      ) <= 0.05,
      "Expected planning + execution minutes to match total minutes.",
    );
    assert(
      stats.byPhase.some((row) => row.phase === "planning") &&
        stats.byPhase.some((row) => row.phase === "execution"),
      "Expected both planning and execution buckets.",
    );
    assert(
      stats.byProject.some((row) => row.projectPath === workspaceDir),
      "Expected Claude session project path in project breakdown.",
    );
    assert(
      stats.byProject.some((row) => row.projectPath === codexProjectPathLatest),
      "Expected latest codex project path in project breakdown.",
    );
    assert(
      stats.byIntent.some((row) => row.label === "coding"),
      "Expected coding intent in stats output.",
    );
    assert(
      stats.byIntent.some((row) => row.label === "coding/frontend/design"),
      "Expected frontend design intent in stats output.",
    );
    assert(
      stats.byIntent.some((row) => row.label === "research/tech-qna"),
      "Expected research tech Q&A intent in stats output.",
    );

    const statsCodexRun = run(
      "node",
      [
        distCli,
        "stats",
        "--range",
        "all",
        "--group-by",
        "agent",
        "--agent",
        "codex",
        "--format",
        "json",
        "--data-dir",
        dataDir,
      ],
      { cwd: rootDir },
    );
    const statsCodex = JSON.parse(statsCodexRun.stdout) as {
      summary: { sessions: number };
      byAgent: Array<{ agentKey: string }>;
      byProject: Array<{ projectPath: string }>;
    };
    assert(statsCodex.summary.sessions >= 1, "Expected codex-filtered stats to include sessions.");
    assert(
      statsCodex.byAgent.every((row) => row.agentKey === "codex"),
      "Agent-filtered stats should only include codex rows.",
    );
    assert(
      statsCodex.byProject.some((row) => row.projectPath === codexProjectPathLatest),
      "Agent-filtered stats should include codex working directory.",
    );

    const resumeRun = run(
      "node",
      [distCli, "resume", "--from", "latest", "--format", "json", "--data-dir", dataDir],
      { cwd: rootDir },
    );
    const resume = JSON.parse(resumeRun.stdout) as {
      id: string;
      title: string;
      estimatedTokens: number;
      markdown: string;
    };
    assert(typeof resume.id === "string", "Resume output should include pack id.");
    assert(
      resume.markdown.includes("Session"),
      "Resume markdown should include session context.",
    );

    const handoffRun = run(
      "node",
      [
        distCli,
        "handoff",
        "--agent",
        "codex",
        "--from",
        "latest",
        "--no-launch",
        "--format",
        "json",
        "--data-dir",
        dataDir,
      ],
      { cwd: rootDir },
    );
    const handoff = JSON.parse(handoffRun.stdout) as {
      resumePackId: string;
      agent: string;
      prompt: string;
    };
    assert(handoff.agent === "codex", "Handoff output should include target agent.");
    assert(
      handoff.prompt.includes("Validate current repository state before making edits."),
      "Handoff prompt should include verify-first instruction.",
    );
    assert(
      handoff.prompt.includes("## Prior Session Context"),
      "Handoff prompt should embed resume context section.",
    );

    const db = new Database(dbPath, { readonly: true });
    try {
      const payloadRows = db
        .prepare("SELECT payload_json as payloadJson FROM events WHERE event_type = 'request_sent'")
        .all() as Array<{ payloadJson: string | null }>;
      const payloadText = payloadRows
        .map((row) => row.payloadJson ?? "")
        .join("\n");
      assert(
        !payloadText.includes("sk-THIS_SHOULD_HIDE") &&
          !payloadText.includes("sk-ANOTHER_SECRET"),
        "Secret tokens should be redacted from stored payloads.",
      );
      assert(
        !payloadText.includes("ops@example.com") &&
          !payloadText.includes("admin@example.com"),
        "Emails should be redacted from stored payloads.",
      );

      const capsuleCount = (
        db.prepare("SELECT COUNT(*) as value FROM capsules").get() as { value: number }
      ).value;
      const resumeCount = (
        db.prepare("SELECT COUNT(*) as value FROM resume_packs").get() as { value: number }
      ).value;
      assert(capsuleCount >= 1, "Expected at least one stored capsule.");
      assert(resumeCount >= 2, "Expected resume + handoff to store resume packs.");
    } finally {
      db.close();
    }

    const dashboardPort = await findFreePort();
    dashboardChild = spawn(
      "node",
      [distCli, "dashboard", "--port", String(dashboardPort), "--data-dir", dataDir],
      {
        cwd: rootDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      },
    );

    await new Promise<void>((resolveReady, rejectReady) => {
      let buffer = "";
      const timeout = setTimeout(() => {
        rejectReady(new Error("Dashboard did not start in time."));
      }, 20_000);

      dashboardChild!.stdout?.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        if (buffer.includes("dashboard running")) {
          clearTimeout(timeout);
          resolveReady();
        }
      });
      dashboardChild!.stderr?.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
      });
      dashboardChild!.on("exit", (code) => {
        clearTimeout(timeout);
        rejectReady(new Error(`Dashboard exited early with code ${code ?? -1}`));
      });
    });

    const dashboardHtmlRes = await fetch(`http://127.0.0.1:${dashboardPort}/`);
    assert(dashboardHtmlRes.ok, "Dashboard HTML endpoint should return 200.");
    const dashboardHtml = await dashboardHtmlRes.text();
    assert(
      !dashboardHtml.includes('<option value="gemini">gemini</option>'),
      "Dashboard agent selector should hide Gemini while unsupported.",
    );

    const statsRes = await fetch(
      `http://127.0.0.1:${dashboardPort}/api/stats?range=all`,
    );
    assert(statsRes.ok, "Dashboard stats endpoint should return 200.");
    const apiStats = (await statsRes.json()) as { summary?: { sessions?: number } };
    assert(
      (apiStats.summary?.sessions ?? 0) >= 3,
      "Dashboard stats endpoint should include session data.",
    );

    const filteredStatsRes = await fetch(
      `http://127.0.0.1:${dashboardPort}/api/stats?range=all&agent=codex`,
    );
    assert(filteredStatsRes.ok, "Dashboard filtered stats endpoint should return 200.");
    const filteredApiStats = (await filteredStatsRes.json()) as {
      summary?: { sessions?: number };
      byAgent?: Array<{ agentKey?: string }>;
      byProject?: Array<{ projectPath?: string }>;
    };
    assert(
      (filteredApiStats.summary?.sessions ?? 0) >= 1,
      "Dashboard filtered stats should include codex sessions.",
    );
    assert(
      (filteredApiStats.byAgent ?? []).every((row) => row.agentKey === "codex"),
      "Dashboard filtered stats should only include codex agent rows.",
    );
    assert(
      (filteredApiStats.byProject ?? []).some(
        (row) => row.projectPath === codexProjectPathLatest,
      ),
      "Dashboard filtered stats should include codex project rows.",
    );

    const codexLiveSessionRaw = "019c470b-d362-7f73-afcf-94441832c002";
    const codexLiveRolloutFile = join(
      codexSessionsPath,
      "2026",
      "02",
      "15",
      `rollout-2026-02-15T04-00-00-${codexLiveSessionRaw}.jsonl`,
    );
    mkdirSync(dirname(codexLiveRolloutFile), { recursive: true });
    writeFileSync(
      codexLiveRolloutFile,
      [
        JSON.stringify({
          timestamp: "2026-02-15T04:00:00.000Z",
          type: "session_meta",
          payload: {
            id: codexLiveSessionRaw,
            cwd: codexProjectPathLatest,
            model_provider: "openai",
            source: "vscode",
            originator: "Codex Desktop",
            git: {
              branch: "main",
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-15T04:00:03.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Write SQL query for user growth trend by week",
            images: [],
            local_images: [],
            text_elements: [],
          },
        }),
        JSON.stringify({
          timestamp: "2026-02-15T04:00:12.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            turn_id: "codex-live-turn-1",
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await waitForConditionAsync(async () => {
      const response = await fetch(
        `http://127.0.0.1:${dashboardPort}/api/stats?range=all&agent=codex`,
      );
      if (!response.ok) {
        return false;
      }
      const payload = (await response.json()) as { summary?: { sessions?: number } };
      return (payload.summary?.sessions ?? 0) >= 2;
    }, { timeoutMs: 30_000, intervalMs: 500 });

    console.log("E2E success: full workflow validated.");
    console.log(`Workspace: ${workspaceDir}`);
    console.log(`Data dir: ${dataDir}`);
    console.log(`Database: ${dbPath}`);
  } finally {
    if (dashboardChild) {
      dashboardChild.kill("SIGINT");
    }
    if (mockServer) {
      await mockServer.close();
    }
    if (shouldCleanupWorkspace) {
      cleanup(workspaceDir);
    }
    if (shouldCleanupData) {
      cleanup(dataDir);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`E2E failed: ${message}`);
  process.exit(1);
});
