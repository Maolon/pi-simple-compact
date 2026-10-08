# pi-simple-compact

Choose the model, the prompt and the pipeline [Pi](https://pi.dev) uses when it compacts a session, and change
nothing else. With no configuration this extension does nothing at all: Pi compacts exactly as it always does.

```bash
pi install npm:@maolon/pi-simple-compact
```

## Why

Compaction summarizes old history so a long session fits the context window again. Pi runs it with your
current chat model and its built-in prompt. That is a good default, but sometimes you want something else:

- **A different summarizer.** Chat with a strong, expensive model and compact with a fast, cheap one, or use a model
  with a bigger context window for the summary.
- **Your own prompt.** Keep the details your work depends on, in the shape you want.
- **Typed processing.** Summarize tool output, user requests and assistant reasoning differently, or reduce some of
  them with deterministic local code instead of a model.

pi-simple-compact does this **only inside compaction**. It never changes your chat model, thinking level, trigger
thresholds, tools, session history, `/tree` branch summaries or any other hook.

## How it works

```
 Pi decides to compact (/compact, threshold or overflow)
            │
            ▼
 session_before_compact ──► resolve profile ──► none / native ──► return nothing: Pi compacts natively
                                   │
                                   ├── model only ────────► Pi's own compact() with another model
                                   ├── prompt ────────────► one request with your prompt
                                   └── pipeline ──────────► typed stages (reducers and/or models)
                                   │
                                   ▼
               one summary + Pi's own boundary ──► Pi stores it as a normal compaction entry
```

Pi still prepares the compaction: which messages are summarized, where the retained tail starts and how many tokens
were used. The extension only produces the summary text. Raw history stays in Pi's session file, and the result is
an ordinary Pi compaction entry.

## Requirements

- Pi 0.87.1 or newer (`@earendil-works/pi-coding-agent`). Tested with 0.87.1 and 1.1.0.
- Node.js 22.16 or newer.

## Install

```bash
pi install npm:@maolon/pi-simple-compact
```

Use `-l` to install into the current project (`.pi/settings.json`) instead of your personal settings, or try it
for one run with `pi -e npm:@maolon/pi-simple-compact`. Pin versions with `npm:@maolon/pi-simple-compact@0.1.0`.

Nothing changes until you add a profile.

## Quick start

Compact with a cheaper model while you keep chatting with your current one. Create
`~/.pi/agent/pi-simple-compact.json`:

```json
{
  "default": { "model": "google/gemini-2.5-flash" }
}
```

The model is an exact, case-sensitive `provider/modelId` from `pi --list-models`. Pi's registry provides its
credentials. Run `/compact` and the summary comes from that model through Pi's own compaction prompt. During the
compaction the footer shows `Manual compact (gemini-2.5-flash)` (`Auto compact (...)` for automatic ones).

> **Privacy.** A configured summarizer receives the history being compacted, including tool calls and tool output,
> from the session. If you choose a different provider from your chat provider, that data goes to it. A typed
> pipeline can send different kinds of history to different providers. Configure only providers you trust with
> that data.

## Configuration

Profiles live in JSON files:

| File | Read when |
|---|---|
| `~/.pi/agent/pi-simple-compact.json` (or `$PI_CODING_AGENT_DIR/pi-simple-compact.json`) | always |
| `<project>/.pi/pi-simple-compact.json` | only when Pi trusts the project **and** `<project>/.pi/settings.json` exists |

A project file on its own cannot opt itself in: Pi must have granted project trust, and the project must have the
Pi settings file that trust covers.

### File shape

```json
{
  "default": { "model": "google/gemini-2.5-flash" },
  "models": {
    "anthropic/claude-sonnet-4": { "model": "google/gemini-2.5-flash", "thinkingLevel": "high" }
  },
  "profiles": {
    "focused": {
      "model": "google/gemini-2.5-flash",
      "prompt": "Summarize this coding session.\n{{conversation}}\nPrior summary: {{previousSummary}}\nFocus: {{customInstructions}}"
    }
  }
}
```

- `default`: applies to every chat model.
- `models`: applies when the **current chat model** is exactly that `provider/modelId`.
- `profiles`: named profiles you select per session with `/compact-profile <name>`.

Each profile can set:

| Field | Meaning |
|---|---|
| `model` | `provider/modelId` of the summarizer. Default: the current chat model. |
| `prompt` | Replace Pi's compaction prompt (see [Replacement prompt](#replacement-prompt)). |
| `pipeline` | Typed per-kind processing (see [Typed pipeline](#typed-pipeline)). Cannot be combined with `prompt`. |
| `thinkingLevel` | Summarizer reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Compaction only. |
| `failurePolicy` | `fail` (default) or `native`. See [Failures](#failures). |
| `mode` | `native`: hand compaction back to Pi and ignore lower-priority profiles. |

A profile with no `model`, `prompt` or `pipeline` does not intercept compaction. A `thinkingLevel` on its own
therefore stays native, because it only adjusts a configured summarizer.

### Precedence

Settings resolve **per field**, highest priority first:

1. the named profile selected in this session;
2. project `models` entry for the current chat model;
3. user `models` entry for the current chat model;
4. project `default`;
5. user `default`;
6. Pi's native behavior.

### Per-session selection

```
/compact-profile focused    use the named profile in this session
/compact-profile native     use Pi's native compaction in this session
/compact-profile reset      go back to the inherited settings
```

The choice is stored as a small custom entry in the session. It follows the active branch, survives restarts and
`--continue`, and never enters model context. `/compact-profile native` works even when a configuration file is
broken, so you always have a way back to Pi's own compaction.

## Summarization strategies

### Model only

With just `model` (and optionally `thinkingLevel`), the extension calls Pi's exported `compact()` helper with that
model. Pi's prompt, split-turn handling, file tracking and result format stay exactly as they are.

When Pi splits a turn, it summarizes the history and the beginning of the split turn separately and joins the two
parts. The extension adds a `[HISTORY]` and a `[TURN_PREFIX]` label to Pi's separator. The labels say where each part
came from, not which one is more reliable: a turn prefix can quote old tasks. Each label tells the model to resolve
conflicting status from explicit completion evidence and the retained messages. If the separator is missing or
appears more than once, the summary passes through unchanged.

### Replacement prompt

`prompt` replaces Pi's compaction prompt with one request to the summarizer. Placeholders:

| Placeholder | Value |
|---|---|
| `{{conversation}}` | the messages being summarized, serialized the way Pi does it |
| `{{previousSummary}}` | the previous compaction summary, if any |
| `{{turnPrefix}}` | the beginning of a split turn, if any |
| `{{customInstructions}}` | the text after `/compact`, if any |

A placeholder you leave out is appended in a labeled block when it has a value, so the conversation is always
included. Unknown placeholders are rejected. Read and modified files are appended as `<read-files>` and
`<modified-files>` tags, like Pi does.

### Typed pipeline

A `pipeline` splits the history by kind and handles each kind in its own stage:

```json
{
  "default": {
    "model": "google/gemini-2.5-flash",
    "pipeline": {
      "routes": {
        "user": { "reducer": "deterministic-facts" },
        "assistant": { "prompt": "Keep decisions, progress and next steps." },
        "toolResult": { "model": "openai/gpt-5-mini" }
      }
    }
  }
}
```

- Kinds: `user`, `assistant`, `thinking`, `toolCall`, `toolResult`, `custom`, `bashExecution`, `branchSummary`
  (prior branch and compaction summaries).
- A route can set `model`, `prompt` and `reducer`. A route with only `reducer` is handled entirely by local code. Add
  `model` or `prompt` to pass the reducer's output on to a model.
- Kinds without a route use `pipeline.model`, then the profile `model`, then the current chat model.
- Tool calls and results are linked by `toolCallId`, and a result without its call is kept.
- Every stage receives the same bounded shared context: the previous summary, `/compact` instructions, the latest
  user request and an excerpt of a split turn.
- The stage outputs are joined into one summary with a section per kind.

Limits (optional, inside `pipeline`):

| Field | Default | Meaning |
|---|---|---|
| `maxInputChars` | 64000 | characters per request (also capped by the model's context window) |
| `maxOutputChars` | 32000 | characters in the final summary |
| `maxOutputTokens` | 4096 | output tokens per stage (also capped by Pi's reserve and the model) |

When a kind does not fit in one request, it is sent in parts. Each part carries a bounded checkpoint of the earlier
parts, and the last part's answer becomes the stage output. A single record that is too large on its own is sent
as a marked head and tail excerpt. Compaction fails only when the fixed part of a request (prompt and shared
context) is already too large, and that check runs before any model is called.

`deterministic-facts` is the built-in reducer: it lists the de-duplicated records of its kind in order. JSON
configuration can only name reducers. It cannot load code.

#### Custom reducers

Trusted local code can register more reducers. Load your own extension instead of this package's default entry:

```ts
import { registerSimpleCompact, type NonLlmReducer } from "@maolon/pi-simple-compact";

const errorsOnly: NonLlmReducer = (input, _shared, signal) => {
  signal.throwIfAborted();
  return input.items.filter((item) => item.isError).map((item) => item.text).join("\n") || "No errors.";
};

export default (pi) => registerSimpleCompact(pi, undefined, { reducers: { "errors-only": errorsOnly } });
```

Reducer names cannot collide with built-ins.

## Failures

A configured compaction is rejected when the summarizer returns no text, stops because of a length limit, errors,
is aborted or tries to call a tool. A partial summary is never stored.

- **`failurePolicy: "fail"` (default).** Compaction is canceled and a short notice explains why. Pi does not
  silently fall back to its native summarizer, because that would send your history to a model you did not choose
  for compaction. Pi reports this cancellation as `aborted` in `session_compact_failed`; the public hook result has
  no way to report an error message.
- **`failurePolicy: "native"`.** Pi runs its native compaction instead, and a warning says so. A real cancellation
  (Escape) never falls back.
- **Invalid configuration** cancels compaction with a notice that names the file and, where possible, the line and
  column or the field, never its contents. Fix the file or run `/compact-profile native`.

The model-only and replacement-prompt strategies are not split into parts. If the history does not fit the
summarizer's context window, they fail before any request. Pick a summarizer with
a large enough window, use a pipeline, or set `failurePolicy: "native"`.

## Status in the TUI

While a configured compaction runs, the footer shows `Manual compact (<model>)` or `Auto compact (<model>)`. A
pipeline shows one model when all its model stages use the same one, and otherwise `pipeline, multiple models` or
`pipeline, local reducers`. The status disappears when compaction finishes, fails or is canceled. Native compaction
never shows it, and print, JSON and RPC modes are not affected.

## Data and privacy

- The extension makes model requests only when a profile asks for them, and only during compaction.
- It sends only the material of the compaction being run, and only to the providers you configured.
- Notices and diagnostics contain no conversation text, provider responses or credentials.
- It stores only the per-session profile choice and the compaction result Pi already stores.

## Status

0.1 is an early release.

- **Tested automatically:** every strategy, profile precedence, project trust gating, session profiles across
  restarts, failures, cancellation and status cleanup. The tests use a real Pi `AgentSession` and fake
  providers. A tmux suite drives the real Pi TUI with offline providers through native, model-only, failing,
  broken-config, pipeline, automatic-threshold and restart scenarios. The offline suites run against Pi 0.87.1 and
  1.1.0.
- **Tested by hand:** a few real providers, including a cross-provider summarizer and a hybrid pipeline. Other
  providers have not been tried. Overflow-triggered compaction has not been reproduced with a real provider.
- **Not included:** a reconciliation pass that resolves contradictions between the two parts of a split-turn summary.
  The labels only mark which part is which.

## Development

```bash
npm install
npm run check            # typecheck, unit, pipeline and Pi SDK contract tests (offline)
npm run build            # dist/
npm run test:package     # pack, leak scan, clean install, load with plain Node
npm run test:e2e         # real Pi TUI in tmux with offline fake providers (needs tmux)
```

`PSC_E2E_ENTRY=dist npm run test:e2e` runs the tmux suite against the built package. To load your working copy in
Pi, run `pi -e ./src/index.ts`. See [AGENTS.md](AGENTS.md) for conventions and the release flow.

## License

[MIT](LICENSE)
