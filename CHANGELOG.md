# Changelog

## v0.1.2 - 2026-03-15

### Fixes

- Aligned the Codex app-server client with the current turn protocol so resumed and bound conversations use the required `threadId`, `expectedTurnId`, and `input` request shapes instead of stale fallback variants.
- Stopped sending invalid collaboration-mode and thread lifecycle payload variants that newer Codex app-server builds reject during `/codex_resume` and follow-up replies.

### Internal

- Added regression coverage for `turn/start`, `turn/steer`, and `thread/resume` payload builders, plus explicit logs when a queued steer or interrupt is skipped because no active turn id is available.

## v0.1.1 - 2026-03-15

### Internal

- Added Codex server startup diagnostics so the plugin logs the launch command, working directory, and early startup details when the app server fails before a turn begins.

## v0.1.0 - 2026-03-15

### Highlights

- Added a richer Codex thread resume flow with paged pickers, clearer thread labels, and status output that shows project context, context usage, rate limits, and plan mode.
- Rebuilt the interactive Codex workflow surface with model and skill actions, plan questionnaires, approval prompts, free-form questionnaire answers, attachment-aware plan delivery, and one-click plan implementation back into default coding mode.
- Shipped the package under the unscoped `openclaw-codex-app-server` name with local setup and contributor docs for linking the plugin into a local OpenClaw checkout.

### Fixes

- Hardened conversation binding and inbound claim handling so approved bindings can be recovered, pending approvals survive restarts, stale denied binds do not linger, and active runs restart cleanly when they cannot accept a new inbound message.
- Fixed Discord-specific conversation handling around command routing, picker refresh, callback targets, bound thread matching, rename label generation, DM typing leases, and attachment delivery for plan output.
- Added file-path context for Codex approval prompts and serialized approval responses back through chat so long-running plan and approval flows stay usable from Telegram and Discord.

### Internal

- Added CI, package smoke checks, tag-driven npm publish automation, and a repo-local release workflow for future tagged releases. @huntharo (#1)
- Added verbose turn lifecycle diagnostics to trace inbound claim handoff, app-server startup, first assistant output, outbound replies, and cleanup when a run fails or is interrupted.
