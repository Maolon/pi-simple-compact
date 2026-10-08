import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  getSessionProfile,
  loadProfileConfig,
  resolveProfile,
  SESSION_PROFILE_ENTRY,
} from "./config.ts";
import type { CompactProfile } from "./config.ts";
import { compactStatusLabel, createCompactStatusTracker } from "./compact-status.ts";
import { CompactInputBudgetError, describePipelineSummarizers, runTypedPipeline } from "./pipeline.ts";
import type { NonLlmReducer, PipelineOptions } from "./pipeline.ts";
import { deterministicFactsReducer } from "./reducers.ts";
import { promptSummaryAdapter, summarizeWithPiPrompt } from "./summary-adapter.ts";
import type { CompactSummaryAdapter, CustomSummaryRequest } from "./summary-adapter.ts";

export const BUILTIN_REDUCER_NAMES = { deterministicFacts: "deterministic-facts" } as const;
const BUILTIN_REDUCERS: Record<string, NonLlmReducer> = {
  [BUILTIN_REDUCER_NAMES.deterministicFacts]: deterministicFactsReducer,
};

export function createCompactReducerRegistry(custom: Record<string, NonLlmReducer> = {}): Record<string, NonLlmReducer> {
  const registry: Record<string, NonLlmReducer> = Object.assign(Object.create(null) as Record<string, NonLlmReducer>, BUILTIN_REDUCERS);
  for (const [name, reducer] of Object.entries(custom)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || typeof reducer !== "function") {
      throw new Error(`Invalid trusted compact reducer registration: ${JSON.stringify(name)}`);
    }
    if (Object.hasOwn(registry, name)) throw new Error(`Compact reducer name is already registered: ${name}`);
    registry[name] = reducer;
  }
  return Object.freeze(registry);
}

export interface SimpleCompactOptions {
  agentDir?: string;
  /** Trusted local functions. JSON profiles can reference these names but cannot load code. */
  reducers?: Record<string, NonLlmReducer>;
}

function activeChatModel(context: ExtensionContext): string | undefined {
  const model = context.model;
  return model ? `${model.provider}/${model.id}` : undefined;
}

function chooseModel(profile: CompactProfile, context: ExtensionContext) {
  if (!profile.model) {
    if (!context.model) throw new Error("No chat model is available for configured compaction");
    return context.model;
  }
  const separator = profile.model.indexOf("/");
  const provider = profile.model.slice(0, separator);
  const modelId = profile.model.slice(separator + 1);
  const model = context.modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`Configured compaction model ${JSON.stringify(profile.model)} is not available`);
  return model;
}

function validateResult(
  event: SessionBeforeCompactEvent,
  result: Awaited<ReturnType<typeof summarizeWithPiPrompt>>,
): void {
  if (!result.summary.trim()) throw new Error("Compact summary was empty");
  if (result.firstKeptEntryId !== event.preparation.firstKeptEntryId) {
    throw new Error("Compact adapter changed firstKeptEntryId; refusing an unsafe compaction boundary");
  }
  if (result.tokensBefore !== event.preparation.tokensBefore) {
    throw new Error("Compact adapter changed tokensBefore; refusing an inconsistent compaction result");
  }
}

/** The typed options a profile actually runs: the nested pipeline with the top-level model and thinking level as its fallbacks. */
function effectivePipelineOptions(profile: CompactProfile): PipelineOptions {
  return {
    ...profile.pipeline!,
    ...(profile.pipeline!.model === undefined && profile.model !== undefined ? { model: profile.model } : {}),
    ...(profile.pipeline!.thinkingLevel === undefined && profile.thinkingLevel !== undefined ? { thinkingLevel: profile.thinkingLevel } : {}),
  };
}

/**
 * Truthful bounded description of what this attempt uses as its summarizer.
 *
 * Single-LLM paths name the exact resolved model ID. Typed pipelines report what this
 * attempt's stages would actually call — one model ID only when every LLM stage uses
 * that same model, an honest multi-model/local label otherwise. Never throws and never
 * inspects conversation content; a description failure degrades to a generic label that
 * the terminal compact events still clear.
 */
function summarizerStatusDetail(
  event: SessionBeforeCompactEvent,
  context: ExtensionContext,
  profile: CompactProfile,
  reducers: Record<string, NonLlmReducer>,
): string {
  if (profile.pipeline) {
    try {
      const usage = describePipelineSummarizers(event, context, effectivePipelineOptions(profile), reducers);
      if (usage.llmModels.length === 1) return usage.llmModels[0]!.modelId;
      if (usage.llmModels.length === 0) return "pipeline, local reducers";
      return "pipeline, multiple models";
    } catch {
      return "pipeline";
    }
  }
  try {
    return chooseModel(profile, context).id;
  } catch {
    return "configured summarizer";
  }
}

function reportConfiguredFailure(context: ExtensionContext, message: string): void {
  try {
    if (context.hasUI) context.ui.notify(message, "error");
    else console.error(`[pi-simple-compact] ${message}`);
  } catch {
    // Diagnostics must not turn a fail-closed cancellation into an implicit native fallback.
  }
}

async function runConfiguredSummary(
  event: SessionBeforeCompactEvent,
  context: ExtensionContext,
  profile: CompactProfile,
  adapter: CompactSummaryAdapter,
  reducers: Record<string, NonLlmReducer>,
): Promise<Awaited<ReturnType<typeof summarizeWithPiPrompt>>> {
  let result: Awaited<ReturnType<typeof summarizeWithPiPrompt>>;
  if (profile.pipeline) {
    result = await runTypedPipeline(event, context, effectivePipelineOptions(profile), reducers);
  } else if (profile.prompt) {
    const model = chooseModel(profile, context);
    const request: CustomSummaryRequest = { event, context, model, profile };
    result = await adapter.summarize(request);
  } else {
    const model = chooseModel(profile, context);
    result = await summarizeWithPiPrompt({ event, context, model, profile });
  }
  validateResult(event, result);
  return result;
}

function getCurrentSessionProfile(context: ExtensionContext): string | undefined {
  const customEntries = context.sessionManager.getBranch().filter((entry) => entry.type === "custom");
  return getSessionProfile(customEntries);
}

async function setSessionProfile(args: string, context: ExtensionCommandContext, pi: ExtensionAPI, agentDir: string): Promise<void> {
  const requested = args.trim();
  if (!requested) {
    context.ui.notify("Usage: /compact-profile <native|profile-name|reset>", "info");
    return;
  }
  if (requested === "reset") {
    pi.appendEntry(SESSION_PROFILE_ENTRY, { version: 1, profile: null });
    context.ui.notify("Compaction profile override cleared; inherited settings apply.", "info");
    return;
  }
  if (requested === "native") {
    pi.appendEntry(SESSION_PROFILE_ENTRY, { version: 1, profile: "native" });
    context.ui.notify("This session's compaction now uses Pi's native behavior.", "info");
    return;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requested)) {
    context.ui.notify("Profile names may contain letters, digits, dot, underscore, and hyphen.", "error");
    return;
  }
  try {
    const config = await loadProfileConfig(agentDir, context.cwd, context.isProjectTrusted());
    if (!config.project.profiles?.[requested] && !config.user.profiles?.[requested]) {
      throw new Error(`Unknown compaction profile ${JSON.stringify(requested)}`);
    }
    pi.appendEntry(SESSION_PROFILE_ENTRY, { version: 1, profile: requested });
    context.ui.notify(`Compaction profile set for this session: ${requested}`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.ui.notify(`Could not set compaction profile: ${message}`, "error");
  }
}

export function registerSimpleCompact(
  pi: ExtensionAPI,
  adapter: CompactSummaryAdapter = promptSummaryAdapter,
  options: SimpleCompactOptions = {},
): void {
  const agentDir = options.agentDir ?? getAgentDir();
  const reducers = createCompactReducerRegistry(options.reducers);
  const status = createCompactStatusTracker();
  pi.on("session_before_compact", async (event, context) => {
    let profile: CompactProfile | undefined;
    try {
      const config = await loadProfileConfig(agentDir, context.cwd, context.isProjectTrusted());
      profile = resolveProfile(config, activeChatModel(context), getCurrentSessionProfile(context));
    } catch {
      status.clearOnNativePassThrough(context);
      if (!event.signal.aborted) {
        reportConfiguredFailure(context, "Profile configuration could not be resolved; compaction was canceled.");
      }
      return { cancel: true };
    }

    // No profile, an empty profile, or an explicit native profile means Pi owns compaction exactly.
    if (!profile || profile.mode === "native" || (!profile.model && !profile.prompt && profile.pipeline === undefined)) {
      status.clearOnNativePassThrough(context);
      return undefined;
    }

    status.begin(context, compactStatusLabel(event.reason, summarizerStatusDetail(event, context, profile, reducers)));
    try {
      const compaction = await runConfiguredSummary(event, context, profile, adapter, reducers);
      return { compaction };
    } catch (error) {
      if (event.signal.aborted) return { cancel: true };
      if (profile.failurePolicy === "native") return undefined;
      const message = error instanceof CompactInputBudgetError
        ? "Configured compaction input exceeds the selected summarizer's context budget; no summary was stored."
        : "Configured compaction could not produce a summary; compaction was canceled instead of silently using Pi's native summarizer. Set failurePolicy to native to opt in to that fallback.";
      reportConfiguredFailure(context, message);
      return { cancel: true };
    }
  });

  // Terminal compact lifecycle events clear the transient status without false success.
  pi.on("session_compact", (_event, context) => status.handleCompact(context));
  pi.on("session_compact_failed", (_event, context) => status.handleCompactFailed(context));
  pi.on("session_shutdown", (_event, context) => status.handleShutdown(context));

  pi.registerCommand("compact-profile", {
    description: "Set or clear the current session's simple-compact profile",
    handler: async (args, context) => setSessionProfile(args, context, pi, agentDir),
  });
}

export default function (pi: ExtensionAPI): void {
  registerSimpleCompact(pi);
}
