import { readFileSync } from "node:fs";
import { PrivacyConfig } from "../config";
import { redactText } from "../privacy/redaction";

export interface IncrementalJsonLinesResult {
  lines: string[];
  nextCursor: number;
  fileLength: number;
}

export function readIncrementalJsonLines(
  filePath: string,
  existingCursor: number,
): IncrementalJsonLinesResult {
  const contentBuffer = readFileSync(filePath);
  const fileLength = contentBuffer.length;
  const safeCursor =
    Number.isFinite(existingCursor) &&
    existingCursor >= 0 &&
    existingCursor <= fileLength
      ? Math.floor(existingCursor)
      : 0;

  const chunk = contentBuffer.toString("utf8", safeCursor);
  const lines = chunk.split(/\r?\n/);
  let unprocessedTail = "";
  if (chunk.length > 0 && !chunk.endsWith("\n") && !chunk.endsWith("\r")) {
    unprocessedTail = lines.pop() ?? "";
  }

  return {
    lines,
    nextCursor: fileLength - Buffer.byteLength(unprocessedTail, "utf8"),
    fileLength,
  };
}

export function extractOptionalString(
  source: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

export function normalizeTimestamp(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1_000_000_000_000 ? raw : raw * 1000;
  }

  if (typeof raw === "string" && raw.trim().length > 0) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    }

    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

export function buildPromptPayload(
  prompt: string,
  source: string,
  privacy: PrivacyConfig,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = redactText(prompt, privacy);
  const payload: Record<string, unknown> = {
    source,
    promptLength: redacted.length,
    ...extra,
  };

  if (privacy.capturePrompts) {
    payload.prompt = redacted;
  }

  return payload;
}
