import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSimpleCompact } from "../src/index.ts";
import { SESSION_PROFILE_ENTRY } from "../src/config.ts";

type ExtensionMode = ExtensionContext["mode"];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function model(provider: string, id: string) {
  return {
    provider,
    id,
    name: `${provider}/${id}`,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
  };
}

function usage(input = 12, output = 4) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: input / 1000, output: output / 1000, cacheRead: 0, cacheWrite: 0, total: (input + output) / 1000 },
  };
}

function assistantResponse(text: string, stopReason: string = "stop", content?: unknown[]) {
  return {
    role: "assistant",
    content: content ?? [{ type: "text", text }],
    api: "openai-completions",
    provider: "summarizer",
    model: "offline-fixture",
    usage: usage(),
    stopReason,
    isError: stopReason === "error",
    timestamp: Date.now(),
  };
}

function preparation(overrides: Record<string, unknown> = {}) {
  return {
    firstKeptEntryId: "keep-1",
    messagesToSummarize: [{ role: "user", content: "Implement the compact-only extension", timestamp: 1 }],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 128,
    previousSummary: undefined,
    fileOps: { read: new Set(["src/a.ts"]), written: new Set(["src/b.ts"]), edited: new Set<string>() },
    settings: { enabled: true, reserveTokens: 1024, keepRecentTokens: 100 },
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    type: "session_before_compact",
    preparation: preparation(),
    branchEntries: [],
    customInstructions: undefined,
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function fixture(options: { projectTrusted?: boolean; mode?: ExtensionMode } = {}) {
  const root = await mkdtemp(join(tmpdir(), "simple-compact-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  const projectTrusted = options.projectTrusted ?? true;
  const mode: ExtensionMode = options.mode ?? "print";
  const chatModel = model("chat", "chat-model");
  const alternateModel = model("other", "summarizer");
  const models = new Map([
    [`${chatModel.provider}/${chatModel.id}`, chatModel],
    [`${alternateModel.provider}/${alternateModel.id}`, alternateModel],
  ]);
  const completions: ReturnType<typeof assistantResponse>[] = [];
  const streams: ReturnType<typeof assistantResponse>[] = [];
  const modelRegistry = {
    find: vi.fn((provider: string, id: string) => models.get(`${provider}/${id}`)),
    complete: vi.fn(async (
      _model: unknown,
      _request: { messages: Array<{ content: Array<{ type: string; text?: string }> }> },
      _options: unknown,
    ) => completions.shift() ?? assistantResponse("offline custom summary")),
    streamSimple: vi.fn((_model: unknown, _request: unknown, _options: unknown) => ({
      result: async () => streams.shift() ?? assistantResponse("offline native-prompt summary"),
    })),
  };
  const sessionEntries: Array<{ type: "custom"; customType: string; data?: unknown }> = [];
  const sessionManager = {
    getSessionId: () => "offline-session",
    getBranch: () => sessionEntries,
  };
  const ui = { notify: vi.fn(), setStatus: vi.fn() };
  const context = {
    cwd,
    mode,
    model: chatModel,
    modelRegistry,
    sessionManager,
    thinkingLevel: "off",
    isProjectTrusted: () => projectTrusted,
    hasUI: mode === "tui" || mode === "rpc",
    ui,
  } as unknown as ExtensionContext;

  let beforeCompact: ((ev: unknown, ctx: unknown) => unknown) | undefined;
  let command: { handler: (args: string, ctx: never) => Promise<void> } | undefined;
  const handlers = new Map<string, (ev: unknown, ctx: unknown) => unknown>();
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const api = {
    on: vi.fn((name: string, handler: (ev: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
      if (name === "session_before_compact") beforeCompact = handler;
      return () => undefined;
    }),
    registerCommand: vi.fn((_name: string, registered: typeof command) => { command = registered; }),
    appendEntry: vi.fn((customType: string, data: unknown) => appendedEntries.push({ customType, data })),
  } as unknown as ExtensionAPI;
  registerSimpleCompact(api, undefined, { agentDir });
  if (!beforeCompact || !command) throw new Error("Extension did not register its compact hook and command");

  return {
    root,
    cwd,
    agentDir,
    chatModel,
    alternateModel,
    context,
    ui,
    mode,
    modelRegistry,
    completions,
    streams,
    sessionEntries,
    sessionManager,
    handlers,
    beforeCompact: beforeCompact as (ev: unknown, ctx: unknown) => Promise<unknown>,
    command,
    appendedEntries,
  };
}

async function writeUserConfig(agentDir: string, config: unknown): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "pi-simple-compact.json"), JSON.stringify(config), "utf8");
}

async function writeProjectConfig(cwd: string, config: unknown, settingsCompanion = true): Promise<void> {
  const dir = join(cwd, ".pi");
  await mkdir(dir, { recursive: true });
  if (settingsCompanion) await writeFile(join(dir, "settings.json"), "{}", "utf8");
  await writeFile(join(dir, "pi-simple-compact.json"), JSON.stringify(config), "utf8");
}

describe("compact-only extension", () => {
  it("returns undefined for absent configuration for manual, threshold, and overflow triggers", async () => {
    const fx = await fixture({ projectTrusted: false });
    for (const reason of ["manual", "threshold", "overflow"]) {
      await expect(fx.beforeCompact(event({ reason }), fx.context)).resolves.toBeUndefined();
    }
    expect(fx.modelRegistry.find).not.toHaveBeenCalled();
    expect(fx.modelRegistry.complete).not.toHaveBeenCalled();
    expect(fx.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });

  it("ignores a lone custom project config even when Pi's trust boolean is true", async () => {
    const fx = await fixture({ projectTrusted: true });
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } }, false);

    await expect(fx.beforeCompact(event(), fx.context)).resolves.toBeUndefined();
    expect(fx.modelRegistry.find).not.toHaveBeenCalled();
    expect(fx.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });

  it("ignores an untrusted project-local alternate-provider profile and yields to Pi native compaction", async () => {
    const fx = await fixture({ projectTrusted: false });
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });

    await expect(fx.beforeCompact(event(), fx.context)).resolves.toBeUndefined();
    await writeFile(join(fx.cwd, ".pi", "pi-simple-compact.json"), "{invalid", "utf8");
    await expect(fx.beforeCompact(event(), fx.context)).resolves.toBeUndefined();
    expect(fx.modelRegistry.find).not.toHaveBeenCalled();
    expect(fx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(fx.modelRegistry.complete).not.toHaveBeenCalled();
  });

  it("keeps user configuration active while ignoring a project's untrusted native override", async () => {
    const fx = await fixture({ projectTrusted: false });
    await writeProjectConfig(fx.cwd, { default: { mode: "native" } });
    await writeUserConfig(fx.agentDir, { default: { model: "other/summarizer" } });
    fx.streams.push(assistantResponse("user-configured compact summary"));

    const result = await fx.beforeCompact(event(), fx.context) as { compaction: { summary: string } };
    expect(result.compaction.summary).toContain("user-configured compact summary");
    expect(fx.modelRegistry.streamSimple.mock.calls[0]![0]).toBe(fx.alternateModel);
  });

  it("honors an explicit native profile and a branch-local native override", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer", mode: "native" } });
    await expect(fx.beforeCompact(event(), fx.context)).resolves.toBeUndefined();
    expect(fx.modelRegistry.streamSimple).not.toHaveBeenCalled();

    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    fx.sessionEntries.push({
      type: "custom",
      customType: SESSION_PROFILE_ENTRY,
      data: { version: 1, profile: "native" },
    });
    await expect(fx.beforeCompact(event(), fx.context)).resolves.toBeUndefined();
    expect(fx.modelRegistry.find).not.toHaveBeenCalled();
    expect(fx.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });

  it("fails closed on invalid configuration rather than allowing Pi's error-swallowing hook runner to fall through", async () => {
    const fx = await fixture();
    const dir = join(fx.cwd, ".pi");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "settings.json"), "{}", "utf8");
    await writeFile(join(dir, "pi-simple-compact.json"), "{invalid SECRET-LOOKING-CONTENT", "utf8");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(fx.beforeCompact(event(), fx.context)).resolves.toEqual({ cancel: true });
    expect(fx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledOnce();
    const message = String(diagnostic.mock.calls[0]![0]);
    expect(message).toMatch(/^\[pi-simple-compact\] Compaction profile configuration is invalid: .*pi-simple-compact\.json is not valid JSON \(line 1, column 2\)\./);
    expect(message).toContain("/compact-profile native");
    expect(message).not.toContain("SECRET-LOOKING-CONTENT");
    expect(message).not.toContain("invalid S");
  });

  it("lets a session native override bypass a broken configuration file", async () => {
    const fx = await fixture();
    const dir = join(fx.cwd, ".pi");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "settings.json"), "{}", "utf8");
    await writeFile(join(dir, "pi-simple-compact.json"), "{invalid", "utf8");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fx.sessionEntries.push({ type: "custom", customType: SESSION_PROFILE_ENTRY, data: { version: 1, profile: "native" } });

    await expect(fx.beforeCompact(event(), fx.context)).resolves.toBeUndefined();
    expect(fx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it("names a removed session profile and the way out instead of a generic failure", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fx.sessionEntries.push({ type: "custom", customType: SESSION_PROFILE_ENTRY, data: { version: 1, profile: "gone" } });

    await expect(fx.beforeCompact(event(), fx.context)).resolves.toEqual({ cancel: true });
    expect(fx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    const message = String(diagnostic.mock.calls[0]![0]);
    expect(message).toContain('compaction profile "gone", which is no longer configured');
    expect(message).toContain("/compact-profile reset");
  });

  it("uses a trusted project model-only profile with Pi's native helper and authenticated provider-neutral stream", async () => {
    const fx = await fixture({ projectTrusted: true });
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    fx.streams.push(assistantResponse("native-prompt alternate-model summary"));
    const originalChatModel = fx.context.model;

    const result = await fx.beforeCompact(event(), fx.context) as { compaction: { summary: string; firstKeptEntryId: string; details: unknown } };

    expect(result.compaction.summary).toContain("native-prompt alternate-model summary");
    expect(result.compaction.firstKeptEntryId).toBe("keep-1");
    expect(fx.modelRegistry.streamSimple).toHaveBeenCalledOnce();
    expect(fx.modelRegistry.streamSimple.mock.calls[0]![0]).toBe(fx.alternateModel);
    expect(fx.modelRegistry.streamSimple.mock.calls[0]![2]).not.toMatchObject({ sessionId: "offline-session" });
    expect(fx.context.model).toBe(originalChatModel);
    expect(result.compaction.details).toEqual({
      readFiles: ["src/a.ts"],
      modifiedFiles: ["src/b.ts"],
      strategy: "pi-prompt-v1",
      stages: [{ label: "pi-prompt", provider: "other", model: "summarizer" }],
    });
    expect(result.compaction.summary).not.toContain("[HISTORY]");
    expect(result.compaction.summary).not.toContain("[TURN_PREFIX]");
  });

  it("labels native split input segments without implying quoted turn-prefix tasks are fresher facts", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    const history = "## Goal\nShip the extension\n\n## Progress\n- Tests passed after the status fix.";
    const turnPrefix = "## Original Request\n- [ ] Run tests (quoted from older notes).";
    fx.streams.push(assistantResponse(history), assistantResponse(turnPrefix));
    const split = event({
      preparation: preparation({
        previousSummary: "## Goal\nShip the extension",
        turnPrefixMessages: [{ role: "user", content: "Quoted older task: run tests", timestamp: 2 }],
        isSplitTurn: true,
      }),
    });

    const result = await fx.beforeCompact(split, fx.context) as {
      compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; usage: ReturnType<typeof usage>; details: unknown };
    };
    const text = result.compaction.summary;
    expect(text.startsWith("## Goal\n")).toBe(true);
    expect(text).toContain(history);
    expect(text).toContain(turnPrefix);
    expect(text).toMatch(/\[HISTORY\][^\n]*before the split turn/i);
    expect(text).toMatch(/\[TURN_PREFIX\][^\n]*earlier part of the split turn/i);
    expect(text).toContain("may quote older material");
    expect(text).toContain("explicit completion evidence and retained messages, not section order alone");
    expect(text).not.toContain("prefer this section");
    expect(text.indexOf(history)).toBeLessThan(text.indexOf("[HISTORY]"));
    expect(text.indexOf("[HISTORY]")).toBeLessThan(text.indexOf("**Turn Context (split turn):**"));
    expect(text.indexOf("**Turn Context (split turn):**")).toBeLessThan(text.indexOf("[TURN_PREFIX]"));
    expect(text.indexOf("[TURN_PREFIX]")).toBeLessThan(text.indexOf(turnPrefix));
    expect(text.match(/\[HISTORY\]/g)).toHaveLength(1);
    expect(text.match(/\[TURN_PREFIX\]/g)).toHaveLength(1);
    expect(text.endsWith("<modified-files>\nsrc/b.ts\n</modified-files>")).toBe(true);
    expect(text).toContain("<read-files>\nsrc/a.ts\n</read-files>");
    expect(result.compaction).toMatchObject({ firstKeptEntryId: "keep-1", tokensBefore: 128, details: { readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts"] } });
    expect(result.compaction.usage?.input).toBe(24);
    expect(fx.modelRegistry.streamSimple).toHaveBeenCalledTimes(2);
    expect(fx.context.model?.id).toBe("chat-model");
  });

  it("leaves an ambiguous split marker unchanged instead of guessing which part is recent", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    const marker = "\n\n---\n\n**Turn Context (split turn):**\n\n";
    fx.streams.push(assistantResponse(`History quotes the marker${marker}as a literal example`), assistantResponse("Newer turn prefix"));
    const split = event({
      preparation: preparation({
        turnPrefixMessages: [{ role: "user", content: "Later work", timestamp: 2 }],
        isSplitTurn: true,
      }),
    });

    const result = await fx.beforeCompact(split, fx.context) as { compaction: { summary: string } };
    expect(result.compaction.summary.split(marker)).toHaveLength(3);
    expect(result.compaction.summary).not.toContain("[HISTORY]");
    expect(result.compaction.summary).not.toContain("[TURN_PREFIX]");
  });

  it("does not label a split turn with no prefix messages, matching when Pi writes the split section", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    const marker = "\n\n---\n\n**Turn Context (split turn):**\n\n";
    fx.streams.push(assistantResponse(`History that quotes the marker${marker}once`));
    const split = event({ preparation: preparation({ turnPrefixMessages: [], isSplitTurn: true }) });

    const result = await fx.beforeCompact(split, fx.context) as { compaction: { summary: string } };
    expect(result.compaction.summary).toContain(marker);
    expect(result.compaction.summary).not.toContain("[HISTORY]");
    expect(result.compaction.summary).not.toContain("[TURN_PREFIX]");
  });

  it("fails clearly before streaming when the selected native-prompt model cannot fit the prepared summary", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    fx.alternateModel.contextWindow = 128;
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(fx.beforeCompact(event(), fx.context)).resolves.toEqual({ cancel: true });
    expect(fx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(diagnostic.mock.calls.flat().join(" ")).toContain("input exceeds the selected summarizer's context budget");
  });

  it("rejects non-final or empty alternate-model results before Pi can persist a checkpoint", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fx.streams.push(assistantResponse("partial", "aborted"));

    await expect(fx.beforeCompact(event(), fx.context)).resolves.toEqual({ cancel: true });
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic.mock.calls.flat().join(" ")).not.toContain("partial");
  });

  it("matches compact model overrides only against the exact active chat provider/model", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { models: { "chat/other-model": { model: "other/summarizer" } } });
    await expect(fx.beforeCompact(event(), fx.context)).resolves.toBeUndefined();
    expect(fx.modelRegistry.find).not.toHaveBeenCalled();
    expect(fx.modelRegistry.streamSimple).not.toHaveBeenCalled();
  });

  it("uses fresh non-chat IDs for replacement-prompt requests and keeps its prompt slots separate", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, {
      default: {
        model: "other/summarizer",
        prompt: "conversation={{conversation}}\nprevious={{previousSummary}}\nprefix={{turnPrefix}}\nfocus={{customInstructions}}",
      },
    });
    fx.completions.push(assistantResponse("whole-span split-turn summary"));
    const splitEvent = event({
      preparation: preparation({
        messagesToSummarize: [{ role: "user", content: "old goals", timestamp: 1 }],
        turnPrefixMessages: [{ role: "assistant", content: [{ type: "text", text: "current long turn" }], timestamp: 2 }],
        isSplitTurn: true,
        previousSummary: "earlier decisions",
      }),
      customInstructions: "focus on unresolved decisions",
    });

    const result = await fx.beforeCompact(splitEvent, fx.context) as {
      compaction: { summary: string; usage: ReturnType<typeof usage>; details: { stages: unknown[] } };
    };

    expect(fx.modelRegistry.complete).toHaveBeenCalledOnce();
    const firstSessionId = (fx.modelRegistry.complete.mock.calls[0]![2] as { sessionId?: string }).sessionId;
    expect(firstSessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(firstSessionId).not.toBe(fx.sessionManager.getSessionId());
    const prompt = fx.modelRegistry.complete.mock.calls[0]![1].messages[0]!.content[0]!.text;
    expect(prompt).toContain("old goals");
    expect(prompt).toContain("earlier decisions");
    expect(prompt).toContain("current long turn");
    expect(prompt).toContain("focus on unresolved decisions");
    expect(prompt?.match(/current long turn/g)).toHaveLength(1);
    expect(result.compaction.summary).toContain("whole-span split-turn summary");
    expect(result.compaction.summary).not.toContain("current long turn");
    expect(result.compaction.usage?.input).toBe(12);
    expect(result.compaction.details.stages).toHaveLength(1);

    fx.completions.push(assistantResponse("second whole-span summary"));
    await fx.beforeCompact(splitEvent, fx.context);
    const sessionIds = fx.modelRegistry.complete.mock.calls.map((call) => (call[2] as { sessionId?: string }).sessionId);
    expect(new Set(sessionIds).size).toBe(2);
    expect(sessionIds.every((sessionId) => sessionId && sessionId !== fx.sessionManager.getSessionId())).toBe(true);
  });

  it("cancels configured failures unless native fallback is explicit; cancellation never falls back", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, {
      default: { prompt: "summarize {{conversation}}", failurePolicy: "native" },
    });
    fx.completions.push(assistantResponse("partial output", "length"));
    await expect(fx.beforeCompact(event(), fx.context)).resolves.toBeUndefined();
    expect(fx.modelRegistry.streamSimple).not.toHaveBeenCalled();

    const aborted = new AbortController();
    aborted.abort();
    await expect(fx.beforeCompact(event({ signal: aborted.signal }), fx.context)).resolves.toEqual({ cancel: true });
    expect(fx.modelRegistry.complete).toHaveBeenCalledOnce();
  });

  it("rejects empty, length, error, aborted, and tool-calling custom summaries", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { default: { prompt: "summarize {{conversation}}" } });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const responses = [
      assistantResponse("", "stop"),
      assistantResponse("partial", "length"),
      assistantResponse("", "error"),
      assistantResponse("partial", "aborted"),
      assistantResponse("", "stop", [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo no" } }]),
    ];
    for (const response of responses) {
      fx.completions.push(response);
      await expect(fx.beforeCompact(event(), fx.context)).resolves.toEqual({ cancel: true });
    }
    expect(fx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledTimes(responses.length);
    expect(diagnostic.mock.calls.flat().join(" ")).not.toMatch(/offline-fixture|partial output|token cap/);
    const sessionIds = fx.modelRegistry.complete.mock.calls.map((call) => (call[2] as { sessionId?: string }).sessionId);
    expect(sessionIds.every((sessionId) => sessionId && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId))).toBe(true);
    expect(new Set(sessionIds).size).toBe(responses.length);
    expect(sessionIds).not.toContain(fx.sessionManager.getSessionId());
  });

  it("carries prior hook file metadata into visible model-only file tags", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    fx.streams.push(assistantResponse("summary with carried file context"));
    const eventWithPreviousFiles = event({
      branchEntries: [{
        type: "compaction",
        id: "previous-compaction",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        summary: "previous summary",
        firstKeptEntryId: "keep-1",
        tokensBefore: 512,
        fromHook: true,
        details: { readFiles: ["older-read.ts"], modifiedFiles: ["older-write.ts"] },
      }],
      preparation: preparation({ fileOps: { read: new Set(["new-read.ts"]), written: new Set(), edited: new Set() } }),
    });

    const result = await fx.beforeCompact(eventWithPreviousFiles, fx.context) as { compaction: { summary: string; details: { readFiles: string[]; modifiedFiles: string[] } } };
    expect(result.compaction.details.readFiles).toEqual(["new-read.ts", "older-read.ts"]);
    expect(result.compaction.details.modifiedFiles).toEqual(["older-write.ts"]);
    expect(result.compaction.summary).toContain("<read-files>\nnew-read.ts\nolder-read.ts\n</read-files>");
    expect(result.compaction.summary).toContain("<modified-files>\nolder-write.ts\n</modified-files>");
  });

  it("fails closed on a replacement prompt larger than the selected model context", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { default: { prompt: "{{conversation}}" } });
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const large = event({ preparation: preparation({ messagesToSummarize: [{ role: "user", content: "x".repeat(120_000), timestamp: 1 }] }) });

    await expect(fx.beforeCompact(large, fx.context)).resolves.toEqual({ cancel: true });
    expect(fx.modelRegistry.complete).not.toHaveBeenCalled();
    expect(diagnostic.mock.calls.flat().join(" ")).not.toContain("x".repeat(128));
  });

  it("persists a session profile override and a reset marker through the Pi extension entry API", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { profiles: { fast: { model: "other/summarizer" } } });
    const commandContext = {
      cwd: fx.cwd,
      isProjectTrusted: () => true,
      ui: { notify: vi.fn() },
    } as never;

    await fx.command.handler("fast", commandContext);
    await fx.command.handler("native", commandContext);
    await fx.command.handler("reset", commandContext);
    expect(fx.appendedEntries).toEqual([
      { customType: SESSION_PROFILE_ENTRY, data: { version: 1, profile: "fast" } },
      { customType: SESSION_PROFILE_ENTRY, data: { version: 1, profile: "native" } },
      { customType: SESSION_PROFILE_ENTRY, data: { version: 1, profile: null } },
    ]);
  });

  it("round-trips one hook result through Pi's session projection without rewriting raw messages", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { default: { prompt: "summarize {{conversation}}" } });
    fx.completions.push(assistantResponse("compact summary for the old request"));
    const session = SessionManager.inMemory(fx.cwd);
    const oldUserId = session.appendMessage({ role: "user", content: "old request to retain in summary", timestamp: 1 });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "prior answer" }],
      api: "openai-completions",
      provider: "chat",
      model: "chat-model",
      usage: usage(),
      stopReason: "stop",
      timestamp: 2,
    });
    const keptUserId = session.appendMessage({ role: "user", content: "newest user message stays visible", timestamp: 3 });
    const beforeMessages = session.buildSessionContext().messages;
    const sdkContext = { ...fx.context, sessionManager: session } as unknown as ExtensionContext;
    const hookEvent = event({
      preparation: preparation({
        firstKeptEntryId: keptUserId,
        messagesToSummarize: beforeMessages.slice(0, 2),
        tokensBefore: 41,
      }),
    });

    const hookResult = await fx.beforeCompact(hookEvent, sdkContext) as {
      compaction: { summary: string; firstKeptEntryId: string; tokensBefore: number; details: unknown; usage: ReturnType<typeof usage> };
    };
    expect(hookResult.compaction.firstKeptEntryId).toBe(keptUserId);
    expect(hookResult.compaction.summary).toContain("compact summary for the old request");
    session.appendCompaction(
      hookResult.compaction.summary,
      hookResult.compaction.firstKeptEntryId,
      hookResult.compaction.tokensBefore,
      hookResult.compaction.details,
      true,
      hookResult.compaction.usage,
    );

    const rebuilt = session.buildSessionContext().messages;
    expect(rebuilt.map((message) => message.role)).toEqual(["compactionSummary", "user"]);
    expect(rebuilt[0]).toMatchObject({ role: "compactionSummary", summary: hookResult.compaction.summary });
    expect(rebuilt[1]).toMatchObject({ role: "user", content: "newest user message stays visible" });
    expect(session.getEntry(oldUserId)).toMatchObject({ type: "message", message: { content: "old request to retain in summary" } });
  });

  it("passes a configured high thinking level to the alternate summarizer while chat thinking stays off", async () => {
    const fx = await fixture();
    fx.alternateModel.reasoning = true;
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer", thinkingLevel: "high" } });
    fx.streams.push(assistantResponse("high-reasoning alternate-model summary"));

    const result = await fx.beforeCompact(event(), fx.context) as { compaction: { summary: string } };

    expect(fx.context.thinkingLevel).toBe("off");
    expect(result.compaction.summary).toContain("high-reasoning alternate-model summary");
    expect(fx.modelRegistry.streamSimple).toHaveBeenCalledOnce();
    expect(fx.modelRegistry.streamSimple.mock.calls[0]![0]).toBe(fx.alternateModel);
    expect(fx.modelRegistry.streamSimple.mock.calls[0]![2]).toMatchObject({ reasoning: "high" });
  });

  it("inherits the chat thinking level for the compact summarizer when no profile level is set", async () => {
    const fx = await fixture();
    fx.alternateModel.reasoning = true;
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    fx.streams.push(assistantResponse("inherited-level summary"));
    const thinkingContext = { ...fx.context, thinkingLevel: "low" } as ExtensionContext;

    await fx.beforeCompact(event(), thinkingContext);

    expect(fx.modelRegistry.streamSimple.mock.calls[0]![2]).toMatchObject({ reasoning: "low" });

    fx.streams.push(assistantResponse("chat-off summary"));
    await fx.beforeCompact(event(), fx.context);
    expect("reasoning" in (fx.modelRegistry.streamSimple.mock.calls[1]![2] as object)).toBe(false);
  });

  it("lets an explicit off profile level beat an active chat thinking level", async () => {
    const fx = await fixture();
    fx.alternateModel.reasoning = true;
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer", thinkingLevel: "off" } });
    fx.streams.push(assistantResponse("no-reasoning summary"));
    const thinkingContext = { ...fx.context, thinkingLevel: "high" } as ExtensionContext;

    const result = await fx.beforeCompact(event(), thinkingContext) as { compaction: { summary: string } };

    expect(result.compaction.summary).toContain("no-reasoning summary");
    expect("reasoning" in (fx.modelRegistry.streamSimple.mock.calls[0]![2] as object)).toBe(false);
  });

  it("omits the reasoning request field when the selected summarizer model does not support reasoning", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer", thinkingLevel: "high" } });
    fx.streams.push(assistantResponse("non-reasoning model summary"));

    const result = await fx.beforeCompact(event(), fx.context) as { compaction: { summary: string } };

    expect(result.compaction.summary).toContain("non-reasoning model summary");
    expect("reasoning" in (fx.modelRegistry.streamSimple.mock.calls[0]![2] as object)).toBe(false);
  });

  it("applies the profile thinking level to replacement-prompt requests when the model supports reasoning", async () => {
    const fx = await fixture();
    fx.alternateModel.reasoning = true;
    await writeProjectConfig(fx.cwd, {
      default: { model: "other/summarizer", prompt: "summarize {{conversation}}", thinkingLevel: "high" },
    });
    fx.completions.push(assistantResponse("replacement-prompt high summary"));

    const result = await fx.beforeCompact(event(), fx.context) as { compaction: { summary: string } };

    expect(fx.context.thinkingLevel).toBe("off");
    expect(result.compaction.summary).toContain("replacement-prompt high summary");
    expect(fx.modelRegistry.complete.mock.calls[0]![2]).toMatchObject({ reasoning: "high" });
  });

  it("keeps replacement-prompt requests without a reasoning-capable model free of a reasoning field", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, {
      default: { prompt: "summarize {{conversation}}", thinkingLevel: "high" },
    });
    fx.completions.push(assistantResponse("chat-model prompt summary"));

    await fx.beforeCompact(event(), fx.context);

    expect(fx.modelRegistry.complete.mock.calls[0]![0]).toBe(fx.chatModel);
    expect("reasoning" in (fx.modelRegistry.complete.mock.calls[0]![2] as object)).toBe(false);
  });

  it("applies an explicit profile thinking level to typed pipeline LLM stages only when configured", async () => {
    const fx = await fixture();
    fx.alternateModel.reasoning = true;
    await writeProjectConfig(fx.cwd, {
      default: { model: "other/summarizer", thinkingLevel: "high", pipeline: { routes: { assistant: { prompt: "Keep decisions." } } } },
    });
    const session = SessionManager.inMemory(fx.cwd);
    session.appendMessage({ role: "user", content: "old request", timestamp: 1 });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "prior answer" }],
      api: "openai-completions",
      provider: "chat",
      model: "chat-model",
      usage: usage(),
      stopReason: "stop",
      timestamp: 2,
    });
    const kept = session.appendMessage({ role: "user", content: "retained tail", timestamp: 3 });
    const before = session.buildSessionContext().messages;
    const pipelineEvent = event({
      preparation: preparation({ firstKeptEntryId: kept, messagesToSummarize: before.slice(0, 2) }),
      branchEntries: session.getBranch(),
    });
    const sdkContext = { ...fx.context, sessionManager: session } as unknown as ExtensionContext;
    fx.streams.push(assistantResponse("user stage summary"), assistantResponse("assistant stage summary"));

    const result = await fx.beforeCompact(pipelineEvent, sdkContext) as { compaction: { summary: string } };

    expect(result.compaction.summary).toContain("user stage summary");
    expect(fx.modelRegistry.streamSimple).toHaveBeenCalledTimes(2);
    expect(fx.modelRegistry.streamSimple.mock.calls
      .every((call) => (call[2] as { reasoning?: string }).reasoning === "high")).toBe(true);
  });

  it("leaves typed pipeline stage requests unchanged when no thinking level is configured", async () => {
    const fx = await fixture();
    fx.alternateModel.reasoning = true;
    await writeProjectConfig(fx.cwd, {
      default: { model: "other/summarizer", pipeline: { routes: { assistant: { prompt: "Keep decisions." } } } },
    });
    const session = SessionManager.inMemory(fx.cwd);
    session.appendMessage({ role: "user", content: "old request", timestamp: 1 });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "prior answer" }],
      api: "openai-completions",
      provider: "chat",
      model: "chat-model",
      usage: usage(),
      stopReason: "stop",
      timestamp: 2,
    });
    const kept = session.appendMessage({ role: "user", content: "retained tail", timestamp: 3 });
    const before = session.buildSessionContext().messages;
    const pipelineEvent = event({
      preparation: preparation({ firstKeptEntryId: kept, messagesToSummarize: before.slice(0, 2) }),
      branchEntries: session.getBranch(),
    });
    const sdkContext = { ...fx.context, thinkingLevel: "low", sessionManager: session } as unknown as ExtensionContext;
    fx.streams.push(assistantResponse("user stage summary"), assistantResponse("assistant stage summary"));

    await fx.beforeCompact(pipelineEvent, sdkContext);

    expect(fx.modelRegistry.streamSimple).toHaveBeenCalledTimes(2);
    expect(fx.modelRegistry.streamSimple.mock.calls
      .every((call) => !("reasoning" in (call[2] as object)))).toBe(true);
  });

  it("does not intercept compaction for a thinking-level-only profile", async () => {
    const fx = await fixture();
    await writeProjectConfig(fx.cwd, { default: { thinkingLevel: "high" } });

    await expect(fx.beforeCompact(event(), fx.context)).resolves.toBeUndefined();
    expect(fx.modelRegistry.find).not.toHaveBeenCalled();
    expect(fx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(fx.modelRegistry.complete).not.toHaveBeenCalled();
  });
});

function compactEvent(summary: string, fromExtension: boolean, reason: "manual" | "threshold" | "overflow" = "manual") {
  return {
    type: "session_compact",
    compactionEntry: { type: "compaction", summary, fromHook: fromExtension },
    fromExtension,
    reason,
    willRetry: false,
  };
}

function compactFailedEvent(reason: "manual" | "threshold" | "overflow" = "manual") {
  return { type: "session_compact_failed", reason, aborted: true, willRetry: false, fromExtension: false };
}

async function emit(fx: Awaited<ReturnType<typeof fixture>>, name: string, event: unknown): Promise<void> {
  const handler = fx.handlers.get(name);
  if (!handler) throw new Error(`Extension did not register a ${name} handler`);
  await handler(event, fx.context);
}

describe("compact activity status", () => {
  it("never shows a plugin status for zero-config or explicit native pass-through", async () => {
    const fx = await fixture({ mode: "tui" });
    for (const reason of ["manual", "threshold", "overflow"] as const) {
      await expect(fx.beforeCompact(event({ reason }), fx.context)).resolves.toBeUndefined();
    }
    await writeProjectConfig(fx.cwd, { default: { mode: "native" } });
    await expect(fx.beforeCompact(event(), fx.context)).resolves.toBeUndefined();
    await emit(fx, "session_compact", compactEvent("native summary", false, "threshold"));
    await emit(fx, "session_compact_failed", compactFailedEvent("overflow"));
    expect(fx.ui.setStatus).not.toHaveBeenCalled();
    expect(fx.ui.notify).not.toHaveBeenCalled();
  });

  it("shows Auto compact with the selected model while a configured model-only summarizer runs", async () => {
    const fx = await fixture({ mode: "tui" });
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    let release!: (value: ReturnType<typeof assistantResponse>) => void;
    const gated = new Promise<ReturnType<typeof assistantResponse>>((resolve) => { release = resolve; });
    fx.modelRegistry.streamSimple = vi.fn(() => ({ result: () => gated }));

    const operation = fx.beforeCompact(event({ reason: "threshold" }), fx.context);
    await vi.waitFor(() => expect(fx.ui.setStatus).toHaveBeenCalledWith("pi-simple-compact", "Auto compact (summarizer)"));
    expect(fx.ui.setStatus).toHaveBeenCalledTimes(1);

    release(assistantResponse("delayed native-prompt summary"));
    const result = await operation as { compaction: { summary: string } };
    expect(result.compaction.summary).toContain("delayed native-prompt summary");
    // The transient status stays visible until Pi confirms the persisted compaction.
    expect(fx.ui.setStatus).toHaveBeenCalledTimes(1);
    expect(fx.ui.notify).not.toHaveBeenCalled();
  });

  it("uses a distinct Manual label only while running and clears it after Pi persists the result", async () => {
    const fx = await fixture({ mode: "tui" });
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    fx.streams.push(assistantResponse("manual compact summary"));

    const result = await fx.beforeCompact(event({ reason: "manual" }), fx.context) as { compaction: { summary: string } };
    expect(fx.ui.setStatus).toHaveBeenCalledTimes(1);
    expect(fx.ui.setStatus).toHaveBeenCalledWith("pi-simple-compact", "Manual compact (summarizer)");

    await emit(fx, "session_compact", compactEvent(result.compaction.summary, true, "manual"));
    expect(fx.ui.setStatus).toHaveBeenLastCalledWith("pi-simple-compact", undefined);
    expect(fx.ui.setStatus).toHaveBeenCalledTimes(2);
    expect(fx.ui.notify).not.toHaveBeenCalled();
  });

  it("leaves no footer after success, native pass-through, or a later session shutdown", async () => {
    const fx = await fixture({ mode: "tui" });
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    fx.streams.push(assistantResponse("earlier configured summary"));
    const result = await fx.beforeCompact(event(), fx.context) as { compaction: { summary: string } };
    await emit(fx, "session_compact", compactEvent(result.compaction.summary, true));
    expect(fx.ui.setStatus).toHaveBeenLastCalledWith("pi-simple-compact", undefined);

    await writeProjectConfig(fx.cwd, { default: { mode: "native" } });
    await expect(fx.beforeCompact(event({ reason: "threshold" }), fx.context)).resolves.toBeUndefined();
    await emit(fx, "session_compact", compactEvent("native summary", false, "threshold"));
    await emit(fx, "session_shutdown", { type: "session_shutdown", reason: "new" });
    expect(fx.ui.setStatus).toHaveBeenCalledTimes(2);
    expect(fx.ui.notify).not.toHaveBeenCalled();
  });

  it("labels a whole-prompt profile without a model override with the current chat model id", async () => {
    const fx = await fixture({ mode: "tui" });
    await writeProjectConfig(fx.cwd, { default: { prompt: "summarize {{conversation}}" } });
    fx.completions.push(assistantResponse("replacement-prompt summary"));

    const result = await fx.beforeCompact(event({ reason: "overflow" }), fx.context) as { compaction: { summary: string } };
    expect(fx.ui.setStatus).toHaveBeenCalledWith("pi-simple-compact", "Auto compact (chat-model)");
    await emit(fx, "session_compact", compactEvent(result.compaction.summary, true, "overflow"));
    expect(fx.ui.setStatus).toHaveBeenLastCalledWith("pi-simple-compact", undefined);
    expect(fx.ui.notify).not.toHaveBeenCalled();
  });

  it("preserves the selected model ID's case in the running status", async () => {
    const fx = await fixture({ mode: "tui" });
    await writeProjectConfig(fx.cwd, { default: { prompt: "summarize {{conversation}}" } });
    fx.completions.push(assistantResponse("case-sensitive model summary"));
    const mixedCaseContext = { ...fx.context, model: { ...fx.chatModel, id: "Model-MiX-2" } } as ExtensionContext;
    const result = await fx.beforeCompact(event({ reason: "threshold" }), mixedCaseContext) as { compaction: { summary: string } };
    expect(fx.ui.setStatus).toHaveBeenCalledWith("pi-simple-compact", "Auto compact (Model-MiX-2)");
    await emit(fx, "session_compact", compactEvent(result.compaction.summary, true, "threshold"));
    expect(fx.ui.setStatus).toHaveBeenLastCalledWith("pi-simple-compact", undefined);
  });

  it("names a pipeline's single actual LLM model", async () => {
    const fx = await fixture({ mode: "tui" });
    await writeProjectConfig(fx.cwd, { default: { pipeline: { model: "other/summarizer" } } });
    const session = SessionManager.inMemory(fx.cwd);
    session.appendMessage({ role: "user", content: "old request", timestamp: 1 });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "prior answer" }],
      api: "openai-completions",
      provider: "chat",
      model: "chat-model",
      usage: usage(),
      stopReason: "stop",
      timestamp: 2,
    });
    const kept = session.appendMessage({ role: "user", content: "retained tail", timestamp: 3 });
    const before = session.buildSessionContext().messages;
    const pipelineEvent = event({
      reason: "manual",
      preparation: preparation({ firstKeptEntryId: kept, messagesToSummarize: before.slice(0, 2) }),
      branchEntries: session.getBranch(),
    });
    const sdkContext = { ...fx.context, sessionManager: session } as unknown as ExtensionContext;
    fx.streams.push(assistantResponse("user stage summary"), assistantResponse("assistant stage summary"));

    const result = await fx.beforeCompact(pipelineEvent, sdkContext) as { compaction: { summary: string } };
    expect(fx.ui.setStatus).toHaveBeenCalledWith("pi-simple-compact", "Manual compact (summarizer)");
    expect(fx.modelRegistry.streamSimple).toHaveBeenCalledTimes(2);
    expect(fx.modelRegistry.streamSimple.mock.calls.every((call) => call[0] === fx.alternateModel)).toBe(true);
    await emit(fx, "session_compact", compactEvent(result.compaction.summary, true, "manual"));
    expect(fx.ui.setStatus).toHaveBeenLastCalledWith("pi-simple-compact", undefined);
    expect(fx.ui.notify).not.toHaveBeenCalled();
  });

  it("does not claim a single model when a typed pipeline routes two different models", async () => {
    const fx = await fixture({ mode: "tui" });
    await writeProjectConfig(fx.cwd, {
      default: {
        pipeline: {
          routes: {
            user: { model: "other/summarizer" },
            assistant: { model: "chat/chat-model" },
          },
        },
      },
    });
    const session = SessionManager.inMemory(fx.cwd);
    session.appendMessage({ role: "user", content: "old request", timestamp: 1 });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "prior answer" }],
      api: "openai-completions",
      provider: "chat",
      model: "chat-model",
      usage: usage(),
      stopReason: "stop",
      timestamp: 2,
    });
    const kept = session.appendMessage({ role: "user", content: "retained tail", timestamp: 3 });
    const before = session.buildSessionContext().messages;
    const pipelineEvent = event({
      reason: "threshold",
      preparation: preparation({ firstKeptEntryId: kept, messagesToSummarize: before.slice(0, 2) }),
      branchEntries: session.getBranch(),
    });
    const sdkContext = { ...fx.context, sessionManager: session } as unknown as ExtensionContext;
    fx.streams.push(assistantResponse("user stage summary"), assistantResponse("assistant stage summary"));

    await fx.beforeCompact(pipelineEvent, sdkContext);
    const label = fx.ui.setStatus.mock.calls[0]![1] as string;
    expect(label).toBe("Auto compact (pipeline, multiple models)");
    expect(label).not.toContain("summarizer");
    expect(label).not.toContain("chat-model");
    const stageModels = fx.modelRegistry.streamSimple.mock.calls.map((call) => `${(call[0] as { provider: string }).provider}/${(call[0] as { id: string }).id}`);
    expect(new Set(stageModels)).toEqual(new Set(["other/summarizer", "chat/chat-model"]));
  });

  it("labels an all-local reducer pipeline truthfully", async () => {
    const fx = await fixture({ mode: "tui" });
    await writeProjectConfig(fx.cwd, {
      default: { pipeline: { routes: { user: { reducer: "deterministic-facts" }, assistant: { reducer: "deterministic-facts" } } } },
    });
    const session = SessionManager.inMemory(fx.cwd);
    session.appendMessage({ role: "user", content: "old request", timestamp: 1 });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "prior answer" }],
      api: "openai-completions",
      provider: "chat",
      model: "chat-model",
      usage: usage(),
      stopReason: "stop",
      timestamp: 2,
    });
    const kept = session.appendMessage({ role: "user", content: "retained tail", timestamp: 3 });
    const before = session.buildSessionContext().messages;
    const pipelineEvent = event({
      reason: "threshold",
      preparation: preparation({ firstKeptEntryId: kept, messagesToSummarize: before.slice(0, 2) }),
      branchEntries: session.getBranch(),
    });
    const sdkContext = { ...fx.context, sessionManager: session } as unknown as ExtensionContext;

    await fx.beforeCompact(pipelineEvent, sdkContext);
    expect(fx.ui.setStatus).toHaveBeenCalledWith("pi-simple-compact", "Auto compact (pipeline, local reducers)");
    expect(fx.modelRegistry.streamSimple).not.toHaveBeenCalled();
    expect(fx.modelRegistry.complete).not.toHaveBeenCalled();
  });

  it("clears the status on fail-closed failures without claiming success", async () => {
    const fx = await fixture({ mode: "tui" });
    await writeProjectConfig(fx.cwd, { default: { prompt: "summarize {{conversation}}" } });
    fx.completions.push(assistantResponse("", "stop"));

    await expect(fx.beforeCompact(event(), fx.context)).resolves.toEqual({ cancel: true });
    expect(fx.ui.setStatus).toHaveBeenCalledWith("pi-simple-compact", "Manual compact (chat-model)");
    await emit(fx, "session_compact_failed", compactFailedEvent("manual"));
    expect(fx.ui.setStatus).toHaveBeenLastCalledWith("pi-simple-compact", undefined);
    expect(fx.ui.notify.mock.calls.flat().join(" ")).not.toContain("complete");
  });

  it("clears the status on cancellation", async () => {
    const fx = await fixture({ mode: "tui" });
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    const aborted = new AbortController();
    aborted.abort();

    await expect(fx.beforeCompact(event({ signal: aborted.signal }), fx.context)).resolves.toEqual({ cancel: true });
    expect(fx.ui.setStatus).toHaveBeenCalledWith("pi-simple-compact", "Manual compact (summarizer)");
    await emit(fx, "session_compact_failed", compactFailedEvent("manual"));
    expect(fx.ui.setStatus).toHaveBeenLastCalledWith("pi-simple-compact", undefined);
    expect(fx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("complete"), "info");
  });

  it("clears the status without a success notice when an explicit native fallback completes natively", async () => {
    const fx = await fixture({ mode: "tui" });
    await writeProjectConfig(fx.cwd, { default: { prompt: "summarize {{conversation}}", failurePolicy: "native" } });
    fx.completions.push(assistantResponse("partial", "length"));

    await expect(fx.beforeCompact(event({ reason: "threshold" }), fx.context)).resolves.toBeUndefined();
    expect(fx.ui.setStatus).toHaveBeenCalledWith("pi-simple-compact", "Auto compact (chat-model)");
    await emit(fx, "session_compact", compactEvent("pi native summary", false, "threshold"));
    expect(fx.ui.setStatus).toHaveBeenLastCalledWith("pi-simple-compact", undefined);
    // The fallback is announced once as a warning, never as a success.
    expect(fx.ui.notify).toHaveBeenCalledOnce();
    expect(fx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("failurePolicy is native"), "warning");
  });

  it("clears the status when another extension's result is persisted instead of ours", async () => {
    const fx = await fixture({ mode: "tui" });
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    fx.streams.push(assistantResponse("our summary"));
    await fx.beforeCompact(event(), fx.context);
    await emit(fx, "session_compact", compactEvent("a later extension's different summary", true, "manual"));
    expect(fx.ui.setStatus).toHaveBeenLastCalledWith("pi-simple-compact", undefined);
    expect(fx.ui.notify).not.toHaveBeenCalled();
  });

  it("clears the status on session shutdown and stays silent afterwards", async () => {
    const fx = await fixture({ mode: "tui" });
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    let release!: (value: ReturnType<typeof assistantResponse>) => void;
    const gated = new Promise<ReturnType<typeof assistantResponse>>((resolve) => { release = resolve; });
    fx.modelRegistry.streamSimple = vi.fn(() => ({ result: () => gated }));

    const operation = fx.beforeCompact(event(), fx.context);
    await vi.waitFor(() => expect(fx.ui.setStatus).toHaveBeenCalledTimes(1));
    await emit(fx, "session_shutdown", { type: "session_shutdown", reason: "reload" });
    expect(fx.ui.setStatus).toHaveBeenLastCalledWith("pi-simple-compact", undefined);
    release(assistantResponse("late summary"));
    const result = await operation as { compaction: { summary: string } };
    await emit(fx, "session_compact", compactEvent(result.compaction.summary, true, "manual"));
    expect(fx.ui.setStatus).toHaveBeenCalledTimes(2);
    expect(fx.ui.notify).not.toHaveBeenCalled();
  });

  it("ignores compact outcomes when no custom attempt is active", async () => {
    const fx = await fixture({ mode: "tui" });
    await emit(fx, "session_compact", compactEvent("native summary", false, "manual"));
    await emit(fx, "session_compact", compactEvent("other extension summary", true, "threshold"));
    await emit(fx, "session_compact_failed", compactFailedEvent("overflow"));
    await emit(fx, "session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(fx.ui.setStatus).not.toHaveBeenCalled();
    expect(fx.ui.notify).not.toHaveBeenCalled();
  });

  it("emits no TUI-only status or notice in rpc, json, and print modes", async () => {
    for (const mode of ["rpc", "json", "print"] as const) {
      const fx = await fixture({ mode });
      await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
      fx.streams.push(assistantResponse("mode-gated summary"));
      const result = await fx.beforeCompact(event({ reason: "threshold" }), fx.context) as { compaction: { summary: string } };
      expect(result.compaction.summary).toContain("mode-gated summary");
      await emit(fx, "session_compact", compactEvent(result.compaction.summary, true, "threshold"));
      expect(fx.ui.setStatus, `mode=${mode}`).not.toHaveBeenCalled();
      expect(fx.ui.notify, `mode=${mode}`).not.toHaveBeenCalled();
    }
  });

  it("keeps compaction results intact when UI calls fail", async () => {
    const fx = await fixture({ mode: "tui" });
    await writeProjectConfig(fx.cwd, { default: { model: "other/summarizer" } });
    fx.streams.push(assistantResponse("summary despite broken footer"));
    const brokenStatusUi = { notify: vi.fn(), setStatus: vi.fn(() => { throw new Error("footer unavailable"); }) };

    const result = await fx.beforeCompact(event(), { ...fx.context, ui: brokenStatusUi } as unknown as ExtensionContext) as { compaction: { summary: string } };
    expect(result.compaction.summary).toContain("summary despite broken footer");
    expect(brokenStatusUi.setStatus).toHaveBeenCalledTimes(1);

    const brokenCompletionUi = { notify: vi.fn(), setStatus: vi.fn(() => { throw new Error("footer unavailable"); }) };
    const compactHandler = fx.handlers.get("session_compact")!;
    expect(() => compactHandler(compactEvent(result.compaction.summary, true, "manual"), {
      ...fx.context,
      ui: brokenCompletionUi,
    } as unknown as ExtensionContext)).not.toThrow();
    expect(brokenCompletionUi.setStatus).toHaveBeenCalledWith("pi-simple-compact", undefined);
  });
});
