import { z } from "zod";
import { SummarizerConfig } from "../config";
import { SessionSummarySource } from "../storage/db";

const MAX_PROMPT_SAMPLES = 15;
const MAX_PROMPT_CHARS = 700;
const MAX_ACTIVITY_ITEMS = 80;
const MAX_HANDOFF_ITEMS = 40;
const MAX_SESSION_FACTS = 20;
const MAX_PROMPT_TRACE_EVENTS = 80;
const REQUEST_TIMEOUT_MS = 45_000;

const IntentSchema = z
  .enum([
    "coding",
    "coding/frontend",
    "coding/frontend/design",
    "research",
    "research/tech-qna",
    "incident",
    "deploy",
    "sql",
    "docs",
    "other",
  ])
  .catch("other");

const SummaryOutputSchema = z.object({
  summary: z.string().default(""),
  keyOutcomes: z.array(z.string()).default([]),
  filesTouched: z.array(z.string()).default([]),
  commands: z.array(z.string()).default([]),
  errors: z.array(z.string()).default([]),
  todoItems: z.array(z.string()).default([]),
  activity: z.array(z.string()).default([]),
  handoffNotes: z.array(z.string()).default([]),
  sessionFacts: z.array(z.string()).default([]),
  primaryIntent: IntentSchema.default("other"),
  intentConfidence: z.coerce.number().min(0).max(1).default(0.5),
  tasks: z
    .array(
      z.object({
        name: z.string(),
        minutes: z.coerce.number().min(0),
        confidence: z.coerce.number().min(0).max(1).default(0.6),
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
  activity: string[];
  handoffNotes: string[];
  sessionFacts: string[];
  primaryIntent: string;
  intentConfidence: number;
  tasks: Array<{
    name: string;
    minutes: number;
    confidence: number;
  }>;
}

export interface GenerateSummaryOptions {
  includePromptSamples?: boolean;
}

function collectPromptSamples(source: SessionSummarySource, maxSamples = MAX_PROMPT_SAMPLES): string[] {
  const promptSamples: string[] = [];
  for (const event of source.events) {
    const prompt = event.payload?.prompt;
    if (typeof prompt === "string" && prompt.trim().length > 0) {
      promptSamples.push(prompt.trim().slice(0, MAX_PROMPT_CHARS));
      if (promptSamples.length >= maxSamples) {
        break;
      }
    }
  }
  return promptSamples;
}

function inferIntentFromSignals(source: SessionSummarySource): {
  intent: z.infer<typeof IntentSchema>;
  confidence: number;
} {
  const promptText = collectPromptSamples(source, 12).join("\n").toLowerCase();
  const toolNames = source.toolCalls.map((call) => call.toolName.toLowerCase());
  const eventTypes = source.events.map((event) => event.eventType.toLowerCase());
  const combinedSignals = `${promptText}\n${toolNames.join(" ")}\n${eventTypes.join(" ")}`;

  const hasAny = (patterns: RegExp[]): boolean =>
    patterns.some((pattern) => pattern.test(combinedSignals));

  if (
    hasAny([
      /\bsql\b/,
      /\bselect\b/,
      /\bjoin\b/,
      /\bsql query\b/,
      /\bpostgres(?:ql)?\b/,
      /\bmysql\b/,
      /\bsqlite\b/,
    ])
  ) {
    return { intent: "sql", confidence: 0.72 };
  }

  if (
    hasAny([
      /\bdeploy\b/,
      /\brelease\b/,
      /\bkubernetes\b/,
      /\bk8s\b/,
      /\bhelm\b/,
      /\brollout\b/,
    ])
  ) {
    return { intent: "deploy", confidence: 0.72 };
  }

  if (
    hasAny([
      /\bincident\b/,
      /\boutage\b/,
      /\balert\b/,
      /\bpager\b/,
      /\bsev[0-9]+\b/,
      /\bon[-\s]?call\b/,
      /\bbreak(ing|age)?\b/,
    ])
  ) {
    return { intent: "incident", confidence: 0.74 };
  }

  if (
    hasAny([
      /\bui\b/,
      /\bux\b/,
      /\buser interface\b/,
      /\bvisual design\b/,
      /\bredesign\b/,
      /\blayout\b/,
      /\btypography\b/,
      /\bcolor (palette|scheme|system)\b/,
      /\bspacing\b/,
      /\bwireframe\b/,
      /\bmockup\b/,
      /\bfigma\b/,
      /\bhero section\b/,
      /\blanding page\b/,
      /\btheme\b/,
      /\bdesign system\b/,
    ])
  ) {
    return { intent: "coding/frontend/design", confidence: 0.79 };
  }

  if (
    hasAny([
      /\bfrontend\b/,
      /\bfront-end\b/,
      /\breact\b/,
      /\bnext\.?js\b/,
      /\bvue\b/,
      /\bsvelte\b/,
      /\bcomponent\b/,
      /\bcss\b/,
      /\bscss\b/,
      /\btailwind\b/,
      /\bhtml\b/,
      /\bdom\b/,
      /\bresponsive\b/,
      /\banimation\b/,
      /\baccessibility\b/,
    ])
  ) {
    return { intent: "coding/frontend", confidence: 0.73 };
  }

  if (
    source.toolCalls.length === 0 &&
    (
      /\?/.test(promptText) ||
      hasAny([
        /\bwhat is\b/,
        /\bhow does\b/,
        /\bwhy does\b/,
        /\bwhen should\b/,
        /\bdifference between\b/,
        /\bcompare\b/,
        /\bvs\.?\b/,
        /\btrade[-\s]?offs?\b/,
        /\bpros and cons\b/,
        /\bbest practices?\b/,
        /\bexplain\b/,
        /\bclarify\b/,
        /\bwalk me through\b/,
      ])
    )
  ) {
    return { intent: "research/tech-qna", confidence: 0.76 };
  }

  if (
    source.toolCalls.length === 0 &&
    hasAny([
      /\bresearch\b/,
      /\binvestigate\b/,
      /\bexplore\b/,
      /\bevaluate\b/,
      /\bfeasibilit(y|ies)\b/,
      /\bdiscovery\b/,
      /\bspike\b/,
      /\boptions?\b/,
      /\brfc\b/,
      /\barchitecture\b/,
    ])
  ) {
    return { intent: "research", confidence: 0.69 };
  }

  if (
    hasAny([
      /\bdocumentation\b/,
      /\bdocs?\b/,
      /\breadme\b/,
      /\badr\b/,
      /\bwriteup\b/,
    ])
  ) {
    return { intent: "docs", confidence: 0.68 };
  }

  const codingSignal =
    source.toolCalls.length > 0 ||
    hasAny([
      /\bfix\b/,
      /\brefactor\b/,
      /\bimplement\b/,
      /\bbuild\b/,
      /\btest\b/,
      /\bdebug\b/,
      /\bbug\b/,
      /\bcode\b/,
      /\bfunction\b/,
      /\bclass\b/,
    ]) ||
    eventTypes.some(
      (value) =>
        value.includes("tool_") ||
        value === "request_sent" ||
        value === "session_started",
    );

  if (codingSignal) {
    return { intent: "coding", confidence: 0.66 };
  }

  return { intent: "other", confidence: 0.35 };
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

function truncateInline(input: string, maxChars = 180): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(24, maxChars - 3)).trimEnd()}...`;
}

function toIsoOrFallback(input: string): string {
  const parsed = Date.parse(input);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  return input;
}

function describeToolCall(
  toolName: string,
  success: boolean,
  durationMs: number | null,
  metadata?: Record<string, unknown> | null,
): string {
  const parts = [`${toolName} ${success ? "succeeded" : "failed"}`];
  if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0) {
    parts.push(`in ${Math.round(durationMs)}ms`);
  }
  const exitCode =
    typeof metadata?.exitCode === "number" && Number.isFinite(metadata.exitCode)
      ? metadata.exitCode
      : undefined;
  if (exitCode !== undefined) {
    parts.push(`(exit ${exitCode})`);
  }
  return parts.join(" ");
}

function buildToolDetailLines(source: SessionSummarySource, maxItems = 120): string[] {
  return source.toolCalls
    .slice(0, maxItems)
    .map((toolCall) => {
      const when = toIsoOrFallback(toolCall.finishedAt ?? toolCall.startedAt);
      const detail = describeToolCall(
        toolCall.toolName,
        toolCall.success,
        toolCall.durationMs,
        toolCall.metadata,
      );
      return `- ${when} ${detail}`;
    });
}

function buildEventTraceLines(
  source: SessionSummarySource,
  options?: { includePromptText?: boolean; maxItems?: number },
): string[] {
  const includePromptText = options?.includePromptText ?? true;
  const maxItems = options?.maxItems ?? MAX_PROMPT_TRACE_EVENTS;
  const out: string[] = [];

  for (const event of source.events) {
    const ts = toIsoOrFallback(event.timestamp);
    if (event.eventType === "request_sent") {
      const prompt = typeof event.payload?.prompt === "string" ? event.payload.prompt : "";
      if (includePromptText && prompt.trim().length > 0) {
        out.push(`- ${ts} request: ${truncateInline(prompt, 220)}`);
      } else {
        out.push(`- ${ts} request sent`);
      }
    } else if (event.eventType === "tool_pre_use") {
      const toolName =
        typeof event.payload?.toolName === "string"
          ? event.payload.toolName
          : "unknown_tool";
      out.push(`- ${ts} tool start: ${toolName}`);
    } else if (event.eventType === "tool_post_use") {
      const toolName =
        typeof event.payload?.toolName === "string"
          ? event.payload.toolName
          : "unknown_tool";
      out.push(`- ${ts} tool finish: ${toolName}`);
    } else if (event.eventType.startsWith("session_")) {
      out.push(`- ${ts} ${event.eventType}`);
    } else if (
      event.eventType === "notification" ||
      event.eventType === "pre_compact" ||
      event.eventType === "subagent_stopped"
    ) {
      out.push(`- ${ts} ${event.eventType}`);
    }

    if (out.length >= maxItems) {
      break;
    }
  }

  return trimList(out, maxItems);
}

function buildDerivedSessionFacts(
  source: SessionSummarySource,
  durationMinutes: number,
): string[] {
  const facts: string[] = [];
  const succeededTools = source.toolCalls.filter((call) => call.success).length;
  const failedTools = source.toolCalls.length - succeededTools;
  const topTools = [...source.toolCalls]
    .reduce((map, call) => {
      map.set(call.toolName, (map.get(call.toolName) ?? 0) + 1);
      return map;
    }, new Map<string, number>());
  const topToolSummary = [...topTools.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name} (${count})`)
    .join(", ");

  facts.push(`Session ID: ${source.session.id}`);
  facts.push(`Agent: ${source.session.agent} (${source.session.provider})`);
  facts.push(`Repo: ${source.session.repoPath ?? "unknown"}`);
  facts.push(`Branch: ${source.session.branch ?? "unknown"}`);
  facts.push(
    `Lifecycle: ${source.session.status}; duration ${durationMinutes} min; events ${source.events.length}; tool calls ${source.toolCalls.length}.`,
  );
  if (source.toolCalls.length > 0) {
    facts.push(`Tool outcomes: ${succeededTools} succeeded, ${failedTools} failed.`);
  }
  if (topToolSummary.length > 0) {
    facts.push(`Top tools: ${topToolSummary}`);
  }
  return trimList(facts, MAX_SESSION_FACTS);
}

function buildDerivedActivity(source: SessionSummarySource): string[] {
  const items: Array<{ timestamp: string; line: string }> = [];

  for (const eventLine of buildEventTraceLines(source, { includePromptText: true, maxItems: 120 })) {
    const match = eventLine.match(/^- (\S+) (.*)$/);
    if (!match) {
      continue;
    }
    items.push({
      timestamp: match[1],
      line: match[2],
    });
  }

  for (const toolCall of source.toolCalls) {
    const timestamp = toIsoOrFallback(toolCall.finishedAt ?? toolCall.startedAt);
    items.push({
      timestamp,
      line: describeToolCall(
        toolCall.toolName,
        toolCall.success,
        toolCall.durationMs,
        toolCall.metadata,
      ),
    });
  }

  items.sort((a, b) => {
    const left = Date.parse(a.timestamp);
    const right = Date.parse(b.timestamp);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      return left - right;
    }
    return a.timestamp.localeCompare(b.timestamp);
  });

  return trimList(
    items.map((item) => `${item.timestamp} ${item.line}`),
    MAX_ACTIVITY_ITEMS,
  );
}

function buildDerivedHandoffNotes(
  source: SessionSummarySource,
  todos: string[],
  errors: string[],
): string[] {
  const notes: string[] = [];
  const promptSamples = collectPromptSamples(source, MAX_PROMPT_SAMPLES);
  const lastPrompt = promptSamples.length > 0 ? promptSamples[promptSamples.length - 1] : null;
  const failedToolNames = trimList(
    source.toolCalls
      .filter((call) => !call.success)
      .map((call) => call.toolName),
    8,
  );

  if (source.session.branch) {
    notes.push(`Continue work on branch ${source.session.branch}.`);
  }
  if (source.session.repoPath) {
    notes.push(`Workspace path: ${source.session.repoPath}.`);
  }
  if (lastPrompt && lastPrompt.length > 0) {
    notes.push(`Latest user request: ${truncateInline(lastPrompt, 200)}`);
  }
  for (const todo of todos.slice(0, 8)) {
    notes.push(`Follow-up: ${todo}`);
  }
  for (const error of errors.slice(0, 6)) {
    notes.push(`Watch-out: ${error}`);
  }
  if (failedToolNames.length > 0) {
    notes.push(`Review failed tools: ${failedToolNames.join(", ")}.`);
  }

  return trimList(notes, MAX_HANDOFF_ITEMS);
}

function buildPrompt(
  source: SessionSummarySource,
  options?: GenerateSummaryOptions,
): string {
  const includePromptSamples = options?.includePromptSamples ?? true;
  const toolCounts = new Map<string, number>();
  for (const toolCall of source.toolCalls) {
    toolCounts.set(toolCall.toolName, (toolCounts.get(toolCall.toolName) ?? 0) + 1);
  }

  const promptSamples: string[] = [];
  if (includePromptSamples) {
    promptSamples.push(...collectPromptSamples(source));
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
  const eventTrace = buildEventTraceLines(source, {
    includePromptText: includePromptSamples,
  });
  const toolDetails = buildToolDetailLines(source);
  const derivedSessionFacts = buildDerivedSessionFacts(source, durationMinutes);

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
    '  "activity": ["string"],',
    '  "handoffNotes": ["string"],',
    '  "sessionFacts": ["string"],',
    '  "primaryIntent": "coding|coding/frontend|coding/frontend/design|research|research/tech-qna|incident|deploy|sql|docs|other",',
    '  "intentConfidence": 0.0,',
    '  "tasks": [{"name":"string","minutes":0,"confidence":0.0}]',
    "}",
    "",
    "Rules:",
    "- Infer intent from prompts + tools + session metadata.",
    "- Use the most specific intent available when evidence supports it.",
    "- For UI/UX/visual/layout work, use `coding/frontend/design` rather than plain `coding`.",
    "- For exploratory technical questions or concept comparisons without execution, use `research/tech-qna`.",
    "- Prefer `coding/frontend/design`, `coding/frontend`, `coding`, `research/tech-qna`, `research`, `incident`, `deploy`, `sql`, or `docs` when there is evidence; use `other` only when evidence is sparse.",
    "- `tasks` should estimate where time went (minutes) and sum close to session duration.",
    "- Keep `filesTouched` to likely file paths only.",
    "- `activity` should describe concrete actions taken by the agent, in chronological order when possible.",
    "- `handoffNotes` should be next-session guidance for another coding agent (open work, caveats, blockers).",
    "- `sessionFacts` should be durable factual context (repo/branch/status/tool outcomes).",
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
    "Chronological trace:",
    eventTrace.length > 0 ? eventTrace.join("\n") : "- none",
    "",
    "Tool call details:",
    toolDetails.length > 0 ? toolDetails.join("\n") : "- none",
    "",
    "Derived factual hints:",
    derivedSessionFacts.length > 0
      ? derivedSessionFacts.map((item) => `- ${item}`).join("\n")
      : "- none",
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

  const data = (await response.json()) as { response?: string; thinking?: string };
  const responseText = typeof data.response === "string" ? data.response.trim() : "";
  if (responseText.length > 0) {
    return responseText;
  }

  const thinkingText = typeof data.thinking === "string" ? data.thinking.trim() : "";
  return thinkingText;
}

function buildFallbackSummary(source: SessionSummarySource): GeneratedSummary {
  const durationMinutes = getSessionDurationMinutes(source);
  const inferredIntent = inferIntentFromSignals(source);
  const outcome = `Session ${source.session.id} contains ${source.events.length} events and ${source.toolCalls.length} tool calls.`;
  const activity = buildDerivedActivity(source);
  const sessionFacts = buildDerivedSessionFacts(source, durationMinutes);
  const handoffNotes = buildDerivedHandoffNotes(source, [], []);
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
    activity,
    handoffNotes,
    sessionFacts,
    primaryIntent: inferredIntent.intent,
    intentConfidence: inferredIntent.confidence,
    tasks:
      durationMinutes > 0
        ? [{ name: inferredIntent.intent, minutes: durationMinutes, confidence: inferredIntent.confidence }]
        : [],
  };
}

export async function generateSessionSummary(
  source: SessionSummarySource,
  config: SummarizerConfig,
  options?: GenerateSummaryOptions,
): Promise<GeneratedSummary> {
  const prompt = buildPrompt(source, options);

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

  const inferredIntent = inferIntentFromSignals(source);
  const intentSpecificity = (value: string): number =>
    value.split("/").filter((part) => part.length > 0).length;
  const shouldOverrideOtherIntent =
    parsed.primaryIntent === "other" &&
    inferredIntent.intent !== "other" &&
    parsed.intentConfidence <= inferredIntent.confidence;
  const shouldOverrideGenericCoding =
    parsed.primaryIntent.startsWith("coding") &&
    inferredIntent.intent.startsWith("coding") &&
    parsed.primaryIntent !== inferredIntent.intent &&
    intentSpecificity(inferredIntent.intent) > intentSpecificity(parsed.primaryIntent) &&
    inferredIntent.confidence >= 0.72;
  const shouldOverrideCodingToResearch =
    parsed.primaryIntent === "coding" &&
    inferredIntent.intent.startsWith("research") &&
    source.toolCalls.length === 0 &&
    inferredIntent.confidence >= 0.7;
  const primaryIntent = shouldOverrideOtherIntent
    ? inferredIntent.intent
    : shouldOverrideGenericCoding
      ? inferredIntent.intent
      : shouldOverrideCodingToResearch
        ? inferredIntent.intent
      : parsed.primaryIntent;
  const intentConfidence = shouldOverrideOtherIntent
    ? inferredIntent.confidence
    : shouldOverrideGenericCoding
      ? inferredIntent.confidence
      : shouldOverrideCodingToResearch
        ? inferredIntent.confidence
      : parsed.intentConfidence;

  const keyOutcomes = trimList(parsed.keyOutcomes, 20);
  const filesTouched = trimList(parsed.filesTouched, 200);
  const commands = trimList(parsed.commands, 200);
  const errors = trimList(parsed.errors, 200);
  const todos = trimList(parsed.todoItems, 200);
  const derivedActivity = buildDerivedActivity(source);
  const derivedSessionFacts = buildDerivedSessionFacts(source, durationMinutes);
  const derivedHandoffNotes = buildDerivedHandoffNotes(source, todos, errors);
  const activity = trimList(
    [...parsed.activity, ...derivedActivity],
    MAX_ACTIVITY_ITEMS,
  );
  const handoffNotes = trimList(
    [...parsed.handoffNotes, ...derivedHandoffNotes],
    MAX_HANDOFF_ITEMS,
  );
  const sessionFacts = trimList(
    [...parsed.sessionFacts, ...derivedSessionFacts],
    MAX_SESSION_FACTS,
  );

  const summaryMarkdown = [
    "## Session Summary",
    "",
    parsed.summary.trim().length > 0
      ? parsed.summary.trim()
      : `Session ${source.session.id} processed successfully.`,
    "",
    "## Key Outcomes",
    ...(keyOutcomes.length > 0 ? keyOutcomes.map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Activity",
    ...(activity.length > 0 ? activity.slice(0, 20).map((item) => `- ${item}`) : ["- none"]),
    "",
    "## Handoff Notes",
    ...(handoffNotes.length > 0
      ? handoffNotes.slice(0, 12).map((item) => `- ${item}`)
      : ["- none"]),
    "",
    "## Primary Intent",
    `- ${primaryIntent} (${intentConfidence.toFixed(2)})`,
  ].join("\n");

  return {
    summaryMarkdown,
    keyOutcomes,
    filesTouched,
    commands,
    errors,
    todoItems: todos,
    activity,
    handoffNotes,
    sessionFacts,
    primaryIntent,
    intentConfidence,
    tasks: normalizedTasks,
  };
}
