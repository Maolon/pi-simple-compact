/**
 * Test-only Pi extension for the tmux end-to-end suite. It registers two deterministic,
 * offline providers so a real Pi TUI can chat and compact without credentials or network:
 *
 * - `e2e-chat/chat`: the chat model. It acknowledges prompts and, when Pi asks it for a native
 *   compaction summary, answers with a recognizable native summary.
 * - `e2e-chat/small`: the same chat behavior with a tiny context window, so Pi's automatic
 *   threshold compaction triggers after a turn or two.
 * - `e2e-summary/summary`: an alternate summarizer that is slow enough for the TUI status to be
 *   captured while compaction runs.
 * - `e2e-summary/broken`: an alternate summarizer that always ends with a provider error.
 *
 * Never load this file outside tests.
 */
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SUMMARY_DELAY_MS = Number(process.env.PSC_E2E_SUMMARY_DELAY_MS ?? "1500");

function lastUserText(context: Parameters<FauxResponseFactory>[0]): string {
  for (let index = context.messages.length - 1; index >= 0; index--) {
    const message = context.messages[index]!;
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  }
  return "";
}

/** Compaction requests: Pi's native prompt wraps history in <conversation>; extension requests carry their own markers. */
function isSummaryRequest(context: Parameters<FauxResponseFactory>[0]): boolean {
  const text = lastUserText(context);
  return text.includes("<conversation>") || text.includes("Typed stage payload");
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

const chatResponses: FauxResponseFactory = (context) => {
  if (isSummaryRequest(context)) return fauxAssistantMessage("E2E-NATIVE-SUMMARY from e2e-chat/chat");
  const prompt = lastUserText(context).replace(/\s+/g, " ").trim().slice(0, 40);
  return fauxAssistantMessage(`ACK ${prompt}`);
};

const summaryResponses: FauxResponseFactory = async (context, options, _state, model) => {
  if (model.id === "broken") {
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "e2e provider failure" });
  }
  await sleep(SUMMARY_DELAY_MS, options?.signal);
  const kind = isSummaryRequest(context) ? "summary" : "unexpected";
  return fauxAssistantMessage(`E2E-ALT-SUMMARY (${kind}) from e2e-summary/${model.id}`);
};

/** Faux providers consume one scripted step per request; keep a long queue of the same factory. */
function repeat(factory: FauxResponseFactory): FauxResponseFactory[] {
  return Array.from({ length: 500 }, () => factory);
}

export default function (pi: ExtensionAPI): void {
  const chat = fauxProvider({
    provider: "e2e-chat",
    api: "e2e-chat-api",
    models: [
      { id: "chat", contextWindow: 200_000, maxTokens: 8_192 },
      { id: "small", contextWindow: 6_000, maxTokens: 1_024 },
    ],
  });
  chat.setResponses(repeat(chatResponses));
  const summary = fauxProvider({
    provider: "e2e-summary",
    api: "e2e-summary-api",
    models: [
      { id: "summary", contextWindow: 200_000, maxTokens: 8_192 },
      { id: "broken", contextWindow: 200_000, maxTokens: 8_192 },
    ],
  });
  summary.setResponses(repeat(summaryResponses));
  pi.registerProvider(chat.provider);
  pi.registerProvider(summary.provider);
}
