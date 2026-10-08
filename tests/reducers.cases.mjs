import test from "node:test";
import assert from "node:assert/strict";
import { deterministicFactsReducer } from "../src/reducers.ts";

test("deterministic facts reducer keeps first occurrence order and shared capsule", () => {
  const result = deterministicFactsReducer({
    kind: "user",
    items: [
      { kind: "user", entryId: "e1", ordinal: 0, timestamp: 1, text: "Keep the exact path." },
      { kind: "user", entryId: "e2", ordinal: 1, timestamp: 2, text: "Keep the exact path." },
      { kind: "user", entryId: "e3", ordinal: 2, timestamp: 3, text: "Don't change the API." },
    ],
    toolInteractions: [],
  }, {
    previousSummary: "Prior project goal.",
    manualFocus: "Preserve decisions.",
    taskCapsule: { entryId: "e1", text: "Keep the exact path.", truncated: false },
    splitPrefix: "[assistant] Retained split prefix.",
  }, new AbortController().signal);

  assert.equal(result, [
    "Current user task from e1:\nKeep the exact path.",
    "Prior summary context:\nPrior project goal.",
    "Manual focus:\nPreserve decisions.",
    "Split-turn prefix context:\n[assistant] Retained split prefix.",
    "Exact user facts:\n- Keep the exact path.\n- Don't change the API.",
  ].join("\n\n"));
});

test("deterministic facts reducer honors cancellation", () => {
  const controller = new AbortController();
  controller.abort(new Error("cancel reducer"));
  assert.throws(() => deterministicFactsReducer({ kind: "user", items: [], toolInteractions: [] }, { splitPrefix: "" }, controller.signal), /cancel reducer/);
});
