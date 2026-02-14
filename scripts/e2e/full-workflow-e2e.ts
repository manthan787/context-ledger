import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

async function runAsync(
  cmd: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    allowFailure?: boolean;
  },
): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    if (options?.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      rejectRun(error);
    });
    child.on("close", (code) => {
      const status = code ?? 1;
      if (status !== 0 && !options?.allowFailure) {
        rejectRun(
          new Error(
            [
              `Command failed: ${cmd} ${args.join(" ")}`,
              `Exit code: ${status}`,
              stdout ? `stdout:\n${stdout}` : "",
              stderr ? `stderr:\n${stderr}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        );
        return;
      }
      resolveRun({ stdout, stderr, status });
    });
  });
}

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
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
  const geminiHistoryPath = join(workspaceDir, "gemini-history.jsonl");
  const dbPath = join(dataDir, "context-ledger.db");
  let mockServer: { port: number; close: () => Promise<void> } | null = null;
  let dashboardChild: ReturnType<typeof spawn> | null = null;

  try {
    run("npm", ["run", "build"], { cwd: rootDir });

    writeFileSync(
      codexHistoryPath,
      [
        JSON.stringify({
          session_id: "codex-s1",
          ts: 1771000000,
          text: "Deploy checkout service using token sk-THIS_SHOULD_HIDE",
        }),
        JSON.stringify({
          session_id: "codex-s1",
          ts: 1771000300,
          text: "Investigate alerts with email ops@example.com",
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

    await runAsync(
      "node",
      [distCli, "summarize", "--session", "latest", "--data-dir", dataDir],
      {
        cwd: rootDir,
      },
    );

    const statsRun = run(
      "node",
      [distCli, "stats", "--range", "all", "--format", "json", "--data-dir", dataDir],
      { cwd: rootDir },
    );
    const stats = JSON.parse(statsRun.stdout) as {
      summary: { sessions: number; totalMinutes: number };
      byIntent: Array<{ label: string }>;
      byTool: Array<{ toolName: string }>;
    };
    assert(stats.summary.sessions >= 3, "Expected at least 3 sessions in stats.");
    assert(
      stats.byIntent.some((row) => row.label === "coding"),
      "Expected coding intent in stats output.",
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
      assert(resumeCount >= 1, "Expected at least one stored resume pack.");
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

    const statsRes = await fetch(
      `http://127.0.0.1:${dashboardPort}/api/stats?range=all`,
    );
    assert(statsRes.ok, "Dashboard stats endpoint should return 200.");
    const apiStats = (await statsRes.json()) as { summary?: { sessions?: number } };
    assert(
      (apiStats.summary?.sessions ?? 0) >= 3,
      "Dashboard stats endpoint should include session data.",
    );

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
