# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/). Before 1.0, minor versions may break.

## [Unreleased]

### Added
- `idleCompact` profile setting: compact an idle session once the chat provider's prompt cache has gone cold, so
  the next turn does not resend the whole context uncached. Off unless configured. Works at every profile layer
  (session, model, default) with per-field precedence.
- `/compact-idle [on [minutes]|off|status]` turns idle compaction on or off for all chats and shows what applies to
  the current session.

## [0.1.1] - 2026-10-07

### Changed
- Released from CI through npm trusted publishing (OIDC), with provenance. No functional changes from 0.1.0.

## [0.1.0] - 2026-10-07

First public release.

### Added
- Compact-only Pi extension, inert until configured: with no profile, Pi compacts natively.
- Profiles from `~/.pi/agent/pi-simple-compact.json` and, for trusted projects with `.pi/settings.json`,
  `<project>/.pi/pi-simple-compact.json`: `default`, per-chat-model `models` and named `profiles`, resolved per field.
- `/compact-profile <name|native|reset>`, stored per session branch and restored on reload.
- Model-only summarizer through Pi's own `compact()`, with `[HISTORY]`/`[TURN_PREFIX]` labels on split-turn summaries.
- Replacement prompt with `{{conversation}}`, `{{previousSummary}}`, `{{turnPrefix}}` and `{{customInstructions}}`.
- Typed pipeline with per-kind routes, the `deterministic-facts` reducer, trusted custom reducers, and parts with a
  running checkpoint for stages larger than one request.
- Compact-only `thinkingLevel`.
- Fail-closed failures by default, optional `failurePolicy: "native"`.
- TUI footer status while a configured compaction runs.
- tmux end-to-end suite with offline fake providers.
