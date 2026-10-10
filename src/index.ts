import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_IDLE_AFTER_MINUTES,
  DEFAULT_IDLE_MIN_CONTEXT_TOKENS,
  describeIdleSource,
  getSessionProfile,
  loadProfileConfig,
  resolveIdleCompact,
  resolveProfile,
  SESSION_PROFILE_ENTRY,
  updateUserIdleDefault,
} from "./config.ts";
import type { CompactProfile, IdleCompactConfig } from "./config.ts";
import { compactStatusLabel, createCompactStatusTracker } from "./compact-status.ts";
import { createIdleCompactScheduler } from "./idle-compact.ts";
import { CompactInputBudgetError, describePipelineSummarizers, runTypedPipeline } from "./pipeline.ts";
import type { NonLlmReducer, PipelineOptions } from "./pipeline.ts";
import { deterministicFactsReducer } from "./reducers.ts";
import { promptSummaryAdapter, summarizeWithPiPrompt } from "./summary-adapter.ts";
import type { CompactSummaryAdapter, CustomSummaryRequest } from "./summary-adapter.ts";

export type { CompactProfile, IdleCompactConfig, IdleCompactOptions, ProfileConfigFile } from "./config.ts";
export type {
  CompactThinkingLevel,
  HistoryItem,
  HistoryKind,
  NonLlmReducer,
  PipelineOptions,
  PipelineRoute,
  ReducerInput,
  SummarySharedContext,
  ToolInteraction,
} from "./pipeline.ts";

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

/** Configuration errors name a file and field, never file contents. */
function configErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return message.trim() ? message.trim().replace(/\.$/, "") : "unknown configuration error";
}

function reportConfiguredFailure(context: ExtensionContext, message: string, level: "error" | "warning" | "info" = "error"): void {
  try {
    if (context.hasUI) context.ui.notify(message, level);
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
    context.ui.notify(`Could not set compaction profile: ${configErrorMessage(error)}`, "error");
  }
}

function describeIdle(policy: { afterIdleMinutes: number; minContextTokens: number } | undefined): string {
  return policy ? `on, after ${policy.afterIdleMinutes} min idle, at least ${policy.minContextTokens} context tokens` : "off";
}

function describeGlobalIdle(config: IdleCompactConfig | undefined): string {
  if (!config || config.enabled === false) return "off";
  return describeIdle({
    afterIdleMinutes: config.afterIdleMinutes ?? DEFAULT_IDLE_AFTER_MINUTES,
    minContextTokens: config.minContextTokens ?? DEFAULT_IDLE_MIN_CONTEXT_TOKENS,
  });
}

/** `/compact-idle [on [minutes]|off|status]`: the global (user default) idle setting plus this session's effective one. */
async function idleCommand(args: string, context: ExtensionCommandContext, agentDir: string): Promise<void> {
  const [action = "status", minutesArg, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const usage = "Usage: /compact-idle [on [minutes]|off|status]";
  try {
    if (rest.length > 0 || (action !== "on" && minutesArg !== undefined)) {
      context.ui.notify(usage, "error");
      return;
    }
    if (action === "on" || action === "off") {
      let minutes: number | undefined;
      if (minutesArg !== undefined) {
        minutes = Number(minutesArg);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
          context.ui.notify("Idle minutes must be a number from 1 to 1440.", "error");
          return;
        }
      }
      await updateUserIdleDefault(agentDir, (current) => ({
        ...(current ?? {}),
        enabled: action === "on",
        ...(minutes !== undefined ? { afterIdleMinutes: minutes } : {}),
      }));
    } else if (action !== "status") {
      context.ui.notify(usage, "error");
      return;
    }
    const config = await loadProfileConfig(agentDir, context.cwd, context.isProjectTrusted());
    const sessionProfile = getCurrentSessionProfile(context);
    const chatModel = activeChatModel(context);
    const effective = resolveIdleCompact(config, chatModel, sessionProfile);
    const source = describeIdleSource(config, chatModel, sessionProfile);
    const lines = [
      `Idle compaction for all chats: ${describeGlobalIdle(config.user.default?.idleCompact)}.`,
      `This session (${chatModel ?? "no model"}): ${describeIdle(effective)}${source ? `, set by ${source}` : ""}.`,
    ];
    if (action !== "status") lines.push("It applies from the end of the next turn.");
    context.ui.notify(lines.join("\n"), "info");
  } catch (error) {
    context.ui.notify(`Could not ${action === "status" ? "read" : "change"} idle compaction: ${configErrorMessage(error)}`, "error");
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
  const idle = createIdleCompactScheduler({
    resolve: async (context) => {
      const sessionProfile = getCurrentSessionProfile(context);
      const config = await loadProfileConfig(agentDir, context.cwd, context.isProjectTrusted());
      return resolveIdleCompact(config, activeChatModel(context), sessionProfile);
    },
    report: (context, message, level) => reportConfiguredFailure(context, message, level),
  });
  pi.on("session_before_compact", async (event, context) => {
    const idleTriggered = idle.consumeIdleTrigger();
    let profile: CompactProfile | undefined;
    try {
      const sessionProfile = getCurrentSessionProfile(context);
      // A session-level native choice must work even when a configuration file is broken.
      if (sessionProfile === "native") {
        status.clearOnNativePassThrough(context);
        return undefined;
      }
      const config = await loadProfileConfig(agentDir, context.cwd, context.isProjectTrusted());
      profile = resolveProfile(config, activeChatModel(context), sessionProfile);
    } catch (error) {
      status.clearOnNativePassThrough(context);
      if (!event.signal.aborted) {
        reportConfiguredFailure(
          context,
          `Compaction profile configuration is invalid: ${configErrorMessage(error)}. Compaction was canceled. Fix the configuration, or run /compact-profile native to use Pi's native compaction in this session.`,
        );
      }
      return { cancel: true };
    }

    // No profile, an empty profile, or an explicit native profile means Pi owns compaction exactly.
    if (!profile || profile.mode === "native" || (!profile.model && !profile.prompt && profile.pipeline === undefined)) {
      status.clearOnNativePassThrough(context);
      return undefined;
    }

    status.begin(context, compactStatusLabel(idleTriggered ? "idle" : event.reason, summarizerStatusDetail(event, context, profile, reducers)));
    try {
      const compaction = await runConfiguredSummary(event, context, profile, adapter, reducers);
      return { compaction };
    } catch (error) {
      if (event.signal.aborted) return { cancel: true };
      if (profile.failurePolicy === "native") {
        reportConfiguredFailure(
          context,
          "Configured compaction could not produce a summary; using Pi's native summarizer because failurePolicy is native.",
          "warning",
        );
        return undefined;
      }
      const message = error instanceof CompactInputBudgetError
        ? "Configured compaction input exceeds the selected summarizer's context budget; no summary was stored."
        : "Configured compaction could not produce a summary; compaction was canceled instead of silently using Pi's native summarizer. Set failurePolicy to native to opt in to that fallback.";
      reportConfiguredFailure(context, message);
      return { cancel: true };
    }
  });

  // Terminal compact lifecycle events clear the transient status without false success.
  pi.on("session_compact", (_event, context) => {
    idle.cancel();
    status.handleCompact(context);
  });
  pi.on("session_compact_failed", (_event, context) => status.handleCompactFailed(context));
  pi.on("session_shutdown", (_event, context) => {
    idle.cancel();
    status.handleShutdown(context);
  });

  // Idle compaction: a run's end starts the cold-cache timer; any new activity ends it.
  pi.on("agent_end", (_event, context) => idle.schedule(context));
  pi.on("agent_start", () => idle.cancel());
  pi.on("input", () => idle.cancel());
  pi.on("model_select", () => idle.cancel());

  pi.registerCommand("compact-profile", {
    description: "Set or clear the current session's simple-compact profile",
    handler: async (args, context) => setSessionProfile(args, context, pi, agentDir),
  });

  pi.registerCommand("compact-idle", {
    description: "Turn idle (cold-cache) compaction on or off for all chats, or show its status",
    getArgumentCompletions: (prefix) => [
      { value: "on", label: "on", description: "Turn on for all chats; optionally add minutes, e.g. on 60" },
      { value: "off", label: "off", description: "Turn off for all chats" },
      { value: "status", label: "status", description: "Show the global and this session's setting" },
    ].filter((item) => item.value.startsWith(prefix.trim())),
    handler: async (args, context) => idleCommand(args, context, agentDir),
  });
}

export default function (pi: ExtensionAPI): void {
  registerSimpleCompact(pi);
}
