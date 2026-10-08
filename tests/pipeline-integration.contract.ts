import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  appendConversation,
  createOfflineCompactionHarness,
  fauxAssistantMessage,
  getCompactionEntries,
  OFFLINE_SUMMARIZER_MODEL_ID,
  OFFLINE_SUMMARIZER_PROVIDER_ID,
} from "./offline-compaction-harness.ts";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { registerSimpleCompact } from "../src/index.ts";

function extension(paths: { cwd: string; agentDir: string }): InlineExtension {
  return {
    name: "compact-pipeline-model-fallback-test",
    hidden: true,
    factory(pi: ExtensionAPI) {
      registerSimpleCompact(pi, undefined, { agentDir: paths.agentDir });
    },
  };
}

test("nested pipeline inherits the profile top-level model as its LLM-stage fallback", async () => {
  const harness = await createOfflineCompactionHarness({
    keepRecentTokens: 8,
    createExtensions: (paths) => [extension(paths)],
  });
  try {
    const piDir = join(harness.cwd, ".pi");
    await mkdir(piDir, { recursive: true });
    await writeFile(join(piDir, "settings.json"), "{}", "utf8");
    await writeFile(join(piDir, "pi-simple-compact.json"), JSON.stringify({
      default: {
        model: `${OFFLINE_SUMMARIZER_PROVIDER_ID}/${OFFLINE_SUMMARIZER_MODEL_ID}`,
        pipeline: { routes: { user: { prompt: "Preserve this user request." } } },
      },
    }), "utf8");
    appendConversation(harness, [
      { user: "PIPELINE_TOP_LEVEL_MODEL_FALLBACK_REQUEST_".repeat(3), assistant: "assistant fact one" },
      { user: "retained recent user request", assistant: "retained recent assistant response" },
    ]);
    harness.summarizerProvider.setResponses([
      () => fauxAssistantMessage("SUMMARY_MODEL_USER_STAGE"),
      () => fauxAssistantMessage("SUMMARY_MODEL_ASSISTANT_STAGE"),
    ]);
    const chatModel = harness.session.model;

    const result = await harness.session.compact();

    assert.ok(getCompactionEntries(harness).at(-1)?.fromHook);
    assert.match(result.summary, /SUMMARY_MODEL_USER_STAGE/);
    assert.match(result.summary, /SUMMARY_MODEL_ASSISTANT_STAGE/);
    assert.equal(harness.summarizerProvider.state.callCount, 2);
    assert.equal(harness.provider.state.callCount, 0);
    assert.equal(harness.session.model, chatModel);
  } finally {
    await harness.close();
  }
});
