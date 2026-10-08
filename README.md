# pi-simple-compact

A compact-only Pi extension for **@earendil-works/pi-coding-agent 0.87.1**. It is inert by default: when no profile applies, its `session_before_compact` handler returns `undefined` so Pi runs its own compaction path. It does not change the chat model, trigger thresholds, session messages, other hooks, or `/tree` branch summaries.

## Development checks

```sh
npm install
npm run typecheck
npm test
```

Tests use fake/offline model-registry responses and the Pi SDK's in-memory `SessionManager`. They do not call a provider, inspect live sessions, or install the extension into Pi's live extension directory.

## Local opt-in

For a one-off local load, use Pi's explicit extension flag with this repository's source file:

```sh
pi --extension /absolute/path/to/pi-simple-compact/src/index.ts
```

No live activation or global installation is performed by this package. Profiles are opt-in JSON files:

- User: `~/.pi/agent/pi-simple-compact.json`
- Project: `<project>/.pi/pi-simple-compact.json` (read only when `ctx.isProjectTrusted()` is true **and** `<project>/.pi/settings.json` exists)

The user file is always eligible. Project-local compact profiles are read only when both `ctx.isProjectTrusted()` is true and `.pi/settings.json` exists, using that Pi-recognized companion to ensure a lone extension-specific file cannot opt itself into project trust. The same check applies to `/compact-profile` named-profile lookup. This applies to an explicitly loaded `-e` extension too: Pi resolves project trust before compaction handlers run, and the public getter reflects that session trust state.

Example:

```json
{
  "default": {
    "model": "google/gemini-2.5-flash",
    "failurePolicy": "fail"
  },
  "models": {
    "anthropic/claude-sonnet-4": {
      "model": "google/gemini-3.8-flash",
      "thinkingLevel": "high"
    }
  },
  "profiles": {
    "focused": {
      "model": "google/gemini-2.5-flash",
      "prompt": "Summarize the history: {{conversation}}\nPrior summary: {{previousSummary}}\nFocus: {{customInstructions}}"
    }
  }
}
```

A model is an exact, case-sensitive `provider/modelId` resolved through Pi's model registry. It only selects the compaction summarizer; it never calls `pi.setModel()` or alters Pi's chat model. The registry resolves provider authentication when making the request. Choosing another provider sends the discarded conversation/tool material needed for that compact job to that provider; configure and trust it accordingly.

### Profile precedence and session selection

Settings resolve **per field** from highest to lowest priority:

1. named profile selected in the active session;
2. project exact-chat-model override;
3. user exact-chat-model override;
4. project default;
5. user default;
6. Pi native behavior.

Use `/compact-profile focused` to select a named profile in the current session branch, `/compact-profile native` to explicitly yield compaction to Pi, and `/compact-profile reset` to append a reset marker and inherit settings again. The extension stores this small state as a Pi custom session entry; it is not added to model context. Branch switches naturally follow the active branch, and session reload reads the branch's entries. Named profiles must be present in either config file before selecting them.

An explicit `"mode": "native"` on the highest-priority profile suppresses inherited profile settings. With no `model`, `prompt`, or `pipeline`, configuration does not intercept compaction (a `thinkingLevel`-only profile therefore stays native; the level decorates a configured summarizer). A model-only profile calls Pi's exported `compact(preparation, ...)` helper and uses `ModelRegistry.streamSimple`, preserving Pi's prompt, split-turn behavior, boundary, and file-operation details. For a split turn only, after Pi returns, the extension annotates its uniquely recognized history/turn-prefix separator with `[HISTORY]` (messages before the split turn) and `[TURN_PREFIX]` (the earlier part of that turn, before retained messages). These are **source labels, not reliability rankings**: a turn prefix can quote an outdated task. The note asks the model to resolve status conflicts using explicit completion evidence and retained messages, not section order alone. The Pi-generated section text, usage, file tags, and retained boundary are not rewritten; unknown or ambiguous separator formats pass through unchanged. The labels do not reconcile contradictions or trigger another model request. Zero-config/native pass-through and non-split results remain unmodified. Existing session summaries with the former `[PREV]`/`[RECENT]` labels are not rewritten; `/reload` applies this change to future eligible compactions. A conservative preflight rejects prepared spans that cannot fit the selected model's estimated input budget; this native-helper path is not chunked. A missing prompt therefore never substitutes an extension-owned prompt.

### Compact-only thinking level

A profile may set `thinkingLevel` to one of Pi's levels — `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` — for the compaction summarizer request only. Invalid values are rejected at config load (compaction is canceled rather than silently degraded). The field resolves per field with the same precedence as `model` and `prompt`, and it applies **only inside compaction**:

- a model-only profile passes the effective level to Pi's exported `compact()` helper, so the native compact prompt runs with that reasoning level;
- a replacement-prompt profile sets the `reasoning` request field when the selected model reports reasoning support;
- a typed pipeline applies an explicitly configured level to every LLM stage whose stage model reports reasoning support; when the field is absent, pipeline stage requests are unchanged.

When the profile omits `thinkingLevel`, the model-only and replacement-prompt paths inherit the current chat session thinking level (the previous behavior), and `"off"` explicitly sends no reasoning field even while chat thinking is active. The extension never calls `pi.setThinkingLevel()` and never changes the chat model or the session's thinking setting — only the compact summarizer request differs. Higher levels can increase compact cost and latency; the summarized material still goes only to the profile's configured provider.

### Replacement prompt

Set `prompt` to replace Pi's compact prompt. The supported placeholders are:

- `{{conversation}}` — Pi-serialized visible messages to summarize;
- `{{previousSummary}}` — the prior compact summary, when present;
- `{{turnPrefix}}` — messages in a split user-message span;
- `{{customInstructions}}` — manual `/compact [instructions]` focus.

When a placeholder is omitted, its non-empty value is appended in a labeled block; the visible conversation is always included. A split-turn replacement prompt receives the older summarized messages as `{{conversation}}` and the split prefix separately as `{{turnPrefix}}` in the same whole-summary request; the prefix is not duplicated in `conversation`. The request is checked against the selected model's estimated input budget and fails closed if oversized; no chunking is attempted. The response must end with `stop`, contain text, and contain no tool calls. Abort, empty, length, error, deferred, and other non-final responses are rejected without returning a partial compaction.

Configured failures fail closed by default: the hook returns `{ cancel: true }` instead of throwing (Pi 0.87.1 swallows hook exceptions and would otherwise continue with native compaction). If UI is available, the extension emits a sanitized notice; otherwise it writes a sanitized fixed diagnostic to stderr. It never includes provider error text or transcript content. Pi 0.87.1 represents this extension cancellation in `session_compact_failed` as `aborted: true` with no `errorMessage`; that is a limitation of the public hook result, and this package does not label the underlying provider failure as a Pi error outcome. Set `"failurePolicy": "native"` to explicitly ask Pi to continue with its normal summarizer on a non-abort configured summary failure. A genuine abort/cancellation never falls back. Invalid JSON/profile configuration also cancels rather than silently reverting.

## Compact activity status (TUI)

When a non-native profile intercepts compaction, the interactive TUI footer (outside Pi's built-in `[compaction]` card) shows a keyed status while the configured summarizer runs:

- automatic threshold/overflow compaction: `Auto compact (<model id>)`;
- manual `/compact`: `Manual compact (<model id>)`.

The label names what this attempt actually uses. A model-only or replacement-prompt profile shows the exact selected model id (the current chat model when no override is configured). A typed pipeline shows a single model id only when every LLM stage of this attempt resolves to that same model; otherwise it stays honest with `pipeline, multiple models` or `pipeline, local reducers` instead of naming one model.

The status is **only visible while compaction is running**. It clears on `session_compact` (success or another extension's result), `session_compact_failed` (including cancellation and fail-closed aborts), native pass-through/fallback, and `session_shutdown` (quit, reload, or session replacement); it does not leave a `Last ...` footer behind. Zero-config and explicit native pass-through never create an extension status. Pi 0.87.1 hardcodes the native card's `Compacted from ... tokens` text, so the extension cannot insert the model name inside that card without modifying Pi core. An immediate completion notification from `session_compact` would be erased by Pi's following TUI redraw; no completion notification is attempted.

Status calls are restricted to `ctx.mode === "tui"`, so RPC/JSON/print behavior is unchanged. A failing UI call is swallowed and cannot change the compaction result, its failure policy, or fallback semantics. The status contains only the model label — never transcripts, provider responses, or credentials.

## API/evidence boundaries

Production code listens only to Pi's public compaction lifecycle events — `session_before_compact` for behavior and `session_compact`, `session_compact_failed`, and `session_shutdown` solely to update the compact-only TUI status — and uses `event.preparation`; it does not import Pi's internal `prepareCompaction`. No `context`, `context_with_system`, message, tool-result, or branch-summary hooks are registered. Pi retains ownership of native execution whenever the extension returns `undefined`.

The locally installed 0.87.1 SDK provides the event's `preparation`, `signal`, `reason`, `customInstructions`, and `willRetry`; root exports include `compact`, `convertToLlm`, `serializeConversation`, `CompactionResult`, and `ModelRegistry`. `@earendil-works/pi-ai` publicly exports `uuidv7`; each configured typed-stage and replacement-prompt request gets a fresh one-off routing ID rather than the active chat session ID. The model-only native helper and native passthrough are unchanged. `ModelRegistry.streamSimple()` is documented as provider-neutral and authenticated at request time. Pi's source calls extension-provided compaction results the hook outcome and persists them with its extension marker; summaries are rebuilt alongside messages beginning at `firstKeptEntryId`. Pi authenticates the current chat model before invoking `session_before_compact`, including for alternate-model profiles, so this extension does not rescue unavailable chat-model auth.

## Typed pipeline

A nested `pipeline` opts into typed per-kind reduction, leaving the top-level `prompt` semantics unchanged. A top-level profile `model` is the fallback model for pipeline LLM stages; nested `pipeline.model` and per-kind route fields take precedence. Top-level `prompt` and `pipeline` cannot be set together, including when conflicting fields arrive from different profile-precedence layers.

```json
{
  "default": {
    "pipeline": {
      "maxInputChars": 64000,
      "maxOutputChars": 32000,
      "maxOutputTokens": 4096,
      "routes": {
        "user": { "reducer": "deterministic-facts" },
        "assistant": { "prompt": "Preserve decisions, progress and next steps." },
        "toolCall": { "reducer": "deterministic-facts" },
        "toolResult": { "model": "google/gemini-2.5-flash" }
      }
    }
  }
}
```

Known kinds are `user`, `assistant`, `thinking`, `toolCall`, `toolResult`, `custom`, `bashExecution`, and `branchSummary`. Per-kind `model`, `prompt`, and `reducer` fields merge field-by-field across profile precedence. A route with only `reducer` is terminal; add that route's `model` or `prompt` to feed its parser result into an LLM stage. Each typed LLM stage has its own fresh UUIDv7 routing ID; no stage reuses the active chat session ID. The pipeline reads Pi's canonical projected session context, links calls/results by `toolCallId`, supplies bounded prior-summary/manual-focus/split-prefix/current-task context to each LLM stage, aggregates usage, and includes visible read/modified file tags with details carried forward across pipeline compactions.

The built-in deterministic reducer is named `deterministic-facts`. JSON only selects registered names; it cannot load arbitrary code or execute commands. Trusted extension code may pass additional functions into the registry:

```ts
import { registerSimpleCompact } from "/absolute/path/pi-simple-compact/src/index.ts";
import type { NonLlmReducer } from "/absolute/path/pi-simple-compact/src/pipeline.ts";

const localFacts: NonLlmReducer = (input, shared, signal) => {
  signal.throwIfAborted();
  return input.items.map((item) => item.text).filter(Boolean).join("\n");
};
export default (pi) => registerSimpleCompact(pi, undefined, { reducers: { "local-facts": localFacts } });
```

Load that wrapper instead of also loading the default extension entry. The registry rejects collisions with built-ins. Pipeline input/output and each model context are bounded; oversized requests fail clearly before that stage rather than being chunked. LLM routes use Pi's provider-neutral authenticated `ModelRegistry.streamSimple()` and `event.signal`. A deliberately small Pi compaction reserve can make a stage response end with `length`; it is rejected, and no partial summary is silently persisted. The model-only native-helper path retains Pi's split prompt and input handling; if an alternate model rejects its request for context size, the configured compaction fails closed rather than being chunked.

## Current validation boundary

Automated tests are offline and cover the typed pipeline, deterministic reducers, profile/route precedence, canonical context edits/omissions, native passthrough, alternate fake-provider routing, compact-only thinking-level resolution and request propagation (parse/invalid/per-field precedence, high passed to a fake alternate summarizer with chat thinking off, replacement-prompt and pipeline coverage, absent-field behavior unchanged), repeated compaction, session-profile restoration, trust companion gating, fail-closed outcomes, retained-tail reconstruction, the TUI compact activity status (auto/manual labels, per-attempt model/pipeline labels, completion, failure, native fallback, shutdown cleanup, non-TUI silence, and UI-failure tolerance), and a real SDK `AgentSession.compact()` with fake providers. Separate operator validation on Pi 0.87.1 used synthetic prompts to verify native RPC/TUI compaction, live DeepSeek v4.1 model-only cross-provider compaction, and an uninstrumented typed pipeline with a deterministic reducer; the local evidence is in `../pi-simple-compact-context/LIVE_TEST_REPORT-2026-09-22.md` (not packaged). Actual threshold/overflow scheduling, arbitrary provider credentials, and large-context chunking remain unverified/out of scope; the automated contract fixture exercises manual compaction only, and the visual footer rendering of the keyed status is verified offline through `ExtensionUIContext` spies — a live TUI run of the indicator itself is left to operator validation.
