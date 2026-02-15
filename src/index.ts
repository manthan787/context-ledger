#!/usr/bin/env node

import { Command } from "commander";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  getConfigPathForDisplay,
  loadAppConfig,
  saveAppConfig,
  type AppConfig,
  type SummarizerProvider,
} from "./config";
import { startDashboardServer } from "./dashboard/server";
import { enableClaude, ingestClaudeHookPayload } from "./integrations/claude";
import { enableCodex, syncCodexHistory } from "./integrations/codex";
import { enableGemini, syncGeminiHistory } from "./integrations/gemini";
import { buildResumePack } from "./resume/pack";
import {
  listResumePacks,
  getUsageStats,
  listSessions,
  loadResumeSessionContexts,
  saveResumePack,
} from "./storage/analytics";
import {
  DB_FILENAME,
  DEFAULT_DATA_DIR,
  getDatabasePath,
  getDataDir,
  initDatabase,
  inspectDatabase,
} from "./storage/db";
import { summarizeSessionByRef } from "./summarization/session-summary";

const program = new Command();

type BooleanMode = "on" | "off";

function parseBooleanMode(value: string | undefined): boolean | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "on") {
    return true;
  }
  if (normalized === "off") {
    return false;
  }
  return null;
}

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

function parseRange(range: string): { label: string; sinceIso: string | null } {
  const normalized = range.trim().toLowerCase();
  const now = Date.now();
  if (normalized === "24h") {
    return {
      label: "24h",
      sinceIso: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    };
  }
  if (normalized === "7d") {
    return {
      label: "7d",
      sinceIso: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }
  if (normalized === "30d") {
    return {
      label: "30d",
      sinceIso: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }
  return { label: "all", sinceIso: null };
}

function collectOption(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function formatCell(value: string, width: number): string {
  const text = value.length > width ? `${value.slice(0, width - 1)}…` : value;
  return text.padEnd(width, " ");
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, index) => {
    const rowWidth = Math.max(
      ...rows.map((row) => (row[index] ? row[index].length : 0)),
      0,
    );
    return Math.min(60, Math.max(header.length, rowWidth));
  });

  const headerLine = headers
    .map((header, index) => formatCell(header, widths[index]))
    .join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  console.log(headerLine);
  console.log(divider);
  for (const row of rows) {
    console.log(
      row.map((cell, index) => formatCell(cell, widths[index])).join("  "),
    );
  }
}

function formatNumber(value: number, fractionDigits = 1): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

type SyncOutcome = {
  provider: "codex" | "gemini";
  status: "ok" | "skipped";
  inserted: number;
  skipped: number;
  touchedSessionIds: string[];
  reason?: string;
};

const AUTO_SUMMARY_MAX_PER_SYNC = 4;
const STATS_RANGE_VALUES = new Set(["24h", "7d", "30d", "all"]);
const STATS_GROUP_VALUES = new Set(["intent", "tool", "agent", "day", "all"]);
type HandoffAgent = "claude" | "codex";

function enqueueAutoSummaries(
  sessionIds: string[],
  explicitDataDir: string | undefined,
  source: string,
): void {
  const config = loadAppConfig(explicitDataDir);
  if (!config.summarizer) {
    return;
  }

  const unique = [...new Set(sessionIds.filter((value) => value.trim().length > 0))];
  if (unique.length === 0) {
    return;
  }

  const selected = unique.slice(-AUTO_SUMMARY_MAX_PER_SYNC);
  const cliPath = resolveHookCliEntrypointPath();
  for (const sessionId of selected) {
    const args = [
      cliPath,
      "internal-auto-summarize",
      "--session",
      sessionId,
      "--source",
      source,
    ];
    if (explicitDataDir) {
      args.push("--data-dir", explicitDataDir);
    }

    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }
}

function syncEnabledIntegrations(explicitDataDir?: string): SyncOutcome[] {
  const config = loadAppConfig(explicitDataDir);
  const outcomes: SyncOutcome[] = [];

  if (config.integrations?.codex?.enabled) {
    const result = syncCodexHistory({
      dataDir: explicitDataDir,
      historyPath: config.integrations.codex.historyPath,
    });
    outcomes.push({
      provider: "codex",
      status: result.status,
      inserted: result.inserted,
      skipped: result.skipped,
      touchedSessionIds: result.touchedSessionIds,
      reason: result.reason,
    });
  }

  if (config.integrations?.gemini?.enabled) {
    const result = syncGeminiHistory({
      dataDir: explicitDataDir,
      historyPath: config.integrations.gemini.historyPath,
    });
    outcomes.push({
      provider: "gemini",
      status: result.status,
      inserted: result.inserted,
      skipped: result.skipped,
      touchedSessionIds: result.touchedSessionIds,
      reason: result.reason,
    });
  }

  return outcomes;
}

function printSyncOutcomes(outcomes: SyncOutcome[]): void {
  if (outcomes.length === 0) {
    return;
  }
  for (const outcome of outcomes) {
    if (outcome.status === "ok") {
      console.log(
        `Synced ${outcome.provider}: inserted ${outcome.inserted}, skipped ${outcome.skipped}`,
      );
    } else {
      console.log(
        `Skipped ${outcome.provider}: ${outcome.reason ?? "no update source"}`,
      );
    }
  }
}

function enqueueAutoSummariesFromSync(
  outcomes: SyncOutcome[],
  explicitDataDir: string | undefined,
  source: string,
): void {
  const touched = outcomes.flatMap((outcome) => outcome.touchedSessionIds);
  enqueueAutoSummaries(touched, explicitDataDir, source);
}

function ensureProvider(input: string): SummarizerProvider | null {
  const value = input.trim().toLowerCase();
  if (value === "ollama" || value === "openai" || value === "anthropic") {
    return value;
  }
  return null;
}

function ensureHandoffAgent(input: string): HandoffAgent | null {
  const value = input.trim().toLowerCase();
  if (value === "claude" || value === "codex") {
    return value;
  }
  return null;
}

function buildHandoffPrompt(input: {
  agent: HandoffAgent;
  resumePackId: string;
  resumeTitle: string;
  sourceSessionIds: string[];
  estimatedTokens: number;
  resumeMarkdown: string;
}): string {
  const agentLabel = input.agent === "claude" ? "Claude Code" : "Codex";

  return [
    `# ContextLedger Handoff for ${agentLabel}`,
    "",
    `Generated: ${new Date().toISOString()}`,
    `Resume Pack ID: ${input.resumePackId}`,
    `Resume Title: ${input.resumeTitle}`,
    `Source Sessions: ${input.sourceSessionIds.join(", ")}`,
    `Estimated Tokens: ${input.estimatedTokens}`,
    "",
    "You are continuing prior work. Follow this order strictly:",
    "1. Validate current repository state before making edits.",
    "2. Confirm branch, dirty files, and whether referenced files still exist.",
    "3. Summarize completed work versus open work from the context below.",
    "4. Propose the next highest-value step, then execute it.",
    "5. Call out context drift before applying potentially stale assumptions.",
    "",
    "Repository validation checklist:",
    "- Run `git status --short --branch` and report differences from the handoff context.",
    "- Verify main files and commands in the handoff are still relevant.",
    "- If context conflicts with current code, prefer current code and explain the delta.",
    "",
    "## Prior Session Context",
    "",
    input.resumeMarkdown.trim(),
  ].join("\n");
}

function formatLaunchCommand(command: string, args: string[]): string {
  const quoteArg = (arg: string): string => {
    if (/^[A-Za-z0-9_./:@=-]+$/.test(arg)) {
      return arg;
    }
    return JSON.stringify(arg);
  };
  return [command, ...args.map(quoteArg)].join(" ");
}

function launchAgentWithPrompt(
  agent: HandoffAgent,
  prompt: string,
  extraArgs: string[],
): { command: string; status: number; error?: string } {
  const command = agent;
  const args = [...extraArgs, prompt];
  const launched = spawnSync(command, args, {
    stdio: "inherit",
  });

  if (launched.error) {
    return {
      command: formatLaunchCommand(command, args),
      status: 1,
      error: launched.error.message,
    };
  }

  return {
    command: formatLaunchCommand(command, args),
    status: launched.status ?? 1,
  };
}

program
  .name("ctx-ledger")
  .description("ContextLedger CLI: local-first session analytics and memory handoff")
  .version("0.1.0");

const configure = program
  .command("configure")
  .description("Configure summarizer, privacy, and integration defaults");

configure
  .command("summarizer")
  .description("Set summarizer provider/model and optional API settings")
  .argument("[provider]", "Provider (ollama|openai|anthropic)")
  .argument("[model]", "Model name")
  .option(
    "--provider <provider>",
    "Provider (ollama|openai|anthropic)",
  )
  .option("--model <model>", "Model name")
  .option("--api-key <key>", "API key (optional, env vars preferred)")
  .option("--base-url <url>", "Provider base URL")
  .option("--capture-prompts <mode>", "Prompt capture mode: on|off")
  .option("--data-dir <path>", "Custom data directory")
  .action(
    (
      providerArg: string | undefined,
      modelArg: string | undefined,
      options: {
        provider?: string;
        model?: string;
        apiKey?: string;
        baseUrl?: string;
        capturePrompts?: BooleanMode;
        dataDir?: string;
      },
    ) => {
      const providerInput = options.provider ?? providerArg;
      const modelInput = options.model ?? modelArg;

      if (!providerInput || !modelInput) {
        console.error("Provider and model are required.");
        console.error(
          "Use either: ctx-ledger configure summarizer --provider ollama --model qwen3:4b",
        );
        console.error(
          "Or: ctx-ledger configure summarizer ollama qwen3:4b",
        );
        console.error(
          "If using npm scripts, pass args after -- (example: npm run dev -- configure summarizer --provider ollama --model qwen3:4b).",
        );
        process.exitCode = 1;
        return;
      }

      const provider = ensureProvider(providerInput);
      if (!provider) {
        console.error(
          `Invalid provider: ${providerInput}. Allowed values: ollama, openai, anthropic`,
        );
        process.exitCode = 1;
        return;
      }

      const model = modelInput.trim();
      if (model.length === 0) {
        console.error("Model is required.");
        process.exitCode = 1;
        return;
      }

      initDatabase(options.dataDir);
      const existing = loadAppConfig(options.dataDir);
      const capturePromptsInput = parseBooleanMode(options.capturePrompts);
      if (options.capturePrompts !== undefined && capturePromptsInput === null) {
        console.error(
          `Invalid capture mode: ${options.capturePrompts}. Allowed values: on, off`,
        );
        process.exitCode = 1;
        return;
      }

      const updatedConfig: AppConfig = {
        ...existing,
        summarizer: {
          provider,
          model,
          baseUrl: options.baseUrl ?? existing.summarizer?.baseUrl,
          apiKey: options.apiKey ?? existing.summarizer?.apiKey,
        },
        privacy: {
          ...existing.privacy,
          capturePrompts:
            capturePromptsInput === null
              ? existing.privacy.capturePrompts
              : capturePromptsInput,
        },
      };

      const configPath = saveAppConfig(updatedConfig, options.dataDir);
      console.log("Summarizer configuration saved.");
      console.log(`Config file: ${configPath}`);
      console.log(`Provider: ${provider}`);
      console.log(`Model: ${model}`);
      console.log(
        `Prompt capture: ${updatedConfig.privacy.capturePrompts ? "on" : "off"}`,
      );
      if (options.apiKey) {
        console.log("API key: configured");
      } else if (updatedConfig.summarizer?.apiKey) {
        console.log("API key: existing value retained");
      } else {
        console.log("API key: not stored (use environment variable or --api-key)");
      }
    },
  );

configure
  .command("privacy")
  .description("Configure privacy and redaction options")
  .option("--capture-prompts <mode>", "Prompt capture mode: on|off")
  .option("--redact-secrets <mode>", "Secret redaction mode: on|off")
  .option("--redact-emails <mode>", "Email redaction mode: on|off")
  .option(
    "--allow-remote-prompt-transfer <mode>",
    "Allow sending captured prompts to remote APIs (openai/anthropic): on|off",
  )
  .option(
    "--add-redaction-pattern <regex>",
    "Additional regex redaction pattern (repeatable)",
    collectOption,
    [],
  )
  .option("--clear-redaction-patterns", "Clear custom redaction patterns")
  .option("--data-dir <path>", "Custom data directory")
  .action(
    (options: {
      capturePrompts?: BooleanMode;
      redactSecrets?: BooleanMode;
      redactEmails?: BooleanMode;
      allowRemotePromptTransfer?: BooleanMode;
      addRedactionPattern: string[];
      clearRedactionPatterns?: boolean;
      dataDir?: string;
    }) => {
      const existing = loadAppConfig(options.dataDir);
      const parseOption = (value: BooleanMode | undefined, name: string): boolean | null => {
        const parsed = parseBooleanMode(value);
        if (value !== undefined && parsed === null) {
          console.error(`Invalid value for ${name}: ${value}. Allowed values: on, off`);
          process.exitCode = 1;
        }
        return parsed;
      };

      const capturePrompts = parseOption(options.capturePrompts, "capture-prompts");
      const redactSecrets = parseOption(options.redactSecrets, "redact-secrets");
      const redactEmails = parseOption(options.redactEmails, "redact-emails");
      const allowRemote = parseOption(
        options.allowRemotePromptTransfer,
        "allow-remote-prompt-transfer",
      );
      if (process.exitCode === 1) {
        return;
      }

      const mergedPatterns = options.clearRedactionPatterns
        ? []
        : [...existing.privacy.additionalRedactionPatterns];
      for (const pattern of options.addRedactionPattern) {
        if (pattern.trim().length > 0) {
          mergedPatterns.push(pattern.trim());
        }
      }

      const updated: AppConfig = {
        ...existing,
        privacy: {
          ...existing.privacy,
          capturePrompts:
            capturePrompts === null
              ? existing.privacy.capturePrompts
              : capturePrompts,
          redactSecrets:
            redactSecrets === null ? existing.privacy.redactSecrets : redactSecrets,
          redactEmails:
            redactEmails === null ? existing.privacy.redactEmails : redactEmails,
          allowRemotePromptTransfer:
            allowRemote === null
              ? existing.privacy.allowRemotePromptTransfer
              : allowRemote,
          additionalRedactionPatterns: [...new Set(mergedPatterns)],
        },
      };

      const path = saveAppConfig(updated, options.dataDir);
      console.log("Privacy settings saved.");
      console.log(`Config file: ${path}`);
      console.log(`Capture prompts: ${updated.privacy.capturePrompts ? "on" : "off"}`);
      console.log(`Redact secrets: ${updated.privacy.redactSecrets ? "on" : "off"}`);
      console.log(`Redact emails: ${updated.privacy.redactEmails ? "on" : "off"}`);
      console.log(
        `Allow remote prompt transfer: ${
          updated.privacy.allowRemotePromptTransfer ? "on" : "off"
        }`,
      );
      console.log(
        `Custom redaction patterns: ${updated.privacy.additionalRedactionPatterns.length}`,
      );
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
  .argument("<agent>", "Agent to enable (claude|codex|gemini)")
  .option("--scope <scope>", "Integration scope (user|project)", "user")
  .option("--history-path <path>", "Custom history path (codex/gemini)")
  .option("--data-dir <path>", "Custom data directory")
  .action(
    (
      agent: string,
      options: {
        scope: string;
        historyPath?: string;
        dataDir?: string;
      },
    ) => {
      const normalizedAgent = agent.trim().toLowerCase();

      if (normalizedAgent === "claude") {
        if (options.scope !== "user" && options.scope !== "project") {
          console.error(
            `Invalid scope: ${options.scope}. Allowed values: user, project`,
          );
          process.exitCode = 1;
          return;
        }

        const result = enableClaude({
          scope: options.scope,
          cwd: process.cwd(),
          dataDir: options.dataDir,
          cliEntrypointPath: resolveHookCliEntrypointPath(),
          nodePath: process.execPath,
        });

        console.log("Claude integration enabled.");
        console.log(`Scope: ${options.scope}`);
        console.log(`Settings file: ${result.settingsPath}`);
        console.log(`Data directory: ${result.dataDir}`);
        console.log(`Database: ${result.dbPath}`);
        console.log(`Hook bindings added: ${result.addedHooks}`);
        if (result.addedHooks === 0) {
          console.log(
            "No new hook bindings were needed (existing ContextLedger hooks already present).",
          );
        }
        return;
      }

      if (normalizedAgent === "codex") {
        const result = enableCodex({
          dataDir: options.dataDir,
          historyPath: options.historyPath,
        });
        console.log("Codex integration enabled.");
        console.log(`History path: ${result.historyPath}`);
        const sync = syncCodexHistory({
          dataDir: options.dataDir,
          historyPath: result.historyPath,
        });
        console.log(
          `Initial sync: ${sync.status} (inserted ${sync.inserted}, skipped ${sync.skipped})`,
        );
        if (sync.reason) {
          console.log(`Reason: ${sync.reason}`);
        }
        enqueueAutoSummaries(sync.touchedSessionIds, options.dataDir, "auto_codex_sync");
        return;
      }

      if (normalizedAgent === "gemini") {
        const result = enableGemini({
          dataDir: options.dataDir,
          historyPath: options.historyPath,
        });
        console.log("Gemini integration enabled.");
        console.log(`History path: ${result.historyPath}`);
        const sync = syncGeminiHistory({
          dataDir: options.dataDir,
          historyPath: result.historyPath,
        });
        console.log(
          `Initial sync: ${sync.status} (inserted ${sync.inserted}, skipped ${sync.skipped})`,
        );
        if (sync.reason) {
          console.log(`Reason: ${sync.reason}`);
        }
        enqueueAutoSummaries(sync.touchedSessionIds, options.dataDir, "auto_gemini_sync");
        return;
      }

      console.error(
        `Unsupported agent: ${agent}. Current supported values: claude, codex, gemini`,
      );
      process.exitCode = 1;
    },
  );

program
  .command("sync")
  .description("Sync enabled external history integrations")
  .argument("[agent]", "Specific integration to sync (codex|gemini|all)", "all")
  .option("--history-path <path>", "Override history path for the specific sync target")
  .option("--data-dir <path>", "Custom data directory")
  .action(
    (
      agent: string,
      options: {
        historyPath?: string;
        dataDir?: string;
      },
    ) => {
      const target = agent.trim().toLowerCase();
      const outcomes: SyncOutcome[] = [];

      if (target === "codex" || target === "all") {
        const result = syncCodexHistory({
          dataDir: options.dataDir,
          historyPath: target === "codex" ? options.historyPath : undefined,
        });
        outcomes.push({
          provider: "codex",
          status: result.status,
          inserted: result.inserted,
          skipped: result.skipped,
          touchedSessionIds: result.touchedSessionIds,
          reason: result.reason,
        });
      }

      if (target === "gemini" || target === "all") {
        const result = syncGeminiHistory({
          dataDir: options.dataDir,
          historyPath: target === "gemini" ? options.historyPath : undefined,
        });
        outcomes.push({
          provider: "gemini",
          status: result.status,
          inserted: result.inserted,
          skipped: result.skipped,
          touchedSessionIds: result.touchedSessionIds,
          reason: result.reason,
        });
      }

      if (outcomes.length === 0) {
        console.error(`Invalid sync target: ${agent}. Use codex, gemini, or all.`);
        process.exitCode = 1;
        return;
      }

      printSyncOutcomes(outcomes);
      enqueueAutoSummariesFromSync(outcomes, options.dataDir, "auto_sync");
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
    const config = loadAppConfig(options.dataDir);

    console.log(`Default data directory: ${DEFAULT_DATA_DIR}`);
    console.log(`Active data directory: ${dataDir}`);
    console.log(`Expected DB filename: ${DB_FILENAME}`);
    console.log(`Config version: ${config.version}`);

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

    console.log("");
    console.log("Integrations:");
    const codex = config.integrations?.codex;
    const gemini = config.integrations?.gemini;
    console.log(
      `- codex: ${
        codex
          ? `${codex.enabled ? "enabled" : "disabled"} (${codex.historyPath})`
          : "not configured"
      }`,
    );
    console.log(
      `- gemini: ${
        gemini
          ? `${gemini.enabled ? "enabled" : "disabled"} (${gemini.historyPath})`
          : "not configured"
      }`,
    );
  });

program
  .command("summarize")
  .description("Generate and store a session capsule with intent/task breakdown")
  .option("--session <id>", "Session id or latest", "latest")
  .option(
    "--pending",
    "Backfill recent sessions that are missing capsule or intent labels",
  )
  .option("--limit <count>", "Max sessions to process with --pending", "20")
  .option("--data-dir <path>", "Custom data directory")
  .action(async (options: { session: string; pending?: boolean; limit: string; dataDir?: string }) => {
    initDatabase(options.dataDir);
    const syncOutcomes = syncEnabledIntegrations(options.dataDir);
    printSyncOutcomes(syncOutcomes);
    enqueueAutoSummariesFromSync(syncOutcomes, options.dataDir, "auto_sync_pre_summarize");

    if (options.pending) {
      const parsedLimit = Number(options.limit);
      const limit = Number.isFinite(parsedLimit)
        ? Math.max(1, Math.min(200, Math.floor(parsedLimit)))
        : 20;

      const candidates = listSessions(
        {
          limit,
        },
        options.dataDir,
      )
        .filter(
          (session) =>
            !session.hasCapsule ||
            session.intentLabel === null ||
            (session.intentLabel === "other" &&
              (session.intentConfidence ?? 0) <= 0.35),
        )
        .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));

      if (candidates.length === 0) {
        console.log("No pending sessions to summarize.");
        return;
      }

      let stored = 0;
      let skipped = 0;
      let failed = 0;
      for (const session of candidates) {
        const result = await summarizeSessionByRef({
          sessionRef: session.id,
          dataDir: options.dataDir,
          source: "manual_summarize_pending",
          skipIfFresh: false,
        });

        if (result.status === "stored") {
          stored += 1;
          continue;
        }
        if (result.status === "skipped") {
          skipped += 1;
          if (result.reason === "summarizer_not_configured") {
            console.error("Summarizer is not configured.");
            console.error(
              "Run: ctx-ledger configure summarizer --provider ollama --model llama3.1 --capture-prompts on",
            );
            process.exitCode = 1;
            return;
          }
          continue;
        }

        failed += 1;
      }

      console.log(
        `Backfill complete. Processed: ${candidates.length}, stored: ${stored}, skipped: ${skipped}, failed: ${failed}.`,
      );
      if (failed > 0) {
        process.exitCode = 1;
      }
      return;
    }

    const result = await summarizeSessionByRef({
      sessionRef: options.session,
      dataDir: options.dataDir,
      source: "manual_summarize",
      skipIfFresh: false,
    });

    if (result.status === "stored") {
      console.log("Session summary stored.");
      console.log(`Session: ${result.sessionId}`);
      console.log(`Primary intent: ${result.primaryIntent ?? "unknown"}`);
      console.log(`Task buckets: ${result.taskBuckets ?? 0}`);
      console.log(`Capsule outcomes: ${result.outcomes ?? 0}`);
      return;
    }

    if (result.status === "skipped") {
      if (result.reason === "summarizer_not_configured") {
        console.error("Summarizer is not configured.");
        console.error(
          "Run: ctx-ledger configure summarizer --provider ollama --model llama3.1 --capture-prompts on",
        );
      } else if (result.reason === "session_not_found") {
        console.error(`No session found for: ${options.session}`);
      } else if (result.reason === "already_up_to_date") {
        console.log(`Session ${result.sessionId} is already up to date.`);
      } else {
        console.log(`Summarize skipped: ${result.reason ?? "unknown_reason"}`);
      }

      if (result.reason === "session_not_found" || result.reason === "summarizer_not_configured") {
        process.exitCode = 1;
      }
      return;
    }

    console.error(`Failed to summarize session: ${result.error ?? "unknown error"}`);
    process.exitCode = 1;
  });

program
  .command("resume")
  .description("Build a next-session handoff pack and store it in resume_packs")
  .option(
    "--from <sessionRef>",
    "Session id or latest (repeatable, default latest)",
    collectOption,
    [],
  )
  .option("--budget <tokens>", "Approximate token budget", "2000")
  .option("--format <format>", "Output format (markdown|json)", "markdown")
  .option("--title <title>", "Optional resume pack title")
  .option("--out <path>", "Write output to file")
  .addHelpText(
    "after",
    [
      "",
      "What this command does:",
      "- Pulls selected sessions (or latest) from the local ledger.",
      "- Uses saved capsules/task breakdowns/prompt samples to build a handoff document.",
      "- Stores the generated pack in `resume_packs` for later listing/export.",
      "",
      "Tip: run `ctx-ledger summarize --session <id>` first for richer resume content.",
    ].join("\n"),
  )
  .option("--data-dir <path>", "Custom data directory")
  .action(
    (options: {
      from: string[];
      budget: string;
      format: string;
      title?: string;
      out?: string;
      dataDir?: string;
    }) => {
      const format = options.format.trim().toLowerCase();
      if (format !== "markdown" && format !== "json") {
        console.error(`Invalid format: ${options.format}. Use markdown or json.`);
        process.exitCode = 1;
        return;
      }

      initDatabase(options.dataDir);
      const syncOutcomes = syncEnabledIntegrations(options.dataDir);
      const suppressSyncOutput = format === "json" && !options.out;
      if (!suppressSyncOutput) {
        printSyncOutcomes(syncOutcomes);
      }
      enqueueAutoSummariesFromSync(syncOutcomes, options.dataDir, "auto_sync_pre_resume");

      const sessionRefs = options.from.length > 0 ? options.from : ["latest"];
      const contexts = loadResumeSessionContexts(sessionRefs, options.dataDir);
      if (contexts.length === 0) {
        console.error("No sessions found for resume pack.");
        process.exitCode = 1;
        return;
      }

      const budget = Number(options.budget);
      if (!Number.isFinite(budget) || budget <= 0) {
        console.error(`Invalid budget: ${options.budget}`);
        process.exitCode = 1;
        return;
      }

      const resume = buildResumePack(contexts, {
        title: options.title,
        tokenBudget: budget,
      });

      const saved = saveResumePack(
        {
          title: resume.title,
          sourceSessionIds: resume.sourceSessionIds,
          tokenBudget: budget,
          contentMarkdown: resume.markdown,
          metadata: {
            estimatedTokens: resume.estimatedTokens,
            sections: resume.sections,
            sourceCount: contexts.length,
          },
        },
        options.dataDir,
      );

      const payload =
        format === "json"
          ? JSON.stringify(
              {
                id: saved.id,
                title: resume.title,
                estimatedTokens: resume.estimatedTokens,
                sourceSessionIds: resume.sourceSessionIds,
                markdown: resume.markdown,
              },
              null,
              2,
            )
          : resume.markdown;

      const outputMetadata = [
        `Resume pack saved with id: ${saved.id}`,
        `Estimated tokens: ${resume.estimatedTokens}`,
        `Sessions included: ${resume.sourceSessionIds.length}`,
        "Content sources: summaries, outcomes, TODOs, files, commands, errors, and prompt samples (when captured).",
      ];

      if (options.out) {
        writeFileSync(options.out, `${payload}\n`, "utf8");
        console.log(`Resume pack written: ${options.out}`);
        for (const line of outputMetadata) {
          console.log(line);
        }
      } else {
        if (format === "json") {
          console.log(payload);
        } else {
          console.log(payload);
          console.log("");
          for (const line of outputMetadata) {
            console.log(line);
          }
        }
      }
    },
  );

program
  .command("handoff")
  .description("Generate handoff context and start a coding agent with it")
  .requiredOption("--agent <agent>", "Target agent (claude|codex)")
  .option(
    "--from <sessionRef>",
    "Session id or latest (repeatable, default latest)",
    collectOption,
    [],
  )
  .option("--budget <tokens>", "Approximate token budget", "2000")
  .option("--title <title>", "Optional resume pack title")
  .option("--format <format>", "Output format when using --no-launch (markdown|json)", "markdown")
  .option("--out <path>", "Write generated handoff payload to file")
  .option(
    "--agent-arg <arg>",
    "Additional argument passed to the agent command (repeatable)",
    collectOption,
    [],
  )
  .option("--no-launch", "Generate handoff only; do not launch agent process")
  .addHelpText(
    "after",
    [
      "",
      "What this command does:",
      "- Builds a resume pack from selected sessions.",
      "- Wraps it in a verify-state-first continuation prompt.",
      "- Starts claude/codex with that prompt by default.",
      "",
      "Use --no-launch to print/write the handoff prompt without opening an agent session.",
    ].join("\n"),
  )
  .option("--data-dir <path>", "Custom data directory")
  .action(
    (options: {
      agent: string;
      from: string[];
      budget: string;
      title?: string;
      format: string;
      out?: string;
      agentArg: string[];
      launch: boolean;
      dataDir?: string;
    }) => {
      const agent = ensureHandoffAgent(options.agent);
      if (!agent) {
        console.error(`Invalid agent: ${options.agent}. Use claude or codex.`);
        process.exitCode = 1;
        return;
      }

      const format = options.format.trim().toLowerCase();
      if (format !== "markdown" && format !== "json") {
        console.error(`Invalid format: ${options.format}. Use markdown or json.`);
        process.exitCode = 1;
        return;
      }

      initDatabase(options.dataDir);
      const syncOutcomes = syncEnabledIntegrations(options.dataDir);
      const suppressSyncOutput = format === "json" && !options.out && !options.launch;
      if (!suppressSyncOutput) {
        printSyncOutcomes(syncOutcomes);
      }
      enqueueAutoSummariesFromSync(syncOutcomes, options.dataDir, "auto_sync_pre_handoff");

      const sessionRefs = options.from.length > 0 ? options.from : ["latest"];
      const contexts = loadResumeSessionContexts(sessionRefs, options.dataDir);
      if (contexts.length === 0) {
        console.error("No sessions found for handoff.");
        process.exitCode = 1;
        return;
      }

      const budget = Number(options.budget);
      if (!Number.isFinite(budget) || budget <= 0) {
        console.error(`Invalid budget: ${options.budget}`);
        process.exitCode = 1;
        return;
      }

      const resume = buildResumePack(contexts, {
        title: options.title,
        tokenBudget: budget,
      });

      const saved = saveResumePack(
        {
          title: resume.title,
          sourceSessionIds: resume.sourceSessionIds,
          tokenBudget: budget,
          contentMarkdown: resume.markdown,
          metadata: {
            estimatedTokens: resume.estimatedTokens,
            sections: resume.sections,
            sourceCount: contexts.length,
            handoffTarget: agent,
          },
        },
        options.dataDir,
      );

      const handoffPrompt = buildHandoffPrompt({
        agent,
        resumePackId: saved.id,
        resumeTitle: resume.title,
        sourceSessionIds: resume.sourceSessionIds,
        estimatedTokens: resume.estimatedTokens,
        resumeMarkdown: resume.markdown,
      });

      const payload =
        format === "json"
          ? JSON.stringify(
              {
                resumePackId: saved.id,
                title: resume.title,
                estimatedTokens: resume.estimatedTokens,
                sourceSessionIds: resume.sourceSessionIds,
                agent,
                prompt: handoffPrompt,
              },
              null,
              2,
            )
          : handoffPrompt;

      if (options.out) {
        writeFileSync(options.out, `${payload}\n`, "utf8");
        console.log(`Handoff payload written: ${options.out}`);
      }

      if (!options.launch) {
        if (!options.out) {
          console.log(payload);
        }
        const suppressMetadata = format === "json" && !options.out;
        if (!suppressMetadata) {
          if (format !== "json") {
            console.log("");
          }
          console.log(`Resume pack saved with id: ${saved.id}`);
          console.log(`Sessions included: ${resume.sourceSessionIds.length}`);
          console.log(`Target agent: ${agent}`);
        }
        return;
      }

      console.log(`Resume pack saved with id: ${saved.id}`);
      console.log(`Target agent: ${agent}`);
      console.log("Launching agent with handoff context...");

      const launch = launchAgentWithPrompt(agent, handoffPrompt, options.agentArg);
      console.log(`Launch command: ${launch.command}`);

      if (launch.error) {
        console.error(`Failed to launch ${agent}: ${launch.error}`);
        if (!options.out) {
          console.log("");
          console.log("Generated handoff prompt:");
          console.log(handoffPrompt);
        }
        process.exitCode = 1;
        return;
      }

      if (launch.status !== 0) {
        console.error(`${agent} exited with status ${launch.status}.`);
        if (!options.out) {
          console.log("");
          console.log("Generated handoff prompt:");
          console.log(handoffPrompt);
        }
        process.exitCode = launch.status;
      }
    },
  );

program
  .command("stats")
  .description("Show usage analytics and time breakdowns")
  .option("--range <range>", "Range filter (24h|7d|30d|all)", "7d")
  .option("--group-by <group>", "Group view (intent|tool|agent|day|all)", "all")
  .option("--format <format>", "Output format (table|json)", "table")
  .option("--data-dir <path>", "Custom data directory")
  .action(
    (options: {
      range: string;
      groupBy: string;
      format: string;
      dataDir?: string;
    }) => {
      const format = options.format.trim().toLowerCase();
      if (format !== "table" && format !== "json") {
        console.error(`Invalid format: ${options.format}. Use table or json.`);
        process.exitCode = 1;
        return;
      }
      const range = options.range.trim().toLowerCase();
      if (!STATS_RANGE_VALUES.has(range)) {
        console.error(`Invalid range: ${options.range}. Use 24h, 7d, 30d, or all.`);
        process.exitCode = 1;
        return;
      }
      const groupBy = options.groupBy.trim().toLowerCase();
      if (format === "table" && !STATS_GROUP_VALUES.has(groupBy)) {
        console.error(
          `Invalid group-by: ${options.groupBy}. Use intent, tool, agent, day, or all.`,
        );
        process.exitCode = 1;
        return;
      }

      initDatabase(options.dataDir);
      const syncOutcomes = syncEnabledIntegrations(options.dataDir);
      if (format !== "json") {
        printSyncOutcomes(syncOutcomes);
      }
      enqueueAutoSummariesFromSync(syncOutcomes, options.dataDir, "auto_sync_pre_stats");

      const { label, sinceIso } = parseRange(range);
      const stats = getUsageStats(label, sinceIso, options.dataDir);

      if (format === "json") {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log(`Range: ${stats.rangeLabel}`);
      console.log(
        `Sessions: ${stats.summary.sessions} | Minutes: ${formatNumber(
          stats.summary.totalMinutes,
        )} | Events: ${stats.summary.events} | Tool Calls: ${stats.summary.toolCalls}`,
      );
      console.log("");

      if (groupBy === "intent" || groupBy === "all") {
        console.log("By Intent");
        printTable(
          ["Intent", "Sessions", "Minutes", "Avg Confidence"],
          stats.byIntent.map((row) => [
            row.label,
            String(row.sessions),
            formatNumber(row.totalMinutes),
            row.avgConfidence.toFixed(2),
          ]),
        );
        console.log("");
      }

      if (groupBy === "tool" || groupBy === "all") {
        console.log("By Tool");
        printTable(
          ["Tool", "Calls", "Success", "Seconds"],
          stats.byTool.map((row) => [
            row.toolName,
            String(row.calls),
            String(row.successCalls),
            formatNumber(row.totalSeconds),
          ]),
        );
        console.log("");
      }

      if (groupBy === "agent" || groupBy === "all") {
        console.log("By Agent");
        printTable(
          ["Agent", "Provider", "Sessions", "Minutes"],
          stats.byAgent.map((row) => [
            row.agent,
            row.provider,
            String(row.sessions),
            formatNumber(row.totalMinutes),
          ]),
        );
        console.log("");
      }

      if (groupBy === "day" || groupBy === "all") {
        console.log("By Day");
        printTable(
          ["Day", "Sessions", "Minutes"],
          stats.byDay.map((row) => [
            row.day,
            String(row.sessions),
            formatNumber(row.totalMinutes),
          ]),
        );
        console.log("");
      }
    },
  );

program
  .command("dashboard")
  .description("Start local dashboard server")
  .option("--port <port>", "Port to bind", "4173")
  .option("--data-dir <path>", "Custom data directory")
  .action(async (options: { port: string; dataDir?: string }) => {
    initDatabase(options.dataDir);
    const syncOutcomes = syncEnabledIntegrations(options.dataDir);
    printSyncOutcomes(syncOutcomes);
    enqueueAutoSummariesFromSync(syncOutcomes, options.dataDir, "auto_sync_pre_dashboard");

    const port = Number(options.port);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      console.error(`Invalid port: ${options.port}`);
      process.exitCode = 1;
      return;
    }

    try {
      const server = await startDashboardServer({
        port,
        dataDir: options.dataDir,
      });
      console.log(`ContextLedger dashboard running at http://127.0.0.1:${port}`);
      console.log("Press Ctrl+C to stop.");

      process.on("SIGINT", () => {
        server.close(() => process.exit(0));
      });
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code
          : undefined;

      if (code === "EADDRINUSE") {
        console.error(`Port ${port} is already in use on 127.0.0.1.`);
        console.error("Choose another port, e.g. `ctx-ledger dashboard --port 4174`.");
      } else {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to start dashboard: ${message}`);
      }
      process.exitCode = 1;
    }
  });

program
  .command("resume-packs")
  .description("List recent stored resume packs")
  .option("--limit <count>", "Limit rows", "20")
  .option("--format <format>", "Output format (table|json)", "table")
  .option("--data-dir <path>", "Custom data directory")
  .action(
    (options: { limit: string; format: string; dataDir?: string }) => {
      const limit = Number(options.limit);
      const rows = listResumePacks(
        Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 20,
        options.dataDir,
      );

      if (options.format.trim().toLowerCase() === "json") {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }

      printTable(
        ["ID", "Title", "Sessions", "Budget", "Created"],
        rows.map((row) => [
          row.id,
          row.title,
          String(row.sourceSessionIds.length),
          String(row.tokenBudget),
          row.createdAt,
        ]),
      );
    },
  );

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
      const result = ingestClaudeHookPayload(payload, options.dataDir);
      if (result?.hookEventName === "SessionEnd") {
        enqueueAutoSummaries(
          [result.sessionId],
          options.dataDir,
          "auto_claude_session_end",
        );
      }
    } catch {
      // Hook ingestion must never interrupt a coding session.
    }
  });

program
  .command("internal-auto-summarize", { hidden: true })
  .description("Internal auto summarization command")
  .requiredOption("--session <id>", "Session id to summarize")
  .option("--source <source>", "Label source", "auto")
  .option("--data-dir <path>", "Custom data directory")
  .action(
    async (options: { session: string; source: string; dataDir?: string }) => {
      try {
        await summarizeSessionByRef({
          sessionRef: options.session,
          dataDir: options.dataDir,
          source: options.source,
          skipIfFresh: true,
        });
      } catch {
        // Internal auto summarization should never interrupt users.
      }
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error("Command failed:", error);
  process.exit(1);
});
