# Changelog

## v0.6.0 - 2026-04-03

### Highlights

- Forwarded inbound image messages into Codex turns for bound conversations, so Telegram image prompts can now reach Codex as multimodal input instead of being dropped. @huntharo (#60)
- Updated Telegram delivery to work across both the older and newer OpenClaw runtime surfaces by preferring the post-`2026.3.31` outbound adapter when available and safely falling back to the legacy Telegram shim on older hosts. @huntharo (#75)
- Tightened the install and compatibility guidance for current OpenClaw builds, including the required unsafe-install flag, reinstall-based updates on affected hosts, and clearer `0.5.x` versus `0.6.x` support notes. @huntharo (#78, #80)

### Fixes

- Fell back to thread preview text when Codex returns unnamed resume entries, so `/cas_resume` pickers, exact matches, and initial bind text stay readable and consistent. @huntharo (#63)
- Fixed the repo-local project sync to request enough GitHub project items, preventing `.local/work-items.yaml` from silently truncating once the board grows past the CLI default page size. @huntharo (#77)

### Compatibility

- This release line supports OpenClaw `2026.3.22` and newer.
- `v0.6.0+` automatically chooses the new or legacy Telegram runtime surface at startup based on what the host exposes.

### Docs

- Updated the GitHub Sponsors configuration to point at the current username.

## v0.5.0 - 2026-03-26

### Highlights

- Tightened `/cas_resume` recovery around Telegram bind approvals, so a successful bind still restores the thread summary even when Codex cannot replay the original rollout. @huntharo (#54)
- Improved `/cas_status` interactions so model changes repaint the existing status card in place, preserve a clean cancel path, and avoid leaving behind stray picker messages. @huntharo (#56, #58)
- Collapsed Codex worktrees onto their canonical project folder in the new-thread picker, so grouped project selections stop splintering into duplicate workspace choices. @huntharo (#52)

### Fixes

- Masked displayed OpenAI account emails in status and account-summary output so shared screens and chat logs expose less account detail. @huntharo (#57)

## v0.4.0 - 2026-03-25

### Highlights

- Added new thread support directly to `/cas_resume`, including a `New` entry point, `/cas_resume --new`, grouped project picking, delayed workspace disambiguation, and a path back to recent sessions. @huntharo (#46)
- Added an interactive `/cas_status` control card with one-tap model, fast-mode, and permissions controls, and now persist those thread preferences across reconnects and gateway restarts. @huntharo (#49)
- Added built-in help for every `/cas_*` command, so `help` and `--help` now return structured usage, flags, and examples from inside chat. @huntharo (#50)

### Fixes

- Improved permissions handling and model controls from chat, including better Spark compatibility and durable per-conversation preferences when reconnecting to an existing Codex thread. @huntharo (#49)

### Docs

- Polished the README command table and added the standard badge strip so install and command guidance reads more cleanly on GitHub. @huntharo (#45)

## v0.3.0 - 2026-03-23

### Highlights

- Renamed the chat command surface from `/codex` to `/cas`, and `/cas_status` now shows the plugin version so it is easier to confirm what build is deployed. @huntharo (#29, #32)
- Tightened the `/cas_resume` flow with better Discord thread identity handling, a global fallback when the current workspace has no matching threads, and a cancel button on the picker. @huntharo (#35, #42, #43)
- Surfaced Codex file-edit summaries directly in chat replies so thread activity is easier to follow without leaving Telegram or Discord. @huntharo (#5)

### Fixes

- Stopped auto-expiring questionnaire replies after 15 minutes, so long-running plan and steering prompts stay answerable until the underlying Codex run is resolved. @huntharo (#41)
- Detects stale worktree paths on resume and rejects them cleanly instead of letting later shell commands fail against a missing directory. @huntharo (#34)
- Trims shell launcher wrappers like `/bin/zsh -lc '...'` from approval prompts so Telegram and Discord show the command payload that matters. @huntharo (#33)
- Restored the default execution mode after `/cas_plan off`, stopped treating approval cancellation as an authentication failure, and improved conversation-binding reliability across host runtime versions. @huntharo (#6, #8, #26, #28)

### Docs

- Refreshed the README install guidance and expanded the internal notes around Codex permissions and media handling. @huntharo (#5)

### Internal

- Added and refined OCAS/OpenClaw regression coverage, plus published compatibility metadata for OpenClaw `2026.3.22`. @huntharo (#38, #39, #44)
- Added prerelease publishing automation and the repo-local project-manager workflow used to manage this release line. @huntharo (#7, #22, #23, #24)

## v0.2.0 - 2026-03-16

### Highlights

- Reused a shared Codex app-server connection across plugin operations so thread actions and follow-up commands avoid repeated reconnect churn and stay more reliable. @huntharo (#3)

### Fixes

- Added clearer recovery guidance when local Codex authentication expires, including the case where a turn ends without returning assistant text.
- Restored missing bind-approval buttons and removed duplicate approval prompts so Telegram and Discord binding flows stay actionable.
- Replayed topic-sync updates after bind approval so `/codex_resume --sync` still renames the conversation once approval finishes.
- Clarified the project as an independent OpenClaw bridge and removed leftover OpenAI-branded status text from user-facing surfaces.

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
