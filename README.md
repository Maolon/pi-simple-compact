# pi-simple-compact

Choose the model, the prompt and the pipeline [Pi](https://pi.dev) uses when it compacts a session, and optionally
compact an idle session once its prompt cache has gone cold. Nothing else changes. With no configuration this
extension does nothing at all: Pi compacts exactly as it always does.

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
- **Cold-cache compaction.** Provider prompt caches expire while you are away. The next message then resends the
  whole context at the uncached price, which for a long session on a frontier model can cost dollars per turn.
  [Idle compaction](#idle-compaction) compacts the session while it sits idle after the cache has gone cold, so you
  come back to a short summary instead. Turn it on with `/compact-idle on`.

pi-simple-compact does this **only inside compaction**. It never changes your chat model, thinking level, Pi's own
trigger thresholds, tools, session history, `/tree` branch summaries or any other hook. The one trigger it adds,
idle compaction, is off until you turn it on.

## How it works

```
 Pi decides to compact (/compact, threshold or overflow)
   or idle compaction calls Pi's compact after the cache went cold (opt-in)
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

- Pi (`@earendil-works/pi-coding-agent`). Tested with 0.87.1 and 1.1.0; other versions are untested.
- Node.js 22.16 or newer.

## Install

```bash
pi install npm:@maolon/pi-simple-compact
```

Use `-l` to install into the current project (`.pi/settings.json`) instead of your personal settings, or try it
for one run with `pi -e npm:@maolon/pi-simple-compact`. Pin versions with `npm:@maolon/pi-simple-compact@0.2.0`.

Nothing changes until you add a profile.

## Quick start

Chat with an expensive model and compact with a fast, cheap one. For example, while you chat with
`openai-codex/gpt-6-astra`, let `google/gemini-3.8-flash` write the summaries. Create
`~/.pi/agent/pi-simple-compact.json`:

```json
{
  "models": {
    "openai-codex/gpt-6-astra": { "model": "google/gemini-3.8-flash", "thinkingLevel": "high" }
  }
}
```

Models are exact, case-sensitive `provider/modelId` values from `pi --list-models`. Pi's registry provides their
credentials. Run `/compact` and the summary comes from Gemini through Pi's own compaction prompt, while chat stays on
astra. During the compaction the footer shows `Manual compact (gemini-3.8-flash)` (`Auto compact (...)` for automatic
ones). Use `default` instead of `models` to compact every chat model this way.

Then, to stop paying for a cold cache after a break, run:

```
/compact-idle on 60
```

From now on, a session left idle for 60 minutes is compacted before you come back (see
[Idle compaction](#idle-compaction)).

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
  "default": { "model": "google/gemini-3.8-flash" },
  "models": {
    "openai-codex/gpt-6-astra": {
      "model": "google/gemini-3.8-flash",
      "thinkingLevel": "high",
      "idleCompact": { "afterIdleMinutes": 60 }
    }
  },
  "profiles": {
    "focused": {
      "model": "google/gemini-3.8-flash",
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
| `pipeline` | Typed per-kind processing (see [Typed pipeline](#typed-pipeline)). Cannot be combined with `prompt`, even from different files or layers. |
| `thinkingLevel` | Summarizer reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. Compaction only. |
| `failurePolicy` | `fail` (default) or `native`. See [Failures](#failures). |
| `mode` | `native`: hand compaction back to Pi and ignore lower-priority profiles. |
| `idleCompact` | Compact an idle session once the chat provider's prompt cache has gone cold (see [Idle compaction](#idle-compaction)). `false` turns off an inherited setting. |

A `prompt` and a `pipeline` that meet from different layers (say, a project `models` entry with `prompt` over a
user `default` with `pipeline`) are a configuration error and cancel compaction with a notice.

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
included. Unknown placeholders are rejected when the configuration is loaded. Read and modified files are appended as `<read-files>` and
`<modified-files>` tags, like Pi does.

### Typed pipeline

A `pipeline` splits the history by kind and handles each kind in its own stage:

```json
{
  "default": {
    "model": "google/gemini-3.8-flash",
    "pipeline": {
      "routes": {
        "user": { "reducer": "deterministic-facts" },
        "assistant": { "prompt": "Keep decisions, progress and next steps." },
        "toolResult": { "model": "google/gemini-3.7-flash" }
      }
    }
  }
}
```

- Kinds: `user`, `assistant`, `thinking`, `toolCall`, `toolResult`, `custom`, `bashExecution`, `branchSummary`
  (prior branch and compaction summaries).
- A route can set `model`, `prompt` and `reducer`. A route with only `reducer` is handled entirely by local code, and
  nothing of that kind is sent to a model. With `model` or `prompt` added, the model receives the reducer's output
  **and** the raw records of that kind.
- Kinds without a route use `pipeline.model`, then the profile `model`, then the current chat model.
- Tool calls and results are linked by `toolCallId`, and a result without its call is kept.
- Every stage receives the same bounded shared context: the previous summary, `/compact` instructions, the latest
  user request and an excerpt of a split turn.
- The stage outputs are joined into one summary with a section per kind.

Limits (optional, inside `pipeline`):

| Field | Default | Meaning |
|---|---|---|
| `maxInputChars` | 64000 | characters per request (also capped by the model's context window) |
| `maxOutputChars` | 32000 | characters in the final summary, shared equally by the kinds present; a kind whose output exceeds its share fails the compaction |
| `maxOutputTokens` | 4096 | output tokens per stage (also capped by Pi's reserve and the model) |

When a kind does not fit in one request, it is sent in parts. Each part carries a bounded checkpoint of the earlier
parts, and the last part's answer becomes the stage output. A single record that is too large on its own is sent
as a marked head and tail excerpt. Every request is planned and size-checked before the first model call.
Compaction still fails when:

- the fixed part of a request (prompt and shared context) leaves no room for records;
- a reducer's input exceeds `maxInputChars` (reducers receive their whole kind and are not split);
- Pi's compaction reserve is too small for the number of model stages;
- a stage's output exceeds its share of `maxOutputChars` (checked after that stage runs).

`deterministic-facts` is the built-in reducer. It lists the de-duplicated records of its kind in order, after the
shared context (latest user request, previous summary, `/compact` instructions and split-turn excerpt), so each
reducer section repeats that context. JSON configuration can only name reducers. It cannot load code.

#### Custom reducers

Trusted local code can register more reducers. Write your own Pi extension or package that depends on
`@maolon/pi-simple-compact` through npm and calls `registerSimpleCompact` with them:

```ts
import { registerSimpleCompact, type NonLlmReducer } from "@maolon/pi-simple-compact";

const errorsOnly: NonLlmReducer = (input, _shared, signal) => {
  signal.throwIfAborted();
  return input.items.filter((item) => item.isError).map((item) => item.text).join("\n") || "No errors.";
};

export default (pi) => registerSimpleCompact(pi, undefined, { reducers: { "errors-only": errorsOnly } });
```

Load only that extension. Do not also `pi install` this package, or two copies register the same hook and command.
If you must install both, disable this package's own entry in Pi settings with
`{ "source": "npm:@maolon/pi-simple-compact", "extensions": [] }`. Reducer names cannot collide with built-ins.

## Idle compaction

Off unless configured. Provider prompt caches expire after a period without requests. After that, the next turn
resends the whole context at the uncached price. With `idleCompact`, the extension compacts the session while it
sits idle after the cache has gone cold, so your next message resends a short summary instead.

For example, a `gpt-6-astra` session at 600k tokens costs about $12 to resend uncached (input above 272k tokens is
$20/M, against $2/M from cache). Compacting it with `gemini-3.8-flash` costs about $0.20, and the next turn starts
from a summary of a few tens of thousands of tokens. Compacting while the cache is still warm would save nothing on
the summary itself, because Pi's summary requests do not use the prompt cache. The extension therefore waits for the
cache to go cold.

The quickest way to turn it on for all chats is a command:

| Command | Effect |
|---|---|
| `/compact-idle on [minutes]` | Turns it on in `~/.pi/agent/pi-simple-compact.json` (`default.idleCompact`), optionally with a new wait. |
| `/compact-idle off` | Turns it off there. Your minutes and token floor stay in the file for the next `on`. |
| `/compact-idle` or `/compact-idle status` | Shows the global setting and what applies to this session, naming any model or session setting that overrides it. |

The command edits only `default.idleCompact`, keeps the rest of the file and its permissions, and refuses to touch
a file that does not parse. It takes effect from the end of the next turn. Model and session settings still win
over the global one.

`idleCompact` is a profile field like the others, so it works for all chats (`default`), per chat model (`models`)
and per session (a named profile selected with `/compact-profile`):

```json
{
  "default": { "idleCompact": { "afterIdleMinutes": 60 } },
  "models": {
    "openai-codex/gpt-6-astra": {
      "model": "google/gemini-3.8-flash",
      "idleCompact": { "minContextTokens": 200000 }
    },
    "zai/glm-5.3": { "idleCompact": false }
  },
  "profiles": {
    "no-idle": { "idleCompact": false },
    "idle-fast": { "idleCompact": { "afterIdleMinutes": 10 } }
  }
}
```

| Field | Meaning |
|---|---|
| `enabled` | `true` or `false`. Defaults to `true` once any layer sets `idleCompact`. `"idleCompact": false` means `{ "enabled": false }`. |
| `afterIdleMinutes` | 1 to 1440, default 60. How long after a run ends to wait. Set it to your provider's cache retention: the extension cannot see when a cache actually expires. |
| `minContextTokens` | Default 50000. Smaller contexts are left alone; resending them costs less than a summary. |

Fields merge one at a time with the usual [precedence](#precedence): session profile, project model, user model,
project default, user default. In the example, astra waits 60 minutes (from `default`) and needs 200000 tokens
(from its model entry). `/compact-profile no-idle` turns it off for the current session only, and
`/compact-profile reset` restores the inherited setting. `native` means Pi's own behavior, which has no idle
compaction: `/compact-profile native` turns it off for the session, and a `mode: "native"` layer stops lower layers
from enabling it unless that layer or a higher one sets `idleCompact` itself.

`idleCompact` is a trigger, not a summarizer choice. A profile with only `idleCompact` compacts with Pi's native
summarizer; add `model`, `prompt` or `pipeline` to use a configured one, exactly as for `/compact`.

The timer starts when a run ends. Any new prompt, input, model switch, compaction or shutdown cancels it. When it
fires, the extension compacts only if Pi is idle, has no queued messages and reports at least `minContextTokens`
of context. One idle period compacts at most once. Print and JSON runs never schedule it.

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

While a configured compaction runs, the footer shows `Manual compact (<model>)`, `Auto compact (<model>)` or, for
[idle compaction](#idle-compaction), `Idle compact (<model>)`. A
pipeline shows one model when all its model stages use the same one, and otherwise `pipeline, multiple models` or
`pipeline, local reducers`. The status disappears when compaction finishes, fails or is canceled. Native compaction
never shows it, and print, JSON and RPC modes are not affected.

## Data and privacy

- The extension makes model requests only when a profile asks for them, and only during compaction.
- It sends only the material of the compaction being run, and only to the providers you configured.
- Notices and diagnostics contain no conversation text, provider responses or credentials.
- It stores only the per-session profile choice and the compaction result Pi already stores.

## Status

0.2 is an early release.

- **Tested automatically:** every strategy, profile precedence, project trust gating, session profiles across
  restarts, failures, cancellation and status cleanup. The tests use a real Pi `AgentSession` and fake
  providers. A tmux suite drives the real Pi TUI with offline providers through native, model-only, failing,
  broken-config, pipeline, automatic-threshold, idle-compaction (`/compact-idle on`, then an idle compaction after one
  minute) and restart scenarios. The offline suites run against Pi 0.87.1 and
  1.1.0.
- **Tested by hand:** a few real providers, including a cross-provider summarizer and a hybrid pipeline. Other
  providers have not been tried. Overflow-triggered compaction has not been reproduced with a real provider. Idle compaction has not yet been run
  against a real provider's cache expiry; `afterIdleMinutes` is your statement of the cache retention.
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
