import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

interface CliArgs {
  keepArtifacts: boolean;
  workspaceDir?: string;
  dataDir?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    keepArtifacts: false,
  };

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
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp(): void {
  console.log("Usage: tsx scripts/e2e/claude-capture-e2e.ts [options]");
  console.log("");
  console.log("Options:");
  console.log("  --keep-artifacts        Keep temp workspace/data directories");
  console.log("  --workspace-dir <path>  Use an explicit workspace directory");
  console.log("  --data-dir <path>       Use an explicit ContextLedger data directory");
}

function run(
  cmd: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; allowFailure?: boolean },
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(cmd, args, {
    cwd: options?.cwd,
    env: options?.env ?? process.env,
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
        stdout.length > 0 ? `stdout:\n${stdout}` : "",
        stderr.length > 0 ? `stderr:\n${stderr}` : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    );
  }

  return { stdout, stderr, status };
}

function ensureCommandExists(command: string): void {
  const check = run("bash", ["-lc", `command -v ${command}`], {
    allowFailure: true,
  });
  if (check.status !== 0) {
    throw new Error(`Missing required command: ${command}`);
  }
}

function ensureClaudeAuth(): void {
  const auth = run("claude", ["auth", "status"], { allowFailure: true });
  if (auth.status !== 0) {
    throw new Error(
      "Claude authentication is not available. Run `claude auth login` first.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(auth.stdout);
  } catch {
    throw new Error("Unable to parse `claude auth status` output.");
  }

  const loggedIn =
    typeof parsed === "object" &&
    parsed !== null &&
    "loggedIn" in parsed &&
    (parsed as { loggedIn?: unknown }).loggedIn === true;

  if (!loggedIn) {
    throw new Error(
      "Claude is not logged in. Run `claude auth login` before this e2e test.",
    );
  }
}

function cleanupDir(path: string | undefined): void {
  if (!path) {
    return;
  }
  if (!existsSync(path)) {
    return;
  }
  rmSync(path, { recursive: true, force: true });
}

function assertCapturedPrompts(dbPath: string, prompts: string[]): {
  sessions: number;
  events: number;
  requestEvents: number;
} {
  const db = new Database(dbPath, { readonly: true });
  try {
    const totals = db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM sessions) as sessions,
            (SELECT COUNT(*) FROM events) as events,
            (SELECT COUNT(*) FROM events WHERE event_type = 'request_sent') as requestEvents
        `,
      )
      .get() as { sessions: number; events: number; requestEvents: number };

    if (totals.requestEvents < prompts.length) {
      throw new Error(
        `Expected at least ${prompts.length} request_sent events, found ${totals.requestEvents}.`,
      );
    }

    const rows = db
      .prepare(
        `
          SELECT payload_json as payloadJson
          FROM events
          WHERE event_type = 'request_sent'
          ORDER BY datetime(timestamp) DESC
        `,
      )
      .all() as Array<{ payloadJson: string | null }>;

    const capturedPrompts = new Set<string>();
    for (const row of rows) {
      if (!row.payloadJson) {
        continue;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(row.payloadJson);
      } catch {
        continue;
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        continue;
      }
      const prompt = (payload as { prompt?: unknown }).prompt;
      if (typeof prompt === "string" && prompt.length > 0) {
        capturedPrompts.add(prompt);
      }
    }

    for (const prompt of prompts) {
      if (!capturedPrompts.has(prompt)) {
        throw new Error(
          `Prompt was not captured in ContextLedger events: "${prompt}"`,
        );
      }
    }

    return totals;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const rootDir = resolve(__dirname, "..", "..");
  const distCliPath = join(rootDir, "dist", "index.js");
  const workspaceDir =
    args.workspaceDir ?? mkdtempSync(join(tmpdir(), "context-ledger-e2e-ws-"));
  const dataDir =
    args.dataDir ?? mkdtempSync(join(tmpdir(), "context-ledger-e2e-data-"));

  const shouldCleanupWorkspace = !args.workspaceDir && !args.keepArtifacts;
  const shouldCleanupData = !args.dataDir && !args.keepArtifacts;

  const prompts = [
    "Return exactly: CONTEXT_LEDGER_E2E_PROMPT_ONE",
    "Return exactly: CONTEXT_LEDGER_E2E_PROMPT_TWO",
  ];

  try {
    ensureCommandExists("claude");
    ensureClaudeAuth();

    run("npm", ["run", "build"], { cwd: rootDir });

    writeFileSync(
      join(workspaceDir, "README.md"),
      "# ContextLedger E2E Workspace\n",
      "utf8",
    );

    run(
      "node",
      [
        distCliPath,
        "configure",
        "summarizer",
        "--provider",
        "ollama",
        "--model",
        "llama3.1",
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
        distCliPath,
        "enable",
        "claude",
        "--scope",
        "project",
        "--data-dir",
        dataDir,
      ],
      { cwd: workspaceDir },
    );

    for (const prompt of prompts) {
      const response = run(
        "claude",
        [
          "-p",
          "--no-session-persistence",
          "--output-format",
          "text",
          prompt,
        ],
        { cwd: workspaceDir },
      );

      if (response.stdout.trim().length === 0) {
        throw new Error(`Claude returned an empty response for prompt: "${prompt}"`);
      }
    }

    const dbPath = join(dataDir, "context-ledger.db");
    const totals = assertCapturedPrompts(dbPath, prompts);

    console.log("E2E success: Claude prompts captured by ContextLedger.");
    console.log(`Workspace: ${workspaceDir}`);
    console.log(`Data dir: ${dataDir}`);
    console.log(`Database: ${dbPath}`);
    console.log(`Sessions: ${totals.sessions}`);
    console.log(`Events: ${totals.events}`);
    console.log(`Request events: ${totals.requestEvents}`);
    console.log(
      "Verified prompts:",
      prompts.map((prompt) => `"${prompt}"`).join(", "),
    );

    if (args.keepArtifacts) {
      console.log("Artifacts retained (--keep-artifacts enabled).");
    }
  } finally {
    if (shouldCleanupWorkspace) {
      cleanupDir(workspaceDir);
    }
    if (shouldCleanupData) {
      cleanupDir(dataDir);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`E2E failed: ${message}`);
  process.exit(1);
});
