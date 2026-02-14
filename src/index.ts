#!/usr/bin/env node

import { Command } from "commander";
import { existsSync } from "node:fs";
import {
  DB_FILENAME,
  DEFAULT_DATA_DIR,
  getDatabasePath,
  getDataDir,
  initDatabase,
  inspectDatabase,
} from "./storage/db";

const program = new Command();

program
  .name("ctx-ledger")
  .description("ContextLedger CLI: local-first session analytics and memory handoff")
  .version("0.1.0");

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

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error("Command failed:", error);
  process.exit(1);
});
