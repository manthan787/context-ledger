import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDataDir } from "./storage/db";

export type SummarizerProvider = "ollama" | "openai" | "anthropic";

export interface SummarizerConfig {
  provider: SummarizerProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface PrivacyConfig {
  capturePrompts?: boolean;
}

export interface AppConfig {
  summarizer?: SummarizerConfig;
  privacy?: PrivacyConfig;
}

const CONFIG_FILE = "config.json";

function getConfigPath(explicitDataDir?: string): string {
  return join(getDataDir(explicitDataDir), CONFIG_FILE);
}

export function loadAppConfig(explicitDataDir?: string): AppConfig {
  const configPath = getConfigPath(explicitDataDir);
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, "utf8").trim();
  if (raw.length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as AppConfig;
  } catch {
    return {};
  }
}

export function saveAppConfig(config: AppConfig, explicitDataDir?: string): string {
  const dataDir = getDataDir(explicitDataDir);
  mkdirSync(dataDir, { recursive: true });
  const configPath = getConfigPath(explicitDataDir);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

export function getConfigPathForDisplay(explicitDataDir?: string): string {
  return getConfigPath(explicitDataDir);
}
