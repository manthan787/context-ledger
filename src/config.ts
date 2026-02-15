import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./storage/db";

export type SummarizerProvider = "ollama" | "openai" | "anthropic";
export const CURRENT_CONFIG_VERSION = 1 as const;

export interface SummarizerConfig {
  provider: SummarizerProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface PrivacyConfig {
  capturePrompts: boolean;
  redactSecrets: boolean;
  redactEmails: boolean;
  additionalRedactionPatterns: string[];
  allowRemotePromptTransfer: boolean;
}

export interface HistoryIntegrationConfig {
  enabled: boolean;
  historyPath: string;
  cursor: number;
}

export interface CodexSessionFileStateConfig {
  sessionId?: string;
  repoPath?: string;
  branch?: string;
}

export interface CodexIntegrationConfig extends HistoryIntegrationConfig {
  sessionsPath?: string;
  sessionFileCursors?: Record<string, number>;
  sessionFileState?: Record<string, CodexSessionFileStateConfig>;
}

export interface IntegrationsConfig {
  codex?: CodexIntegrationConfig;
  gemini?: HistoryIntegrationConfig;
}

export interface AppConfig {
  version: number;
  summarizer?: SummarizerConfig;
  privacy: PrivacyConfig;
  integrations?: IntegrationsConfig;
}

const CONFIG_FILE = "config.json";

function getConfigPath(explicitDataDir?: string): string {
  return join(getDataDir(explicitDataDir), CONFIG_FILE);
}

function defaultPrivacyConfig(): PrivacyConfig {
  return {
    capturePrompts: false,
    redactSecrets: true,
    redactEmails: false,
    additionalRedactionPatterns: [],
    allowRemotePromptTransfer: false,
  };
}

function normalizeSummarizerConfig(input: unknown): SummarizerConfig | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const candidate = input as Record<string, unknown>;
  const provider = candidate.provider;
  const model = candidate.model;
  if (
    (provider !== "ollama" && provider !== "openai" && provider !== "anthropic") ||
    typeof model !== "string" ||
    model.trim().length === 0
  ) {
    return undefined;
  }

  return {
    provider,
    model: model.trim(),
    baseUrl:
      typeof candidate.baseUrl === "string" && candidate.baseUrl.trim().length > 0
        ? candidate.baseUrl.trim()
        : undefined,
    apiKey:
      typeof candidate.apiKey === "string" && candidate.apiKey.trim().length > 0
        ? candidate.apiKey.trim()
        : undefined,
  };
}

function normalizeIntegrationConfig(input: unknown): HistoryIntegrationConfig | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const candidate = input as Record<string, unknown>;
  const historyPath =
    typeof candidate.historyPath === "string" ? candidate.historyPath.trim() : "";
  if (historyPath.length === 0) {
    return undefined;
  }

  const cursorRaw = candidate.cursor;
  const cursor = typeof cursorRaw === "number" && Number.isFinite(cursorRaw) && cursorRaw >= 0
    ? Math.floor(cursorRaw)
    : 0;

  return {
    enabled: candidate.enabled !== false,
    historyPath,
    cursor,
  };
}

function normalizeSessionFileCursors(input: unknown): Record<string, number> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }

  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof key !== "string" || key.trim().length === 0) {
      continue;
    }
    const cursor =
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : null;
    if (cursor !== null) {
      out[key] = cursor;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeCodexIntegrationConfig(input: unknown): CodexIntegrationConfig | undefined {
  const base = normalizeIntegrationConfig(input);
  if (!base) {
    return undefined;
  }

  const candidate =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const sessionsPath =
    typeof candidate.sessionsPath === "string" && candidate.sessionsPath.trim().length > 0
      ? candidate.sessionsPath.trim()
      : undefined;
  const sessionFileCursors = normalizeSessionFileCursors(candidate.sessionFileCursors);
  const sessionFileState: Record<string, CodexSessionFileStateConfig> = {};
  if (
    candidate.sessionFileState &&
    typeof candidate.sessionFileState === "object" &&
    !Array.isArray(candidate.sessionFileState)
  ) {
    for (const [filePath, raw] of Object.entries(
      candidate.sessionFileState as Record<string, unknown>,
    )) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        continue;
      }
      const state = raw as Record<string, unknown>;
      const sessionId =
        typeof state.sessionId === "string" && state.sessionId.trim().length > 0
          ? state.sessionId.trim()
          : undefined;
      const repoPath =
        typeof state.repoPath === "string" && state.repoPath.trim().length > 0
          ? state.repoPath.trim()
          : undefined;
      const branch =
        typeof state.branch === "string" && state.branch.trim().length > 0
          ? state.branch.trim()
          : undefined;
      if (!sessionId && !repoPath && !branch) {
        continue;
      }
      sessionFileState[filePath] = { sessionId, repoPath, branch };
    }
  }

  return {
    ...base,
    sessionsPath,
    sessionFileCursors,
    sessionFileState:
      Object.keys(sessionFileState).length > 0 ? sessionFileState : undefined,
  };
}

function normalizeConfig(input: unknown): AppConfig {
  const defaults: AppConfig = {
    version: CURRENT_CONFIG_VERSION,
    privacy: defaultPrivacyConfig(),
  };

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return defaults;
  }

  const raw = input as Record<string, unknown>;
  const legacyPrivacy = raw.privacy && typeof raw.privacy === "object" && !Array.isArray(raw.privacy)
    ? (raw.privacy as Record<string, unknown>)
    : null;

  const privacy: PrivacyConfig = {
    capturePrompts:
      typeof legacyPrivacy?.capturePrompts === "boolean"
        ? legacyPrivacy.capturePrompts
        : defaults.privacy.capturePrompts,
    redactSecrets:
      typeof legacyPrivacy?.redactSecrets === "boolean"
        ? legacyPrivacy.redactSecrets
        : defaults.privacy.redactSecrets,
    redactEmails:
      typeof legacyPrivacy?.redactEmails === "boolean"
        ? legacyPrivacy.redactEmails
        : defaults.privacy.redactEmails,
    additionalRedactionPatterns: Array.isArray(legacyPrivacy?.additionalRedactionPatterns)
      ? legacyPrivacy!.additionalRedactionPatterns.filter(
          (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
        )
      : defaults.privacy.additionalRedactionPatterns,
    allowRemotePromptTransfer:
      typeof legacyPrivacy?.allowRemotePromptTransfer === "boolean"
        ? legacyPrivacy.allowRemotePromptTransfer
        : defaults.privacy.allowRemotePromptTransfer,
  };

  const integrationsRaw =
    raw.integrations && typeof raw.integrations === "object" && !Array.isArray(raw.integrations)
      ? (raw.integrations as Record<string, unknown>)
      : null;

  const codex = normalizeCodexIntegrationConfig(integrationsRaw?.codex);
  const gemini = normalizeIntegrationConfig(integrationsRaw?.gemini);

  const normalized: AppConfig = {
    version: CURRENT_CONFIG_VERSION,
    summarizer: normalizeSummarizerConfig(raw.summarizer),
    privacy,
  };

  if (codex || gemini) {
    normalized.integrations = {};
    if (codex) {
      normalized.integrations.codex = codex;
    }
    if (gemini) {
      normalized.integrations.gemini = gemini;
    }
  }

  return normalized;
}

export function loadAppConfig(explicitDataDir?: string): AppConfig {
  const configPath = getConfigPath(explicitDataDir);
  if (!existsSync(configPath)) {
    return normalizeConfig(null);
  }

  const raw = readFileSync(configPath, "utf8").trim();
  if (raw.length === 0) {
    return normalizeConfig(null);
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeConfig(parsed);
  } catch {
    return normalizeConfig(null);
  }
}

export function saveAppConfig(config: AppConfig, explicitDataDir?: string): string {
  const dataDir = getDataDir(explicitDataDir);
  mkdirSync(dataDir, { recursive: true });
  const configPath = getConfigPath(explicitDataDir);
  const normalized = normalizeConfig(config);
  writeFileSync(configPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return configPath;
}

export function getConfigPathForDisplay(explicitDataDir?: string): string {
  return getConfigPath(explicitDataDir);
}
