import { uuidv7 } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { compact, convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type {
  CompactionResult,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { CompactProfile } from "./config.ts";
import { CompactInputBudgetError } from "./pipeline.ts";

type CompactResponse = Awaited<ReturnType<ExtensionContext["modelRegistry"]["complete"]>>;
type CompactUsage = CompactResponse["usage"];

/** Request passed across the compact-only whole-summary replacement seam. */
export interface CustomSummaryRequest {
  event: SessionBeforeCompactEvent;
  context: ExtensionContext;
  model: NonNullable<ExtensionContext["model"]>;
  profile: CompactProfile;
}

export interface CompactSummaryAdapter {
  summarize(request: CustomSummaryRequest): Promise<CompactionResult>;
}

const SUMMARY_SYSTEM_PROMPT =
  "You are a compaction summarizer. Write a concise, accurate summary of the supplied conversation that lets the assistant continue the user's work. Do not answer the conversation or continue it; output only the summary.";
const TEMPLATE_KEYS = new Set([
  "conversation",
  "previousSummary",
  "turnPrefix",
  "customInstructions",
]);

/**
 * Effective compact-only reasoning level: the profile field wins per-field over the chat
 * session's thinking level. `off` and absent-with-chat-off both mean "send no reasoning field".
 */
function compactReasoningLevel(profile: CompactProfile, context: ExtensionContext): ThinkingLevel | undefined {
  const level = profile.thinkingLevel ?? context.thinkingLevel;
  return level !== undefined && level !== "off" ? level : undefined;
}

function textContent(response: CompactResponse): string {
  return response.content
    .filter((block): block is Extract<(typeof response.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function assertFinalResponse(response: CompactResponse, label: string): string {
  if (response.stopReason !== "stop") throw new Error(`Compact ${label} summary ended with ${response.stopReason}`);
  if (response.content.some((block) => block.type === "toolCall")) {
    throw new Error(`Compact ${label} summary attempted to call a tool`);
  }
  const text = textContent(response);
  if (!text) throw new Error(`Compact ${label} summary was empty`);
  return text;
}

function renderPrompt(
  template: string,
  values: {
    conversation: string;
    previousSummary: string;
    turnPrefix: string;
    customInstructions: string;
  },
): string {
  for (const match of template.matchAll(/\{\{([^{}]+)\}\}/g)) {
    if (!TEMPLATE_KEYS.has(match[1])) throw new Error(`Unsupported compact prompt placeholder {{${match[1]}}}`);
  }
  let rendered = template.replace(/\{\{(conversation|previousSummary|turnPrefix|customInstructions)\}\}/g, (_whole, key: keyof typeof values) => values[key]);
  if (!template.includes("{{conversation}}")) {
    rendered += `\n\n<conversation>\n${values.conversation}\n</conversation>`;
  }
  if (values.previousSummary && !template.includes("{{previousSummary}}")) {
    rendered += `\n\n<previous-summary>\n${values.previousSummary}\n</previous-summary>`;
  }
  if (values.turnPrefix && !template.includes("{{turnPrefix}}")) {
    rendered += `\n\n<split-turn-prefix>\n${values.turnPrefix}\n</split-turn-prefix>`;
  }
  if (values.customInstructions && !template.includes("{{customInstructions}}")) {
    rendered += `\n\n<manual-compact-instructions>\n${values.customInstructions}\n</manual-compact-instructions>`;
  }
  return rendered;
}

function compactFiles(request: CustomSummaryRequest): { readFiles: string[]; modifiedFiles: string[] } {
  const read = new Set(request.event.preparation.fileOps.read);
  const modified = new Set([
    ...request.event.preparation.fileOps.written,
    ...request.event.preparation.fileOps.edited,
  ]);
  const previous = [...request.event.branchEntries].reverse().find((entry) => entry.type === "compaction");
  if (previous?.details && typeof previous.details === "object") {
    const details = previous.details as { readFiles?: unknown; modifiedFiles?: unknown };
    if (Array.isArray(details.readFiles)) {
      for (const path of details.readFiles) if (typeof path === "string") read.add(path);
    }
    if (Array.isArray(details.modifiedFiles)) {
      for (const path of details.modifiedFiles) if (typeof path === "string") modified.add(path);
    }
  }
  return {
    readFiles: [...read].filter((path) => !modified.has(path)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

function withCarriedFileOps(request: CustomSummaryRequest): SessionBeforeCompactEvent["preparation"] {
  const current = request.event.preparation.fileOps;
  const read = new Set(current.read);
  const written = new Set(current.written);
  const edited = new Set(current.edited);
  const previous = [...request.event.branchEntries].reverse().find((entry) => entry.type === "compaction");
  if (previous?.details && typeof previous.details === "object") {
    const details = previous.details as { readFiles?: unknown; modifiedFiles?: unknown };
    if (Array.isArray(details.readFiles)) {
      for (const path of details.readFiles) if (typeof path === "string") read.add(path);
    }
    if (Array.isArray(details.modifiedFiles)) {
      for (const path of details.modifiedFiles) if (typeof path === "string") edited.add(path);
    }
  }
  return { ...request.event.preparation, fileOps: { read, written, edited } };
}

function assertNativeModelBudget(request: CustomSummaryRequest): void {
  const { event, model } = request;
  const preparation = event.preparation;
  if (!Number.isFinite(model.contextWindow) || model.contextWindow < 1) {
    throw new CompactInputBudgetError("Pi-prompt summarizer has an invalid context window");
  }
  const maxTokens = (fraction: number) => Math.min(
    Math.floor(fraction * preparation.settings.reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const check = (label: string, messages: typeof preparation.messagesToSummarize, outputTokens: number, extraChars: number) => {
    const inputChars = serializeConversation(convertToLlm(messages)).length + extraChars;
    const inputBudget = Math.floor((model.contextWindow - outputTokens) * 3 - 4096);
    if (inputChars > inputBudget) {
      throw new CompactInputBudgetError(
        `Pi-prompt ${label} estimate is ${inputChars} characters; model input budget is ${Math.max(0, inputBudget)}. Chunking is unavailable.`,
      );
    }
  };

  if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
    if (preparation.messagesToSummarize.length > 0) {
      check(
        "history",
        preparation.messagesToSummarize,
        maxTokens(0.8),
        (preparation.previousSummary?.length ?? 0) + (event.customInstructions?.length ?? 0),
      );
    }
    check("turn-prefix", preparation.turnPrefixMessages, maxTokens(0.5), 0);
  } else {
    check(
      "history",
      preparation.messagesToSummarize,
      maxTokens(0.8),
      (preparation.previousSummary?.length ?? 0) + (event.customInstructions?.length ?? 0),
    );
  }
}

function appendFileTags(summary: string, files: { readFiles: string[]; modifiedFiles: string[] }): string {
  const tags: string[] = [];
  if (files.readFiles.length > 0) tags.push(`<read-files>\n${files.readFiles.join("\n")}\n</read-files>`);
  if (files.modifiedFiles.length > 0) tags.push(`<modified-files>\n${files.modifiedFiles.join("\n")}\n</modified-files>`);
  return tags.length > 0 ? `${summary.trim()}\n\n${tags.join("\n\n")}` : summary.trim();
}

const SPLIT_TURN_MARKER = "\n\n---\n\n**Turn Context (split turn):**\n\n";

/** Label Pi's split input segments without assuming either contains fresher facts. */
function labelSplitTurnSegments(summary: string, isSplitTurn: boolean): string {
  if (!isSplitTurn) return summary;
  const boundary = summary.indexOf(SPLIT_TURN_MARKER);
  if (boundary < 0 || summary.indexOf(SPLIT_TURN_MARKER, boundary + SPLIT_TURN_MARKER.length) >= 0) {
    // Unknown or ambiguous upstream format: never guess the split boundary.
    return summary;
  }
  const historyLabel = "> [HISTORY] Summary of messages before the split turn; progress and next steps may be outdated.";
  const turnPrefixLabel = "> [TURN_PREFIX] Summary of the earlier part of the split turn, before retained messages; it may quote older material. Resolve status conflicts using explicit completion evidence and retained messages, not section order alone.";
  return `${summary.slice(0, boundary)}\n\n${historyLabel}${SPLIT_TURN_MARKER}${turnPrefixLabel}\n\n${summary.slice(boundary + SPLIT_TURN_MARKER.length)}`;
}

/** Uses Pi's exported compact helper, retaining its prompt, split handling, and file tracking. */
export async function summarizeWithPiPrompt(request: CustomSummaryRequest): Promise<CompactionResult> {
  const { event, context, model, profile } = request;
  const stream: Parameters<typeof compact>[7] = (streamModel, providerContext, options) => {
    const resultStream = context.modelRegistry.streamSimple(streamModel, providerContext, options);
    const originalResult = resultStream.result.bind(resultStream);
    resultStream.result = async () => {
      const response = await originalResult();
      assertFinalResponse(response, "Pi-prompt");
      return response;
    };
    return resultStream;
  };
  event.signal.throwIfAborted();
  assertNativeModelBudget(request);
  const result = await compact(
    withCarriedFileOps(request),
    model,
    undefined,
    undefined,
    event.customInstructions,
    event.signal,
    compactReasoningLevel(profile, context),
    stream,
    undefined,
    undefined,
    undefined,
  );
  event.signal.throwIfAborted();
  if (!result.summary.trim()) throw new Error("Compact summary was empty");
  return { ...result, summary: labelSplitTurnSegments(result.summary, event.preparation.isSplitTurn) };
}

/** Whole-summary replacement adapter. The conversation and split-prefix inputs occupy distinct prompt slots. */
export const promptSummaryAdapter: CompactSummaryAdapter = {
  async summarize(request) {
    const { event, context, model, profile } = request;
    const prep = event.preparation;
    const conversation = serializeConversation(convertToLlm(prep.messagesToSummarize));
    const turnPrefix = serializeConversation(convertToLlm(prep.turnPrefixMessages));
    const prompt = renderPrompt(profile.prompt!, {
      conversation,
      previousSummary: prep.previousSummary ?? "",
      turnPrefix,
      customInstructions: event.customInstructions ?? "",
    });
    event.signal.throwIfAborted();

    const maxTokens = Math.min(
      Math.floor(0.8 * prep.settings.reserveTokens),
      model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
    );
    if (maxTokens <= 0) throw new Error("Compact replacement prompt has no output-token budget");
    if (!Number.isFinite(model.contextWindow) || model.contextWindow < 1) {
      throw new Error("Compact replacement prompt model has an invalid context window");
    }
    const maxInputChars = Math.max(0, (model.contextWindow - maxTokens) * 3 - SUMMARY_SYSTEM_PROMPT.length);
    if (prompt.length > maxInputChars) {
      throw new CompactInputBudgetError(`Compact replacement request is ${prompt.length} characters; model input budget is ${maxInputChars}`);
    }
    const reasoningLevel = compactReasoningLevel(profile, context);

    const response = await context.modelRegistry.complete(
      model,
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
      },
      {
        maxTokens,
        signal: event.signal,
        cacheRetention: "none",
        sessionId: uuidv7(),
        ...(model.reasoning && reasoningLevel ? { reasoning: reasoningLevel } : {}),
      },
    );
    event.signal.throwIfAborted();
    const summary = assertFinalResponse(response, "replacement-prompt");
    const files = compactFiles(request);
    const visibleSummary = appendFileTags(summary, files);
    if (visibleSummary.length > 32_000) {
      throw new Error("Compact replacement summary exceeds the 32000-character output limit");
    }

    return {
      summary: visibleSummary,
      firstKeptEntryId: prep.firstKeptEntryId,
      tokensBefore: prep.tokensBefore,
      usage: response.usage,
      details: {
        strategy: "replacement-prompt-v1",
        stages: [{ label: "whole-summary", provider: model.provider, model: model.id, usage: response.usage }],
        ...files,
      },
    };
  },
};
