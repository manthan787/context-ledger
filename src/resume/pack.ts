import { ResumeSessionContext } from "../storage/analytics";

export interface ResumeBuildOptions {
  title?: string;
  tokenBudget: number;
}

export interface ResumePackResult {
  title: string;
  markdown: string;
  estimatedTokens: number;
  sourceSessionIds: string[];
  sessionCount: number;
  sections: {
    outcomes: number;
    todos: number;
    files: number;
    commands: number;
    errors: number;
    promptSamples: number;
  };
}

interface RenderLimits {
  sessionCount: number;
  outcomesPerSession: number;
  todosPerSession: number;
  filesPerSession: number;
  commandsPerSession: number;
  errorsPerSession: number;
  promptsPerSession: number;
  summaryChars: number;
}

function dedupeTrimmed(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function getDefaultTitle(contexts: ResumeSessionContext[]): string {
  if (contexts.length === 0) {
    return "Resume Pack";
  }

  if (contexts.length === 1) {
    return `Resume ${contexts[0].session.id}`;
  }

  const first = contexts[0].session.startedAt.slice(0, 10);
  const last = contexts[contexts.length - 1].session.startedAt.slice(0, 10);
  return `Resume ${first} to ${last}`;
}

function renderSessionSection(
  context: ResumeSessionContext,
  limits: RenderLimits,
): string[] {
  const lines: string[] = [];
  const session = context.session;
  const capsule = context.capsule;

  lines.push(`### Session ${session.id}`);
  lines.push(
    `- Agent: ${session.agent} (${session.provider}) | Duration: ${session.durationMinutes.toFixed(1)} min | Started: ${session.startedAt}`,
  );
  if (session.intentLabel) {
    lines.push(
      `- Intent: ${session.intentLabel}${
        session.intentConfidence !== null
          ? ` (${session.intentConfidence.toFixed(2)})`
          : ""
      }`,
    );
  }

  if (capsule?.summaryMarkdown) {
    const summary = capsule.summaryMarkdown
      .replace(/^## Session Summary\s*/i, "")
      .replace(/\n+/g, " ")
      .trim()
      .slice(0, limits.summaryChars);
    if (summary.length > 0) {
      lines.push(`- Summary: ${summary}`);
    }
  }

  const outcomes = dedupeTrimmed(capsule?.decisions ?? []).slice(
    0,
    limits.outcomesPerSession,
  );
  const todos = dedupeTrimmed(capsule?.todos ?? []).slice(0, limits.todosPerSession);
  const files = dedupeTrimmed(capsule?.files ?? []).slice(0, limits.filesPerSession);
  const commands = dedupeTrimmed(capsule?.commands ?? []).slice(
    0,
    limits.commandsPerSession,
  );
  const errors = dedupeTrimmed(capsule?.errors ?? []).slice(0, limits.errorsPerSession);
  const prompts = dedupeTrimmed(context.prompts).slice(0, limits.promptsPerSession);

  if (outcomes.length > 0) {
    lines.push("- Key Outcomes:");
    for (const item of outcomes) {
      lines.push(`  - ${item}`);
    }
  }

  if (todos.length > 0) {
    lines.push("- Open TODOs:");
    for (const item of todos) {
      lines.push(`  - ${item}`);
    }
  }

  if (files.length > 0) {
    lines.push("- Files Touched:");
    for (const item of files) {
      lines.push(`  - ${item}`);
    }
  }

  if (commands.length > 0) {
    lines.push("- Commands Used:");
    for (const item of commands) {
      lines.push(`  - ${item}`);
    }
  }

  if (errors.length > 0) {
    lines.push("- Errors/Fixes:");
    for (const item of errors) {
      lines.push(`  - ${item}`);
    }
  }

  if (prompts.length > 0) {
    lines.push("- Prompt Samples:");
    for (const item of prompts) {
      lines.push(`  - ${item}`);
    }
  }

  if (context.taskBreakdown.length > 0) {
    lines.push("- Task Time Split:");
    for (const task of context.taskBreakdown.slice(0, 5)) {
      lines.push(
        `  - ${task.label}: ${task.minutes.toFixed(1)} min (${task.confidence.toFixed(2)})`,
      );
    }
  }

  lines.push("");
  return lines;
}

function renderResume(
  contexts: ResumeSessionContext[],
  title: string,
  limits: RenderLimits,
): string {
  const selected = contexts.slice(-limits.sessionCount);
  const lines: string[] = [];

  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Sessions Included: ${selected.length}`);
  lines.push("");
  lines.push("## Snapshot");
  lines.push(
    "Use this as seed context for the next coding-agent session. Validate branches/files against current repo state before applying changes.",
  );
  lines.push("");
  lines.push("## Session Context");
  lines.push("");

  for (const context of selected) {
    lines.push(...renderSessionSection(context, limits));
  }

  const carryForwardTodos = dedupeTrimmed(
    selected.flatMap((context) => context.capsule?.todos ?? []),
  ).slice(0, Math.max(5, limits.todosPerSession));
  if (carryForwardTodos.length > 0) {
    lines.push("## Immediate Next Steps");
    for (const todo of carryForwardTodos) {
      lines.push(`- ${todo}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function reduceLimits(limits: RenderLimits): boolean {
  if (limits.promptsPerSession > 0) {
    limits.promptsPerSession -= 1;
    return true;
  }
  if (limits.commandsPerSession > 2) {
    limits.commandsPerSession -= 1;
    return true;
  }
  if (limits.filesPerSession > 2) {
    limits.filesPerSession -= 1;
    return true;
  }
  if (limits.errorsPerSession > 1) {
    limits.errorsPerSession -= 1;
    return true;
  }
  if (limits.outcomesPerSession > 2) {
    limits.outcomesPerSession -= 1;
    return true;
  }
  if (limits.todosPerSession > 2) {
    limits.todosPerSession -= 1;
    return true;
  }
  if (limits.summaryChars > 180) {
    limits.summaryChars -= 40;
    return true;
  }
  if (limits.sessionCount > 1) {
    limits.sessionCount -= 1;
    return true;
  }
  return false;
}

export function buildResumePack(
  contexts: ResumeSessionContext[],
  options: ResumeBuildOptions,
): ResumePackResult {
  const title = options.title?.trim() || getDefaultTitle(contexts);
  const budget = Math.max(256, options.tokenBudget);

  const limits: RenderLimits = {
    sessionCount: Math.max(1, contexts.length),
    outcomesPerSession: 8,
    todosPerSession: 8,
    filesPerSession: 12,
    commandsPerSession: 12,
    errorsPerSession: 6,
    promptsPerSession: 4,
    summaryChars: 500,
  };

  let markdown = renderResume(contexts, title, limits);
  let estimatedTokens = estimateTokens(markdown);

  let guard = 0;
  while (estimatedTokens > budget && guard < 500) {
    const reduced = reduceLimits(limits);
    if (!reduced) {
      break;
    }
    markdown = renderResume(contexts, title, limits);
    estimatedTokens = estimateTokens(markdown);
    guard += 1;
  }

  if (estimatedTokens > budget) {
    const hardCharLimit = budget * 4;
    markdown = `${markdown.slice(0, Math.max(120, hardCharLimit - 24)).trim()}\n\n[truncated for token budget]`;
    estimatedTokens = estimateTokens(markdown);
  }

  return {
    title,
    markdown,
    estimatedTokens,
    sourceSessionIds: contexts
      .slice(-limits.sessionCount)
      .map((context) => context.session.id),
    sessionCount: limits.sessionCount,
    sections: {
      outcomes: limits.outcomesPerSession,
      todos: limits.todosPerSession,
      files: limits.filesPerSession,
      commands: limits.commandsPerSession,
      errors: limits.errorsPerSession,
      promptSamples: limits.promptsPerSession,
    },
  };
}
