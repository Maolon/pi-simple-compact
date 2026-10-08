# AGENTS.md

Guidance for coding agents (and humans) working in this repository.

## What this is

`@maolon/pi-simple-compact` is a Pi extension package. It customizes **only** compaction: which model writes the
summary, with which prompt, and through which typed pipeline. With no configuration it returns nothing from
`session_before_compact` and Pi compacts natively. Start with `README.md`. The entry point is `src/index.ts`.

## Commands

```bash
npm install
npm run check              # typecheck + vitest + pipeline cases + Pi SDK contract tests, all offline
npm run build              # dist/ (tsc)
npm run test:package       # pack, leak-scan the tarball, install it, load the extension with plain Node
npm run test:e2e           # real Pi TUI in tmux with offline fake providers; needs tmux
```

Run `check` before every change you hand back. Run `test:e2e` when you touch the hook flow, configuration loading,
commands or the TUI status. Run `test:package` when you touch `package.json`, the build or the public entry point.

## Branches and releases

Git flow with `dev` as the integration branch and `main` as the release branch. Both are protected: changes land
only through pull requests with green CI.

- `feature/<topic>` from `dev`, PR back into `dev`.
- `release/<x.y.z>` from `dev`: only the `package.json`/`package-lock.json` version bump and a `CHANGELOG.md`
  entry. PR into `main`.
- `hotfix/<topic>` from `main` for urgent fixes, with the version bump and CHANGELOG entry included. PR into `main`.
- Merging into `main` publishes to npm: `release.yml` reruns CI, publishes the new version through trusted
  publishing, and creates the `v<x.y.z>` tag and GitHub release. The `release-guard` CI job blocks PRs into `main`
  that come from another branch, reuse a version already on npm, or lack a CHANGELOG entry.
- After every release, open a PR from `main` into `dev` so the merge commit and version bump flow back.

## Layout

```
src/index.ts             Pi entry: session_before_compact, status lifecycle, /compact-profile
src/config.ts            profile files, trust gating, per-field precedence, session profile entries
src/summary-adapter.ts   model-only path (Pi's compact()) and replacement-prompt path
src/pipeline.ts          typed pipeline: canonical projection, tool linking, parts, budgets
src/reducers.ts          built-in deterministic-facts reducer
src/compact-status.ts    TUI footer status while a configured compaction runs
tests/                   vitest (*.test.ts), node:test (*.cases.mjs, *.contract.ts), e2e fake provider
scripts/                 package smoke and tmux e2e runners
```

## Rules

- English only: code, comments, strings, tests and docs.
- Compaction only. Never register `context`, `context_with_system`, `message_end`, `tool_result` or
  `before_agent_start` handlers, never change the chat model, thinking level, thresholds or branch summaries, and
  never patch Pi.
- Zero configuration must stay exactly native: return `undefined` and make no model call.
- Return exactly Pi's `firstKeptEntryId` and `tokensBefore`; never store a partial summary.
- A configured failure returns `{ cancel: true }` unless `failurePolicy` is `native`. Never throw from the hook and
  never return `undefined` by accident: Pi swallows hook errors and would silently compact natively.
- Validate request sizes before the first provider call.
- Never log or notify conversation text, provider responses, configuration file contents or credentials.
- JSON configuration may only name trusted reducers; it never loads code or paths.
- Never commit local paths, usernames, session files, credentials or real API keys. Tests use synthetic content.
