import { z } from "zod";
import { SummarizerConfig } from "../config";
import { SessionSummarySource } from "../storage/db";

const MAX_PROMPT_SAMPLES = 15;
const MAX_PROMPT_CHARS = 700;
const REQUEST_TIMEOUT_MS = 45_000;

const IntentSchema = z
  .enum(["coding", "incident", "deploy", "sql", "docs", "other"])
  .catch("other");

const SummaryOutputSchema = z.object({
  summary: z.string(),
  keyOutcomes: z.array(z.string()).default([]),
  filesTouched: z.array(z.string()).default([]),
  commands: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
  todoItems: z.array(z.string()).default([]),
  primaryIntent: IntentSchema.default("other"),
  intentConfidence: z.number().min(0).max(1).default(0.5),
  tasks: z
    .array(
      z.object({
        name: z.string(),
        minutes: z.number().min(0),
        confidence: z.number().min(0).max(1).default(0.6),
      }),
    )
    .default([]),
});

export interface GeneratedSummary {
  summaryMarkdown: string;
  keyOutcomes: string[];
  filesTouched: string[];
  commands: string[];
  errors: string[];
  todoItems: string[];
  primaryIntent: string;
  intentConfidence: number;
  tasks: Array<{
    name: string;
    minutes: number;
    confidence: number;
  }>;
}

function normalizeBaseUrl(provider: SummarizerConfig["provider"], baseUrl?: string): string {
  if (baseUrl && baseUrl.trim().length > 0) {
    return baseUrl.replace(/\/+$/, "");
  }

  if (provider === "ollama") {
    return "http://127.0.0.1:11434";
  }
  if (provider === "openai") {
    return "https://api.openai.com/v1";
  }
  return "https://api.anthropic.com";
}

function trimList(values: string[], maxItems = 50): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    out.push(normalized);
    if (out.length >= maxItems) {
      break;
    }
  }

  return out;
}

function parseIsoDate(input: string | null): number | null {
  if (!input) {
    return null;
  }
  const value = Date.parse(input);
  if (Number.isNaN(value)) {
    return null;
  }
  return value;
}

function getSessionDurationMinutes(source: SessionSummarySource): number {
  const start = parseIsoDate(source.session.startedAt);
  if (!start) {
    return 0;
  }

  const explicitEnd = parseIsoDate(source.session.endedAt);
  if (explicitEnd && explicitEnd > start) {
    return Math.round((explicitEnd - start) / 60000);
  }

  const lastEvent = source.events[source.events.length - 1];
  const fallbackEnd = lastEvent ? parseIsoDate(lastEvent.timestamp) : null;
  if (fallbackEnd && fallbackEnd > start) {
    return Math.round((fallbackEnd - start) / 60000);
  }

  return 0;
}

function buildPrompt(source: SessionSummarySource): string {
  const toolCounts = new Map<string, number>();
  for (const toolCall of source.toolCalls) {
    toolCounts.set(toolCall.toolName, (toolCounts.get(toolCall.toolName) ?? 0) + 1);
  }

  const promptSamples: string[] = [];
  for (const event of source.events) {
    const prompt = event.payload?.prompt;
    if (typeof prompt === "string" && prompt.trim().length > 0) {
      promptSamples.push(prompt.trim().slice(0, MAX_PROMPT_CHARS));
      if (promptSamples.length >= MAX_PROMPT_SAMPLES) {
        break;
      }
    }
  }

  const eventTypes = new Map<string, number>();
  for (const event of source.events) {
    eventTypes.set(event.eventType, (eventTypes.get(event.eventType) ?? 0) + 1);
  }

  const toolSummary = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `- ${name}: ${count}`)
    .join("\n");

  const eventSummary = [...eventTypes.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([eventType, count]) => `- ${eventType}: ${count}`)
    .join("\n");

  const promptSummary =
    promptSamples.length === 0
      ? "- No prompt text captured (prompt capture likely disabled)."
      : promptSamples.map((sample, idx) => `- [${idx + 1}] ${sample}`).join("\n");

  const durationMinutes = getSessionDurationMinutes(source);

  return [
    "You are analyzing a local coding-assistant session log.",
    "",
    "Return JSON only with this shape:",
    "{",
    '  "summary": "string",',
    '  "keyOutcomes": ["string"],',
    '  "filesTouched": ["string"],',
    '  "commands": ["string"],',
    '  "errors": ["string"],',
    '  "todoItems": ["string"],',
    '  "primaryIntent": "coding|incident|deploy|sql|docs|other",',
    '  "intentConfidence": 0.0,',
    '  "tasks": [{"name":"string","minutes":0,"confidence":0.0}]',
    "}",
    "",
    "Rules:",
    "- Infer intent from prompts + tools + session metadata.",
    "- `tasks` should estimate where time went (minutes) and sum close to session duration.",
    "- Keep `filesTouched` to likely file paths only.",
    "- Keep outputs concise and factual.",
    "",
    "Session metadata:",
    `- Session ID: ${source.session.id}`,
    `- Provider: ${source.session.provider}`,
    `- Agent: ${source.session.agent}`,
    `- Repo Path: ${source.session.repoPath ?? "unknown"}`,
    `- Branch: ${source.session.branch ?? "unknown"}`,
    `- Session Duration Minutes: ${durationMinutes}`,
    `- Event Count: ${source.events.length}`,
    `- Tool Call Count: ${source.toolCalls.length}`,
    "",
    "Tool usage:",
    toolSummary.length > 0 ? toolSummary : "- none",
    "",
    "Event types:",
    eventSummary.length > 0 ? eventSummary : "- none",
    "",
    "Captured prompt samples:",
    promptSummary,
  ].join("\n");
}

function extractJsonString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

async function callWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function requireApiKey(config: SummarizerConfig): string {
  if (config.apiKey && config.apiKey.trim().length > 0) {
    return config.apiKey.trim();
  }

  if (config.provider === "openai") {
    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0) {
      return process.env.OPENAI_API_KEY.trim();
    }
    throw new Error("OpenAI API key missing. Set OPENAI_API_KEY or configure --api-key.");
  }

  if (config.provider === "anthropic") {
    if (
      process.env.ANTHROPIC_API_KEY &&
      process.env.ANTHROPIC_API_KEY.trim().length > 0
    ) {
      return process.env.ANTHROPIC_API_KEY.trim();
    }
    throw new Error(
      "Anthropic API key missing. Set ANTHROPIC_API_KEY or configure --api-key.",
    );
  }

  return "";
}

async function summarizeWithOpenAI(
  config: SummarizerConfig,
  prompt: string,
): Promise<string> {
  const baseUrl = normalizeBaseUrl(config.provider, config.baseUrl);
  const apiKey = requireApiKey(config);
  const response = await callWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You summarize coding sessions and must return strict JSON only.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  return text;
}

async function summarizeWithAnthropic(
  config: SummarizerConfig,
  prompt: string,
): Promise<string> {
  const baseUrl = normalizeBaseUrl(config.provider, config.baseUrl);
  const apiKey = requireApiKey(config);
  const response = await callWithTimeout(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 1600,
      temperature: 0.1,
      system: "You summarize coding sessions and must return strict JSON only.",
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic request failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };
  const text =
    data.content?.find((item) => item.type === "text")?.text ?? "";
  return text;
}

async function summarizeWithOllama(
  config: SummarizerConfig,
  prompt: string,
): Promise<string> {
  const baseUrl = normalizeBaseUrl(config.provider, config.baseUrl);
  const response = await callWithTimeout(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      prompt,
      stream: false,
      format: "json",
      options: {
        temperature: 0.1,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama request failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as { response?: string };
  return data.response ?? "";
}

function buildFallbackSummary(source: SessionSummarySource): GeneratedSummary {
  const durationMinutes = getSessionDurationMinutes(source);
  const outcome = `Session ${source.session.id} contains ${source.events.length} events and ${source.toolCalls.length} tool calls.`;
  const summaryMarkdown = [
    "## Session Summary",
    "",
    outcome,
    "",
    "No model-generated summary was available, so this capsule was created from metadata only.",
  ].join("\n");

  return {
    summaryMarkdown,
    keyOutcomes: [outcome],
    filesTouched: [],
    commands: [],
    errors: [],
    todoItems: [],
    primaryIntent: "other",
    intentConfidence: 0.3,
    tasks:
      durationMinutes > 0
        ? [{ name: "general", minutes: durationMinutes, confidence: 0.3 }]
        : [],
  };
}

export async function generateSessionSummary(
  source: SessionSummarySource,
  config: SummarizerConfig,
): Promise<GeneratedSummary> {
  const prompt = buildPrompt(source);

  let rawText = "";
  if (config.provider === "openai") {
    rawText = await summarizeWithOpenAI(config, prompt);
  } else if (config.provider === "anthropic") {
    rawText = await summarizeWithAnthropic(config, prompt);
  } else {
    rawText = await summarizeWithOllama(config, prompt);
  }

  const jsonText = extractJsonString(rawText);
  let parsed:
    | z.infer<typeof SummaryOutputSchema>
    | null = null;

  try {
    const json = JSON.parse(jsonText) as unknown;
    parsed = SummaryOutputSchema.parse(json);
  } catch {
    return buildFallbackSummary(source);
  }

  const durationMinutes = getSessionDurationMinutes(source);
  const tasks = parsed.tasks
    .map((task) => ({
      name: task.name.trim(),
      minutes: Math.max(0, Math.round(task.minutes)),
      confidence: task.confidence,
    }))
    .filter((task) => task.name.length > 0);

  const normalizedTasks =
    tasks.length > 0
      ? tasks
      : durationMinutes > 0
        ? [
            {
              name: parsed.primaryIntent,
              minutes: durationMinutes,
              confidence: parsed.intentConfidence,
            },
          ]
        : [];

  const keyOutcomes = trimList(parsed.keyOutcomes, 20);
  const filesTouched = trimList(parsed.filesTouched, 200);
  const commands = trimList(parsed.commands, 200);
  const errors = trimList(parsed.errors, 200);
  const todos = trimList(parsed.todoItems, 200);

  const summaryMarkdown = [
    "## Session Summary",
    "",
    parsed.summary.trim(),
    "",
    "## Key Outcomes",
    ...(keyOutcomes.length > 0 ? keyOutcomes.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Primary Intent",
    `- ${parsed.primaryIntent} (${parsed.intentConfidence.toFixed(2)})`,
  ].join("\n");

  return {
    summaryMarkdown,
    keyOutcomes,
    filesTouched,
    commands,
    errors,
    todoItems: todos,
    primaryIntent: parsed.primaryIntent,
    intentConfidence: parsed.intentConfidence,
    tasks: normalizedTasks,
  };
}
