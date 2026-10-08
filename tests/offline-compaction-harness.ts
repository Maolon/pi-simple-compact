import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type CompactionEntry,
  type ExtensionAPI,
  type ExtensionContext,
  type FileEntry,
  type InlineExtension,
  type SessionBeforeCompactEvent,
  type SessionBeforeCompactResult,
  type SessionCompactEvent,
  type SessionCompactFailedEvent,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
  type FauxResponseStep,
  type Usage,
} from "@earendil-works/pi-ai";

export const OFFLINE_PROVIDER_ID = "pi-compact-contract-offline";
export const OFFLINE_MODEL_ID = "contract-model";
export const OFFLINE_SUMMARIZER_PROVIDER_ID = "pi-compact-contract-summarizer";
export const OFFLINE_SUMMARIZER_MODEL_ID = "summary-model";

export interface ContractHookCallbacks {
  beforeCompact?: (
    event: SessionBeforeCompactEvent,
    context: ExtensionContext,
  ) => SessionBeforeCompactResult | void | Promise<SessionBeforeCompactResult | void>;
  compact?: (event: SessionCompactEvent, context: ExtensionContext) => void | Promise<void>;
  compactFailed?: (event: SessionCompactFailedEvent, context: ExtensionContext) => void | Promise<void>;
}

/**
 * A minimal inline extension for observing Pi's public compaction lifecycle.
 * It deliberately contains no compaction policy; callbacks are supplied by tests.
 */
export function createCompactionContractExtension(callbacks: ContractHookCallbacks): InlineExtension {
  return {
    name: "offline-compaction-contract",
    hidden: true,
    factory(pi: ExtensionAPI) {
      if (callbacks.beforeCompact) pi.on("session_before_compact", callbacks.beforeCompact);
      if (callbacks.compact) pi.on("session_compact", callbacks.compact);
      if (callbacks.compactFailed) pi.on("session_compact_failed", callbacks.compactFailed);
    },
  };
}

export interface OfflineCompactionHarnessOptions {
  extensions?: InlineExtension[];
  createExtensions?: (paths: { cwd: string; agentDir: string }) => InlineExtension[];
  keepRecentTokens?: number;
  projectTrusted?: boolean;
  sessionEntries?: FileEntry[];
  responses?: FauxResponseStep[];
}

export interface OfflineCompactionHarness {
  cwd: string;
  agentDir: string;
  modelRuntime: ModelRuntime;
  model: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  summarizerModel: NonNullable<ReturnType<ModelRuntime["getModel"]>>;
  provider: FauxProviderHandle;
  summarizerProvider: FauxProviderHandle;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  /** Dispose Pi resources and remove the isolated temporary workspace. */
  close(): Promise<void>;
}

/**
 * Build a real Pi 0.87.x AgentSession with in-memory history/settings and the
 * package's deterministic faux provider. No user Pi directory or live provider
 * credential is read, and all auth/stream behavior remains offline.
 */
export async function createOfflineCompactionHarness(
  options: OfflineCompactionHarnessOptions = {},
): Promise<OfflineCompactionHarness> {
  const root = await mkdtemp(join(tmpdir(), "pi-compact-contract-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(agentDir, { recursive: true })]);

  let session: OfflineCompactionHarness["session"] | undefined;
  try {
    const provider = fauxProvider({
      provider: OFFLINE_PROVIDER_ID,
      api: `${OFFLINE_PROVIDER_ID}-api`,
      models: [{ id: OFFLINE_MODEL_ID, contextWindow: 32_000, maxTokens: 2_048 }],
      tokenSize: { min: 8, max: 8 },
    });
    const summarizerProvider = fauxProvider({
      provider: OFFLINE_SUMMARIZER_PROVIDER_ID,
      api: `${OFFLINE_SUMMARIZER_PROVIDER_ID}-api`,
      models: [{ id: OFFLINE_SUMMARIZER_MODEL_ID, contextWindow: 32_000, maxTokens: 2_048, reasoning: true }],
      tokenSize: { min: 8, max: 8 },
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(provider.provider);
    modelRuntime.registerNativeProvider(summarizerProvider.provider);
    const model = modelRuntime.getModel(OFFLINE_PROVIDER_ID, OFFLINE_MODEL_ID);
    const summarizerModel = modelRuntime.getModel(OFFLINE_SUMMARIZER_PROVIDER_ID, OFFLINE_SUMMARIZER_MODEL_ID);
    if (!model) throw new Error("Offline faux model was not registered with ModelRuntime");
    if (!summarizerModel) throw new Error("Offline faux summarizer model was not registered with ModelRuntime");

    const settingsManager = SettingsManager.inMemory({
      defaultTools: [],
      compaction: {
        enabled: true,
        reserveTokens: 256,
        keepRecentTokens: options.keepRecentTokens ?? 8,
      },
      retry: { enabled: false, maxRetries: 0 },
    }, { projectTrusted: options.projectTrusted ?? true });
    const sessionManager = SessionManager.inMemory(cwd, undefined, options.sessionEntries);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [
        ...(options.extensions ?? []),
        ...(options.createExtensions?.({ cwd, agentDir }) ?? []),
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const created = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      settingsManager,
      sessionManager,
      resourceLoader,
      noTools: "all",
      thinkingLevel: "off",
    });
    session = created.session;
    if (options.responses) provider.setResponses(options.responses);

    return {
      cwd,
      agentDir,
      modelRuntime,
      model,
      summarizerModel,
      provider,
      summarizerProvider,
      sessionManager,
      settingsManager,
      session,
      async close() {
        session?.dispose();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    session?.dispose();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export function appendUserMessage(harness: OfflineCompactionHarness, text: string): string {
  return harness.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
}

export function appendAssistantMessage(harness: OfflineCompactionHarness, text: string): string {
  return harness.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: harness.model.api,
    provider: harness.model.provider,
    model: harness.model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

export function appendConversation(
  harness: OfflineCompactionHarness,
  turns: Array<{ user: string; assistant: string }>,
): string[] {
  return turns.flatMap(({ user, assistant }) => [
    appendUserMessage(harness, user),
    appendAssistantMessage(harness, assistant),
  ]);
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function usage(input: number, output: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function getCompactionEntries(harness: OfflineCompactionHarness): CompactionEntry[] {
  return harness.sessionManager.getEntries().filter((entry): entry is CompactionEntry => entry.type === "compaction");
}

export { fauxAssistantMessage };
