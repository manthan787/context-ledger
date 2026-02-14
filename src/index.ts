#!/usr/bin/env node

import { Command } from "commander";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  getConfigPathForDisplay,
  loadAppConfig,
  saveAppConfig,
  type SummarizerProvider,
} from "./config";
import { enableClaude, ingestClaudeHookPayload } from "./integrations/claude";
import { generateSessionSummary } from "./summarization/summarizer";
import {
  DB_FILENAME,
  DEFAULT_DATA_DIR,
  getDatabasePath,
  getDataDir,
  initDatabase,
  inspectDatabase,
  loadSessionSummarySource,
  replaceIntentLabelsForSession,
  replaceTaskBreakdownForSession,
  saveSessionCapsule,
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

const configure = program
  .command("configure")
  .description("Configure summarizer and privacy settings");

configure
  .command("summarizer")
  .description("Set summarizer provider/model and optional API settings")
  .requiredOption(
    "--provider <provider>",
    "Provider (ollama|openai|anthropic)",
  )
  .requiredOption("--model <model>", "Model name")
  .option("--api-key <key>", "API key (optional, env vars preferred)")
  .option("--base-url <url>", "Provider base URL")
  .option("--capture-prompts <mode>", "Prompt capture mode: on|off")
  .option("--data-dir <path>", "Custom data directory")
  .action(
    (options: {
      provider: string;
      model: string;
      apiKey?: string;
      baseUrl?: string;
      capturePrompts?: string;
      dataDir?: string;
    }) => {
      const provider = options.provider.trim().toLowerCase();
      if (
        provider !== "ollama" &&
        provider !== "openai" &&
        provider !== "anthropic"
      ) {
        console.error(
          `Invalid provider: ${options.provider}. Allowed values: ollama, openai, anthropic`,
        );
        process.exitCode = 1;
        return;
      }

      const model = options.model.trim();
      if (model.length === 0) {
        console.error("Model is required.");
        process.exitCode = 1;
        return;
      }

      const normalizedProvider = provider as SummarizerProvider;

      initDatabase(options.dataDir);
      const existing = loadAppConfig(options.dataDir);
      const nextCapturePrompts =
        options.capturePrompts === undefined
          ? existing.privacy?.capturePrompts ?? false
          : options.capturePrompts.toLowerCase() === "on"
            ? true
            : options.capturePrompts.toLowerCase() === "off"
              ? false
              : null;

      if (nextCapturePrompts === null) {
        console.error(
          `Invalid capture mode: ${options.capturePrompts}. Allowed values: on, off`,
        );
        process.exitCode = 1;
        return;
      }

      const updatedConfig = {
        ...existing,
        summarizer: {
          provider: normalizedProvider,
          model,
          baseUrl: options.baseUrl ?? existing.summarizer?.baseUrl,
          apiKey: options.apiKey ?? existing.summarizer?.apiKey,
        },
        privacy: {
          ...existing.privacy,
          capturePrompts: nextCapturePrompts,
        },
      };

      const configPath = saveAppConfig(updatedConfig, options.dataDir);
      console.log("Summarizer configuration saved.");
      console.log(`Config file: ${configPath}`);
      console.log(`Provider: ${normalizedProvider}`);
      console.log(`Model: ${model}`);
      console.log(`Prompt capture: ${nextCapturePrompts ? "on" : "off"}`);
      if (options.apiKey) {
        console.log("API key: configured");
      } else if (updatedConfig.summarizer.apiKey) {
        console.log("API key: existing value retained");
      } else {
        console.log("API key: not stored (use environment variable or --api-key)");
      }
    },
  );

configure
  .command("show")
  .description("Show active ContextLedger config")
  .option("--data-dir <path>", "Custom data directory")
  .action((options: { dataDir?: string }) => {
    const config = loadAppConfig(options.dataDir);
    const redacted = {
      ...config,
      summarizer: config.summarizer
        ? {
            ...config.summarizer,
            apiKey: config.summarizer.apiKey ? "***redacted***" : undefined,
          }
        : undefined,
    };

    console.log(`Config path: ${getConfigPathForDisplay(options.dataDir)}`);
    console.log(JSON.stringify(redacted, null, 2));
  });

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
  .description("Generate and store a session capsule with intent/task breakdown")
  .option("--session <id>", "Session id or latest", "latest")
  .option("--data-dir <path>", "Custom data directory")
  .action(async (options: { session: string; dataDir?: string }) => {
    initDatabase(options.dataDir);
    const appConfig = loadAppConfig(options.dataDir);
    const summarizer = appConfig.summarizer;

    if (!summarizer) {
      console.error("Summarizer is not configured.");
      console.error(
        "Run: ctx-ledger configure summarizer --provider ollama --model llama3.1 --capture-prompts on",
      );
      process.exitCode = 1;
      return;
    }

    const source = loadSessionSummarySource(options.session, options.dataDir);
    if (!source) {
      console.error(`No session found for: ${options.session}`);
      process.exitCode = 1;
      return;
    }

    const promptCount = source.events.filter(
      (event) => typeof event.payload?.prompt === "string",
    ).length;
    if (promptCount === 0 && !(appConfig.privacy?.capturePrompts ?? false)) {
      console.log(
        "Prompt capture is currently off; summary quality may be limited to metadata and tools.",
      );
    }

    try {
      const summary = await generateSessionSummary(source, summarizer);

      saveSessionCapsule(
        {
          sessionId: source.session.id,
          summaryMarkdown: summary.summaryMarkdown,
          decisions: summary.keyOutcomes,
          todos: summary.todoItems,
          files: summary.filesTouched,
          commands: summary.commands,
          errors: summary.errors,
        },
        options.dataDir,
      );

      replaceIntentLabelsForSession(
        source.session.id,
        "summarizer",
        [
          {
            label: summary.primaryIntent,
            confidence: summary.intentConfidence,
            source: "summarizer",
            reason: {
              model: summarizer.model,
              provider: summarizer.provider,
            },
          },
        ],
        options.dataDir,
      );

      replaceTaskBreakdownForSession(
        source.session.id,
        "summarizer",
        summary.tasks.map((task) => ({
          taskLabel: task.name,
          durationMinutes: task.minutes,
          confidence: task.confidence,
          source: "summarizer",
        })),
        options.dataDir,
      );

      console.log("Session summary stored.");
      console.log(`Session: ${source.session.id}`);
      console.log(`Primary intent: ${summary.primaryIntent}`);
      console.log(`Task buckets: ${summary.tasks.length}`);
      console.log(`Capsule outcomes: ${summary.keyOutcomes.length}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to summarize session: ${message}`);
      process.exitCode = 1;
    }
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
