import * as p from "@clack/prompts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadAppConfig,
  saveAppConfig,
  type AppConfig,
  type SummarizerProvider,
} from "../config";
import { enableClaude, syncClaudeBackfill } from "../integrations/claude";
import { enableCodex, syncCodexHistory } from "../integrations/codex";
import { enableGemini, syncGeminiHistory } from "../integrations/gemini";
import { initDatabase, getDataDir } from "../storage/db";

export type ClaudeEnableScope = "user" | "project";

export interface OnboardWizardOptions {
  scope?: ClaudeEnableScope;
  provider?: SummarizerProvider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  claudeProjectsPath?: string;
  historyPath?: string;
  sessionsPath?: string;
  skipClaude?: boolean;
  skipCodex?: boolean;
  dashboardPort?: number;
  dashboard?: boolean;
  dataDir?: string;
  nonInteractive?: boolean;
  resolveHookCliEntrypointPath: () => string;
  launchDashboardInBackground: (input: {
    requestedPort: number;
    dataDir?: string;
    maxPortFallbackSteps?: number;
  }) => Promise<{
    requestedPort: number;
    selectedPort: number;
    pid: number | undefined;
    logPath: string;
  }>;
}

interface IntegrationSelection {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
}

interface SyncOutcome {
  provider: "claude" | "codex" | "gemini";
  status: "ok" | "skipped";
  inserted: number;
  skipped: number;
  reason?: string;
}

function isNonInteractiveMode(options: OnboardWizardOptions): boolean {
  // Explicit flag takes precedence
  if (options.nonInteractive) {
    return true;
  }
  // If stdin is not a TTY (piped input, CI environment), use non-interactive
  if (!process.stdin.isTTY) {
    return true;
  }
  return false;
}

function printHeader(): void {
  p.intro(`ContextLedger - AI Coding Session Analytics`);
}

function printCancelled(): void {
  p.cancel("Setup cancelled.");
}

async function stepInitializeStorage(
  options: OnboardWizardOptions,
): Promise<{ dataDir: string; dbPath: string; configPath: string } | null> {
  const s = p.spinner();
  s.start("Initializing storage");

  try {
    const { dataDir, dbPath } = initDatabase(options.dataDir);
    const existing = loadAppConfig(options.dataDir);
    const nextConfig: AppConfig = {
      ...existing,
      privacy: {
        ...existing.privacy,
        capturePrompts: true,
      },
    };
    const configPath = saveAppConfig(nextConfig, options.dataDir);

    s.stop("Storage initialized");

    p.note(
      [
        `Database: ${dbPath}`,
        `Config:   ${configPath}`,
      ].join("\n"),
      "Storage paths"
    );

    return { dataDir, dbPath, configPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    s.stop(`Failed to initialize storage: ${message}`);
    return null;
  }
}

async function stepSelectIntegrations(
  options: OnboardWizardOptions,
): Promise<IntegrationSelection | null> {
  // Check which integrations might be available
  const claudeSettingsPath = join(homedir(), ".claude", "settings.json");
  const codexHistoryPath = join(homedir(), ".codex", "history.jsonl");
  const geminiHistoryPath = join(homedir(), ".gemini", "history.jsonl");

  const claudeAvailable = existsSync(claudeSettingsPath) || existsSync(join(homedir(), ".claude"));
  const codexAvailable = existsSync(codexHistoryPath) || existsSync(join(homedir(), ".codex"));
  const geminiAvailable = existsSync(geminiHistoryPath) || existsSync(join(homedir(), ".gemini"));

  const integrationOptions: { value: string; label: string; hint?: string }[] = [];

  // Only show integrations that aren't explicitly skipped via flags
  if (!options.skipClaude) {
    integrationOptions.push({
      value: "claude",
      label: "Claude Code",
      hint: claudeAvailable ? "detected" : "recommended",
    });
  }

  if (!options.skipCodex) {
    integrationOptions.push({
      value: "codex",
      label: "OpenAI Codex CLI",
      hint: codexAvailable ? "detected" : undefined,
    });
  }

  integrationOptions.push({
    value: "gemini",
    label: "Gemini CLI",
    hint: geminiAvailable ? "detected" : undefined,
  });

  // If all integrations are skipped, return empty selection
  if (integrationOptions.length === 0) {
    return { claude: false, codex: false, gemini: false };
  }

  // Build initial values based on detection (only for non-skipped integrations)
  const initialValues: string[] = [];
  if (!options.skipClaude && claudeAvailable) initialValues.push("claude");
  if (!options.skipCodex && codexAvailable) initialValues.push("codex");
  if (geminiAvailable) initialValues.push("gemini");
  // If nothing detected, default to claude (if not skipped)
  if (initialValues.length === 0 && !options.skipClaude) {
    initialValues.push("claude");
  }

  const selected = await p.multiselect({
    message: "Which AI coding agents do you use?",
    options: integrationOptions,
    initialValues,
    required: false,
  });

  if (p.isCancel(selected)) {
    return null;
  }

  const selectedSet = new Set(selected as string[]);
  return {
    claude: selectedSet.has("claude"),
    codex: selectedSet.has("codex"),
    gemini: selectedSet.has("gemini"),
  };
}

async function stepInstallClaudeHooks(
  options: OnboardWizardOptions,
  scope: ClaudeEnableScope,
): Promise<{ success: boolean; hookCount: number; message?: string }> {
  const s = p.spinner();
  s.start("Installing Claude Code hooks");

  try {
    const result = enableClaude({
      scope,
      cwd: process.cwd(),
      dataDir: options.dataDir,
      projectsPath: options.claudeProjectsPath,
      cliEntrypointPath: options.resolveHookCliEntrypointPath(),
      nodePath: process.execPath,
    });

    s.stop(`${result.addedHooks} hooks installed`);

    return { success: true, hookCount: result.addedHooks };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    s.stop(`Claude hooks skipped: ${message}`);
    return { success: false, hookCount: 0, message };
  }
}

async function stepInstallCodexIntegration(
  options: OnboardWizardOptions,
): Promise<{ success: boolean; historyPath: string; sessionsPath: string }> {
  const s = p.spinner();
  s.start("Enabling Codex integration");

  try {
    const result = enableCodex({
      dataDir: options.dataDir,
      historyPath: options.historyPath,
      sessionsPath: options.sessionsPath,
    });

    s.stop("Codex integration enabled");

    return {
      success: true,
      historyPath: result.historyPath,
      sessionsPath: result.sessionsPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    s.stop(`Codex integration failed: ${message}`);
    return { success: false, historyPath: "", sessionsPath: "" };
  }
}

async function stepInstallGeminiIntegration(
  options: OnboardWizardOptions,
): Promise<{ success: boolean; historyPath: string }> {
  const s = p.spinner();
  s.start("Enabling Gemini integration");

  try {
    const result = enableGemini({
      dataDir: options.dataDir,
      historyPath: options.historyPath,
    });

    s.stop("Gemini integration enabled");

    return {
      success: true,
      historyPath: result.historyPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    s.stop(`Gemini integration failed: ${message}`);
    return { success: false, historyPath: "" };
  }
}

async function stepSyncSessions(
  options: OnboardWizardOptions,
  integrations: IntegrationSelection,
): Promise<SyncOutcome[]> {
  const outcomes: SyncOutcome[] = [];

  if (integrations.claude) {
    const s = p.spinner();
    s.start("Backfilling Claude sessions");

    try {
      const config = loadAppConfig(options.dataDir);
      const result = syncClaudeBackfill({
        dataDir: options.dataDir,
        projectsPath: config.integrations?.claude?.projectsPath ?? options.claudeProjectsPath,
        force: false,
      });

      if (result.status === "ok") {
        s.stop(`Imported ${result.inserted} Claude events`);
        outcomes.push({
          provider: "claude",
          status: "ok",
          inserted: result.inserted,
          skipped: result.skipped,
        });
      } else {
        s.stop(`Claude backfill skipped: ${result.reason ?? "unknown reason"}`);
        outcomes.push({
          provider: "claude",
          status: "skipped",
          inserted: 0,
          skipped: 0,
          reason: result.reason,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      s.stop(`Claude backfill failed: ${message}`);
      outcomes.push({
        provider: "claude",
        status: "skipped",
        inserted: 0,
        skipped: 0,
        reason: message,
      });
    }
  }

  if (integrations.codex) {
    const s = p.spinner();
    s.start("Syncing Codex sessions");

    try {
      const config = loadAppConfig(options.dataDir);
      const result = syncCodexHistory({
        dataDir: options.dataDir,
        historyPath: config.integrations?.codex?.historyPath,
        sessionsPath: config.integrations?.codex?.sessionsPath,
      });

      if (result.status === "ok") {
        s.stop(`Imported ${result.inserted} Codex sessions`);
        outcomes.push({
          provider: "codex",
          status: "ok",
          inserted: result.inserted,
          skipped: result.skipped,
        });
      } else {
        s.stop(`Codex sync skipped: ${result.reason ?? "unknown reason"}`);
        outcomes.push({
          provider: "codex",
          status: "skipped",
          inserted: 0,
          skipped: 0,
          reason: result.reason,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      s.stop(`Codex sync failed: ${message}`);
      outcomes.push({
        provider: "codex",
        status: "skipped",
        inserted: 0,
        skipped: 0,
        reason: message,
      });
    }
  }

  if (integrations.gemini) {
    const s = p.spinner();
    s.start("Syncing Gemini sessions");

    try {
      const config = loadAppConfig(options.dataDir);
      const result = syncGeminiHistory({
        dataDir: options.dataDir,
        historyPath: config.integrations?.gemini?.historyPath,
      });

      if (result.status === "ok") {
        s.stop(`Imported ${result.inserted} Gemini sessions`);
        outcomes.push({
          provider: "gemini",
          status: "ok",
          inserted: result.inserted,
          skipped: result.skipped,
        });
      } else {
        s.stop(`Gemini sync skipped: ${result.reason ?? "unknown reason"}`);
        outcomes.push({
          provider: "gemini",
          status: "skipped",
          inserted: 0,
          skipped: 0,
          reason: result.reason,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      s.stop(`Gemini sync failed: ${message}`);
      outcomes.push({
        provider: "gemini",
        status: "skipped",
        inserted: 0,
        skipped: 0,
        reason: message,
      });
    }
  }

  return outcomes;
}

async function stepSummarizerSetup(
  options: OnboardWizardOptions,
): Promise<{
  provider: SummarizerProvider | null;
  model: string | null;
  skipped: boolean;
} | null> {
  const selected = await p.select({
    message: "Enable AI-powered session summaries?",
    options: [
      {
        value: "ollama",
        label: "Ollama (local, private)",
        hint: "recommended",
      },
      {
        value: "openai",
        label: "OpenAI",
        hint: "requires API key",
      },
      {
        value: "anthropic",
        label: "Anthropic",
        hint: "requires API key",
      },
      {
        value: "skip",
        label: "Skip for now",
        hint: "configure later",
      },
    ],
    initialValue: "skip",
  });

  if (p.isCancel(selected)) {
    return null;
  }

  if (selected === "skip") {
    return { provider: null, model: null, skipped: true };
  }

  const provider = selected as SummarizerProvider;

  // Suggest default models based on provider
  const defaultModels: Record<SummarizerProvider, string> = {
    ollama: "qwen3:4b",
    openai: "gpt-4o-mini",
    anthropic: "claude-3-5-sonnet-latest",
  };

  const model = await p.text({
    message: `Enter model name for ${provider}:`,
    placeholder: defaultModels[provider],
    defaultValue: defaultModels[provider],
  });

  if (p.isCancel(model)) {
    return null;
  }

  // For cloud providers, prompt for API key
  if (provider === "openai" || provider === "anthropic") {
    const apiKey = await p.password({
      message: `Enter your ${provider === "openai" ? "OpenAI" : "Anthropic"} API key:`,
    });

    if (p.isCancel(apiKey)) {
      return null;
    }

    if (apiKey && apiKey.trim().length > 0) {
      // Save the API key to config
      const config = loadAppConfig(options.dataDir);
      config.summarizer = {
        provider,
        model: model as string,
        apiKey: apiKey.trim(),
      };
      config.privacy.allowRemotePromptTransfer = true;
      saveAppConfig(config, options.dataDir);
    }
  } else {
    // Ollama - just save the config
    const config = loadAppConfig(options.dataDir);
    config.summarizer = {
      provider,
      model: model as string,
    };
    saveAppConfig(config, options.dataDir);
  }

  return { provider, model: model as string, skipped: false };
}

async function stepLaunchDashboard(
  options: OnboardWizardOptions,
  port: number,
): Promise<{
  launched: boolean;
  port?: number;
  pid?: number;
  logPath?: string;
} | null> {
  const shouldLaunch = await p.confirm({
    message: "Launch the dashboard?",
    initialValue: true,
  });

  if (p.isCancel(shouldLaunch)) {
    return null;
  }

  if (!shouldLaunch) {
    return { launched: false };
  }

  const s = p.spinner();
  s.start("Starting dashboard");

  try {
    const result = await options.launchDashboardInBackground({
      requestedPort: port,
      dataDir: options.dataDir,
      maxPortFallbackSteps: 20,
    });

    s.stop(`Dashboard running at http://127.0.0.1:${result.selectedPort}`);

    return {
      launched: true,
      port: result.selectedPort,
      pid: result.pid,
      logPath: result.logPath,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    s.stop(`Failed to start dashboard: ${message}`);
    return { launched: false };
  }
}

function printSuccessSummary(
  options: OnboardWizardOptions,
  results: {
    dataDir: string;
    integrations: IntegrationSelection;
    dashboardLaunched: boolean;
    dashboardPort?: number;
  },
): void {
  const nextSteps: string[] = [];

  if (results.integrations.claude) {
    nextSteps.push("Start coding with Claude Code");
  }
  if (results.integrations.codex) {
    nextSteps.push("Use Codex CLI for AI-assisted coding");
  }
  if (results.integrations.gemini) {
    nextSteps.push("Use Gemini CLI for AI-assisted coding");
  }

  nextSteps.push("Run `ctx-ledger stats` for analytics");

  if (results.dashboardLaunched && results.dashboardPort) {
    nextSteps.push(`Visit http://127.0.0.1:${results.dashboardPort} for web UI`);
  } else {
    nextSteps.push("Run `ctx-ledger dashboard` to start web UI");
  }

  p.note(nextSteps.map((step) => `- ${step}`).join("\n"), "Next steps");

  p.outro("Setup complete!");
}

export async function runOnboardWizard(
  options: OnboardWizardOptions,
): Promise<{ success: boolean; exitCode: number }> {
  // Check if running in non-interactive mode
  if (isNonInteractiveMode(options)) {
    return runNonInteractiveOnboard(options);
  }

  printHeader();

  // Step 1: Initialize storage
  const storageResult = await stepInitializeStorage(options);
  if (!storageResult) {
    printCancelled();
    return { success: false, exitCode: 1 };
  }

  // Step 2: Select integrations
  const integrations = await stepSelectIntegrations(options);
  if (integrations === null) {
    printCancelled();
    return { success: false, exitCode: 1 };
  }

  // Step 3: Install integrations
  const scope: ClaudeEnableScope = options.scope ?? "user";

  if (integrations.claude) {
    await stepInstallClaudeHooks(options, scope);
  }

  if (integrations.codex) {
    await stepInstallCodexIntegration(options);
  }

  if (integrations.gemini) {
    await stepInstallGeminiIntegration(options);
  }

  // Step 4: Sync existing sessions
  if (integrations.claude || integrations.codex || integrations.gemini) {
    await stepSyncSessions(options, integrations);
  }

  // Step 5: Summarizer setup
  const summarizerResult = await stepSummarizerSetup(options);
  if (summarizerResult === null) {
    printCancelled();
    return { success: false, exitCode: 1 };
  }

  // Step 6: Launch dashboard
  let dashboardResult: Awaited<ReturnType<typeof stepLaunchDashboard>> = null;

  if (options.dashboard !== false) {
    dashboardResult = await stepLaunchDashboard(
      options,
      options.dashboardPort ?? 4173,
    );
    if (dashboardResult === null) {
      printCancelled();
      return { success: false, exitCode: 1 };
    }
  }

  // Print success summary
  printSuccessSummary(options, {
    dataDir: storageResult.dataDir,
    integrations,
    dashboardLaunched: dashboardResult?.launched ?? false,
    dashboardPort: dashboardResult?.port,
  });

  return { success: true, exitCode: 0 };
}

async function runNonInteractiveOnboard(
  options: OnboardWizardOptions,
): Promise<{ success: boolean; exitCode: number }> {
  // Original non-interactive behavior for CI/scripting
  const { dataDir, dbPath } = initDatabase(options.dataDir);
  const existing = loadAppConfig(options.dataDir);
  const nextConfig: AppConfig = {
    ...existing,
    summarizer:
      options.provider && options.model
        ? {
            provider: options.provider,
            model: options.model,
            baseUrl: options.baseUrl ?? existing.summarizer?.baseUrl,
            apiKey: options.apiKey ?? existing.summarizer?.apiKey,
          }
        : existing.summarizer,
    privacy: {
      ...existing.privacy,
      capturePrompts: true,
      allowRemotePromptTransfer:
        options.provider === "openai" || options.provider === "anthropic"
          ? true
          : existing.privacy.allowRemotePromptTransfer,
    },
  };
  const configPath = saveAppConfig(nextConfig, options.dataDir);

  console.log("ContextLedger onboarding complete.");
  console.log(`Data directory: ${dataDir}`);
  console.log(`Database: ${dbPath}`);
  console.log(`Config file: ${configPath}`);
  console.log("Defaults applied:");
  console.log("- Prompt capture: on");
  console.log(
    `- Remote prompt transfer: ${
      nextConfig.privacy.allowRemotePromptTransfer ? "on" : "off"
    }`,
  );

  const scope: ClaudeEnableScope = options.scope ?? "user";

  if (!options.skipClaude) {
    try {
      const claudeResult = enableClaude({
        scope,
        cwd: process.cwd(),
        dataDir: options.dataDir,
        projectsPath: options.claudeProjectsPath,
        cliEntrypointPath: options.resolveHookCliEntrypointPath(),
        nodePath: process.execPath,
      });
      console.log(
        `- Claude integration: enabled (${claudeResult.addedHooks} hook bindings added)`,
      );
      console.log(`  Projects path: ${claudeResult.projectsPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`- Claude integration: skipped (${message})`);
    }
  } else {
    console.log("- Claude integration: skipped by option");
  }

  if (!options.skipCodex) {
    const codexResult = enableCodex({
      dataDir: options.dataDir,
      historyPath: options.historyPath,
      sessionsPath: options.sessionsPath,
    });
    console.log("- Codex integration: enabled");
    console.log(`  History path: ${codexResult.historyPath}`);
    console.log(`  Sessions path: ${codexResult.sessionsPath}`);
  } else {
    console.log("- Codex integration: skipped by option");
  }

  // Sync integrations
  const config = loadAppConfig(options.dataDir);
  const syncOutcomes: SyncOutcome[] = [];

  if (config.integrations?.claude?.enabled) {
    const result = syncClaudeBackfill({
      dataDir: options.dataDir,
      projectsPath: config.integrations.claude.projectsPath,
      force: false,
    });
    syncOutcomes.push({
      provider: "claude",
      status: result.status,
      inserted: result.inserted,
      skipped: result.skipped,
      reason: result.reason,
    });
  }

  if (config.integrations?.codex?.enabled) {
    const result = syncCodexHistory({
      dataDir: options.dataDir,
      historyPath: config.integrations.codex.historyPath,
      sessionsPath: config.integrations.codex.sessionsPath,
    });
    syncOutcomes.push({
      provider: "codex",
      status: result.status,
      inserted: result.inserted,
      skipped: result.skipped,
      reason: result.reason,
    });
  }

  if (config.integrations?.gemini?.enabled) {
    const result = syncGeminiHistory({
      dataDir: options.dataDir,
      historyPath: config.integrations.gemini.historyPath,
    });
    syncOutcomes.push({
      provider: "gemini",
      status: result.status,
      inserted: result.inserted,
      skipped: result.skipped,
      reason: result.reason,
    });
  }

  // Print sync outcomes
  for (const outcome of syncOutcomes) {
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

  console.log("");
  printSummarizerRecommendationNonInteractive(nextConfig);

  if (!options.dashboard) {
    console.log("");
    console.log(
      `Start dashboard anytime: ctx-ledger dashboard --port ${
        options.dashboardPort ?? 4173
      }`,
    );
    return { success: true, exitCode: 0 };
  }

  try {
    const launched = await options.launchDashboardInBackground({
      requestedPort: options.dashboardPort ?? 4173,
      dataDir: options.dataDir,
      maxPortFallbackSteps: 20,
    });
    console.log("");
    console.log(
      `Dashboard launched in background at http://127.0.0.1:${launched.selectedPort}`,
    );
    if (launched.selectedPort !== launched.requestedPort) {
      console.log(
        `Requested port ${launched.requestedPort} was busy; using ${launched.selectedPort}.`,
      );
    }
    if (typeof launched.pid === "number" && Number.isFinite(launched.pid)) {
      console.log(`Dashboard PID: ${launched.pid}`);
    }
    console.log(`Dashboard log: ${launched.logPath}`);
    console.log("Onboarding finished.");
    return { success: true, exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Failed to launch dashboard in background after onboarding: ${message}`,
    );
    return { success: false, exitCode: 1 };
  }
}

function printSummarizerRecommendationNonInteractive(config: AppConfig): void {
  if (config.summarizer) {
    console.log(
      `Summarizer: ${config.summarizer.provider}/${config.summarizer.model}`,
    );
    return;
  }

  console.log("Summarizer: not configured yet (recommended)");
  console.log(
    "Local model (recommended): ctx-ledger configure summarizer --provider ollama --model qwen3:4b",
  );
  console.log(
    "OpenAI: ctx-ledger configure summarizer --provider openai --model gpt-4o-mini --api-key <key>",
  );
  console.log(
    "Anthropic: ctx-ledger configure summarizer --provider anthropic --model claude-3-5-sonnet-latest --api-key <key>",
  );
}
