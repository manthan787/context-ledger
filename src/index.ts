#!/usr/bin/env node

import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { enableClaude, ingestClaudeHookPayload } from "./integrations/claude";
import {
  DB_FILENAME,
  DEFAULT_DATA_DIR,
  getDatabasePath,
  getDataDir,
  initDatabase,
  inspectDatabase,
} from "./storage/db";

const program = new Command();

function resolveHookCliEntrypointPath(): string {
  const compiledEntrypoint = resolve(__dirname, "..", "dist", "index.js");
  if (existsSync(compiledEntrypoint)) {
    return compiledEntrypoint;
  }

  if (__filename.endsWith(".js")) {
    return resolve(__filename);
  }

  throw new Error(
    "Unable to resolve compiled CLI entrypoint. Run `npm run build` before `ctx-ledger enable claude`.",
  );
}

async function readStdin(): Promise<string> {
  return new Promise((resolveInput, rejectInput) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    process.stdin.on("end", () => {
      resolveInput(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", (error) => {
      rejectInput(error);
    });
  });
}

program
  .name("ctx-ledger")
  .description("ContextLedger CLI: local-first session analytics and memory handoff")
  .version("0.1.0");

program
  .command("enable")
  .description("Enable capture integration for a coding agent")
  .argument("<agent>", "Agent to enable (claude)")
  .option("--scope <scope>", "Integration scope (user|project)", "user")
  .option("--data-dir <path>", "Custom data directory")
  .action(
    (
      agent: string,
      options: {
        scope: string;
        dataDir?: string;
      },
    ) => {
      const normalizedAgent = agent.trim().toLowerCase();
      if (normalizedAgent !== "claude") {
        console.error(
          `Unsupported agent: ${agent}. Current supported value: claude`,
        );
        process.exitCode = 1;
        return;
      }

      if (options.scope !== "user" && options.scope !== "project") {
        console.error(
          `Invalid scope: ${options.scope}. Allowed values: user, project`,
        );
        process.exitCode = 1;
        return;
      }

      const scope = options.scope;
      const result = enableClaude({
        scope,
        cwd: process.cwd(),
        dataDir: options.dataDir,
        cliEntrypointPath: resolveHookCliEntrypointPath(),
        nodePath: process.execPath,
      });

      console.log("Claude integration enabled.");
      console.log(`Scope: ${scope}`);
      console.log(`Settings file: ${result.settingsPath}`);
      console.log(`Data directory: ${result.dataDir}`);
      console.log(`Database: ${result.dbPath}`);
      console.log(`Hook bindings added: ${result.addedHooks}`);
      if (result.addedHooks === 0) {
        console.log(
          "No new hook bindings were needed (existing ContextLedger hooks already present).",
        );
      }
    },
  );

program
  .command("init")
  .description("Initialize local ContextLedger data store")
  .option("--data-dir <path>", "Custom data directory")
  .action((options: { dataDir?: string }) => {
    const { dbPath, dataDir } = initDatabase(options.dataDir);
    console.log("ContextLedger initialized");
    console.log(`Data directory: ${dataDir}`);
    console.log(`Database: ${dbPath}`);
  });

program
  .command("doctor")
  .description("Show local installation and datastore status")
  .option("--data-dir <path>", "Custom data directory")
  .action((options: { dataDir?: string }) => {
    const dataDir = getDataDir(options.dataDir);
    const dbPath = getDatabasePath(dataDir);

    console.log(`Default data directory: ${DEFAULT_DATA_DIR}`);
    console.log(`Active data directory: ${dataDir}`);
    console.log(`Expected DB filename: ${DB_FILENAME}`);

    if (!existsSync(dbPath)) {
      console.log("");
      console.log("Database not initialized yet.");
      console.log("Run: ctx-ledger init");
      process.exit(0);
    }

    const stats = inspectDatabase(options.dataDir);
    console.log("");
    console.log("Database status:");
    console.log(`Path: ${stats.dbPath}`);
    console.log(`Sessions: ${stats.sessions}`);
    console.log(`Events: ${stats.events}`);
    console.log(`Tool Calls: ${stats.toolCalls}`);
    console.log(`Capsules: ${stats.capsules}`);
  });

const capture = program.command("capture").description("Capture session events (scaffold)");

capture
  .command("start")
  .description("Start a session capture (not implemented yet)")
  .option("--agent <name>", "Agent name (claude-code|codex|gemini-cli)")
  .option("--repo <path>", "Repository path")
  .action(() => {
    console.log("capture start is scaffolded but not implemented yet.");
    console.log("Next: wire provider adapters and event ingestion.");
  });

capture
  .command("stop")
  .description("Stop current session capture (not implemented yet)")
  .action(() => {
    console.log("capture stop is scaffolded but not implemented yet.");
  });

program
  .command("summarize")
  .description("Generate a session capsule (not implemented yet)")
  .action(() => {
    console.log("summarize is scaffolded but not implemented yet.");
  });

program
  .command("resume")
  .description("Build a resume pack (not implemented yet)")
  .action(() => {
    console.log("resume is scaffolded but not implemented yet.");
  });

program
  .command("stats")
  .description("Show usage analytics (not implemented yet)")
  .action(() => {
    console.log("stats is scaffolded but not implemented yet.");
  });

program
  .command("internal-hook-ingest", { hidden: true })
  .description("Internal hook ingestion command")
  .requiredOption("--agent <agent>", "Agent source for payload")
  .option("--data-dir <path>", "Custom data directory")
  .action(async (options: { agent: string; dataDir?: string }) => {
    if (options.agent !== "claude") {
      return;
    }

    try {
      const payload = await readStdin();
      ingestClaudeHookPayload(payload, options.dataDir);
    } catch {
      // Hook ingestion must never interrupt a coding session.
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error("Command failed:", error);
  process.exit(1);
});
