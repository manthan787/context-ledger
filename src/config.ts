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

export interface IntegrationsConfig {
  codex?: HistoryIntegrationConfig;
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

  const codex = normalizeIntegrationConfig(integrationsRaw?.codex);
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
