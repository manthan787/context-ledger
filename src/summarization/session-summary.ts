import { loadAppConfig } from "../config";
import {
  getSessionSummaryFreshness,
  loadSessionSummarySource,
  replaceIntentLabelsForSession,
  replaceTaskBreakdownForSession,
  saveSessionCapsule,
} from "../storage/db";
import { generateSessionSummary } from "./summarizer";

export interface SummarizeSessionOptions {
  sessionRef: string;
  dataDir?: string;
  source?: string;
  skipIfFresh?: boolean;
}

export interface SummarizeSessionResult {
  status: "stored" | "skipped" | "failed";
  sessionId?: string;
  reason?: string;
  error?: string;
  primaryIntent?: string;
  taskBuckets?: number;
  outcomes?: number;
}

function toMillis(input: string | null): number | null {
  if (!input) {
    return null;
  }
  const value = Date.parse(input);
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
}

function isFreshEnough(freshness: {
  latestEventTimestamp: string | null;
  capsuleUpdatedAt: string | null;
}): boolean {
  const latestEvent = toMillis(freshness.latestEventTimestamp);
  const capsuleUpdated = toMillis(freshness.capsuleUpdatedAt);
  if (latestEvent === null || capsuleUpdated === null) {
    return false;
  }
  return capsuleUpdated >= latestEvent;
}

export async function summarizeSessionByRef(
  options: SummarizeSessionOptions,
): Promise<SummarizeSessionResult> {
  const config = loadAppConfig(options.dataDir);
  const summarizer = config.summarizer;
  if (!summarizer) {
    return {
      status: "skipped",
      reason: "summarizer_not_configured",
    };
  }

  const sourceData = loadSessionSummarySource(options.sessionRef, options.dataDir);
  if (!sourceData) {
    return {
      status: "skipped",
      reason: "session_not_found",
    };
  }

  const sessionId = sourceData.session.id;
  if (options.skipIfFresh ?? true) {
    const freshness = getSessionSummaryFreshness(sessionId, options.dataDir);
    if (isFreshEnough(freshness)) {
      return {
        status: "skipped",
        sessionId,
        reason: "already_up_to_date",
      };
    }
  }

  const promptCount = sourceData.events.filter(
    (event) => typeof event.payload?.prompt === "string",
  ).length;
  const usesRemoteProvider =
    summarizer.provider === "openai" || summarizer.provider === "anthropic";
  const includePromptSamples =
    !usesRemoteProvider || config.privacy.allowRemotePromptTransfer;

  try {
    const summary = await generateSessionSummary(sourceData, summarizer, {
      includePromptSamples,
    });

    saveSessionCapsule(
      {
        sessionId,
        summaryMarkdown: summary.summaryMarkdown,
        decisions: summary.keyOutcomes,
        todos: summary.todoItems,
        files: summary.filesTouched,
        commands: summary.commands,
        errors: summary.errors,
        activity: summary.activity,
        handoffNotes: summary.handoffNotes,
        sessionFacts: summary.sessionFacts,
      },
      options.dataDir,
    );

    const labelSource = options.source ?? "summarizer";
    replaceIntentLabelsForSession(
      sessionId,
      labelSource,
      [
        {
          label: summary.primaryIntent,
          confidence: summary.intentConfidence,
          source: labelSource,
          reason: {
            model: summarizer.model,
            provider: summarizer.provider,
            promptSamplesIncluded: includePromptSamples,
            promptCount,
          },
        },
      ],
      options.dataDir,
    );

    replaceTaskBreakdownForSession(
      sessionId,
      labelSource,
      summary.tasks.map((task) => ({
        taskLabel: task.name,
        durationMinutes: task.minutes,
        confidence: task.confidence,
        source: labelSource,
      })),
      options.dataDir,
    );

    return {
      status: "stored",
      sessionId,
      primaryIntent: summary.primaryIntent,
      taskBuckets: summary.tasks.length,
      outcomes: summary.keyOutcomes.length,
    };
  } catch (error) {
    return {
      status: "failed",
      sessionId,
      reason: "summarization_error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
