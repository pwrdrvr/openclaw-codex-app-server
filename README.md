# OpenClaw App Server Bridge

Independent OpenClaw bridge for using Codex App Server from Telegram and Discord conversations. Bind a chat to a Codex thread, talk to it with plain text, and control it with chat-native commands for resume, planning, review, model selection, compaction, and more.

This repository is a simple bridge for using Codex through OpenClaw. It is not affiliated with or endorsed by OpenAI.

If `codex` already works on the machine running OpenClaw, this plugin should work too. It uses the same local Codex CLI and shared login state. There is no separate plugin login requirement for normal use.

## Quick Start

1. Install the plugin into OpenClaw.
2. Start in the Telegram or Discord conversation where you want the bridge bound.
3. Run `/codex_resume`.
4. Pick a project and thread, or search directly.
5. Once bound, plain text in that conversation routes to the selected Codex thread.

Buttons are presented for project and thread selection, model switching, and skill shortcuts. If your filter is ambiguous, the plugin sends a picker instead of guessing.

## Install In OpenClaw

These are the intended install commands once OpenClaw ships a build after `2026-03-16` with the plugin interface needed by this package.

Install:

```bash
openclaw plugins install openclaw-codex-app-server
```

Uninstall:

```bash
openclaw plugins uninstall openclaw-codex-app-server
```

OpenClaw `main` included the required plugin interface changes as of `2026-03-16`. Use any OpenClaw release that includes those changes, or use the local developer workflow at the bottom of this document.

Pre-release packages are published on matching npm dist-tags instead of `latest`. For example, a tag such as `v0.3.0-beta.1` publishes to `openclaw-codex-app-server@beta`, so `npm install openclaw-codex-app-server@latest` stays on the newest stable release.

## Why Try It

- Uses your existing local Codex CLI setup instead of a separate hosted bridge.
- Feels natural in chat: bind once with `/codex_resume`, then just talk.
- Keeps useful controls close at hand with `/codex_status`, `/codex_plan`, `/codex_review`, `/codex_model`, and more.
- Works well for Telegram and Discord conversations that you want tied to a real Codex thread.

## Typical Workflow

1. Run `/codex_resume` in the conversation you want to bind.
2. Use the picker buttons, or pass a filter like `/codex_resume release-fix` or `/codex_resume --projects`.
3. Send normal chat messages once the thread is bound.
4. Use control commands such as `/codex_status`, `/codex_plan`, `/codex_review`, `/codex_model`, and `/codex_stop` as needed.
5. If you leave plan mode through the normal `Implement this plan` button, you do not need `/codex_plan off`; use `/codex_plan off` only when you want to exit planning manually instead.

## Command Reference

| Command | What it does | Notes / examples |
| --- | --- | --- |
| `/codex_resume` | Bind this conversation to a Codex thread. | With no args, opens a picker for recent sessions in the current workspace. |
| `/codex_resume --projects` | Browse projects first. | Opens a project picker, then a thread picker. |
| `/codex_resume --all` | Search recent sessions across projects. | Useful when the thread is not in the current workspace. |
| `/codex_resume --cwd ~/github/openclaw` | Restrict browsing/search to one workspace. | `--cwd` accepts an absolute path or `~/...`. |
| `/codex_resume --sync` | Resume and try to sync the chat/topic name to the Codex thread. | You can combine this with other flags. |
| `/codex_resume release-fix` | Resume a matching thread by title or id. | If more than one thread matches, you get buttons to choose. |
| `/codex_status` | Show the current binding and thread state. | Includes thread id, model, workspace, sandbox, and permissions when available. |
| `/codex_detach` | Unbind this conversation from Codex. | Stops routing plain text from this conversation into the bound thread. |
| `/codex_stop` | Interrupt the active Codex run. | Only applies when a turn is currently in progress. |
| `/codex_steer <message>` | Send follow-up steer text to an active run. | Example: `/codex_steer focus on the failing tests first` |
| `/codex_plan <goal>` | Ask Codex to plan instead of execute. | The plugin relays plan questions and the final plan back into chat. |
| `/codex_plan off` | Exit plan mode for this conversation. | Use this when you want to leave planning manually instead of through the normal `Implement this plan` button. |
| `/codex_review` | Review the current uncommitted changes in the bound workspace. | Requires an existing binding. |
| `/codex_review <focus>` | Review with custom instructions. | Example: `/codex_review focus on thread selection regressions` |
| `/codex_compact` | Compact the bound Codex thread. | The plugin posts progress and final context usage. |
| `/codex_skills` | List available Codex skills for the workspace. | Adds buttons for up to eight skill shortcuts. |
| `/codex_skills review` | Filter the skills list. | Matches skill name, description, or cwd. |
| `/codex_experimental` | List experimental features reported by Codex. | Read-only. |
| `/codex_mcp` | List configured MCP servers. | Shows auth state and counts for tools/resources/templates. |
| `/codex_mcp github` | Filter MCP servers. | Matches name and auth status. |
| `/codex_fast` | Toggle fast mode for the bound thread. | Equivalent to switching the service tier between default and fast. |
| `/codex_fast on|off|status` | Set or inspect fast mode explicitly. | Example: `/codex_fast status` |
| `/codex_model` | List models and show model-selection buttons. | If the conversation is not bound yet, it lists models only. |
| `/codex_model gpt-5.4` | Set the model for the bound thread. | Requires an existing binding. |
| `/codex_permissions` | Show account, rate-limit, and thread permission information. | Works with or without a current binding. |
| `/codex_init ...` | Forward `/init` to Codex. | Sends the alias straight through to the App Server. |
| `/codex_diff ...` | Forward `/diff` to Codex. | Sends the alias straight through to the App Server. |
| `/codex_rename <new name>` | Rename the bound Codex thread. | Example: `/codex_rename approval flow cleanup` |
| `/codex_rename --sync <new name>` | Rename the thread and try to sync the conversation/topic name too. | Requires an existing binding. |

## Screenshot Placeholders

- `[TODO screenshot] /codex_resume --projects` project picker
- `[TODO screenshot] /codex_resume` thread picker with buttons
- `[TODO screenshot] bound conversation after /codex_status`
- `[TODO screenshot] /codex_model` button list

## Plugin Config Notes

The plugin schema in [`openclaw.plugin.json`](./openclaw.plugin.json) supports:

- `transport`: `stdio` or `websocket`
- `command` and `args`: the Codex executable and CLI args for `stdio`
- `url`, `authToken`, `headers`: connection settings for `websocket`
- `defaultWorkspaceDir`: fallback workspace for unbound actions
- `defaultModel`: model used when a new thread starts without an explicit selection
- `defaultServiceTier`: default service tier for new turns

## Developer Workflow With A Local OpenClaw Checkout

Use this path when you are testing a local checkout of this repository against a local OpenClaw build before the required plugin interface is available in a released OpenClaw version.

### 1. Check out OpenClaw with the required plugin interface

This plugin originally targeted [openclaw/openclaw#45318](https://github.com/openclaw/openclaw/pull/45318). Use that branch if it is still unmerged, or use `main` once the change has landed there.

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
gh pr checkout 45318
pnpm install
```

If you are not using `gh`, fetch the PR directly:

```bash
git fetch origin pull/45318/head:pr-45318
git checkout pr-45318
pnpm install
```

### 2. Install this plugin from a local checkout

From the OpenClaw repository:

```bash
pnpm openclaw plugins install --link "/absolute/path/to/openclaw-codex-app-server"
```

Remove the linked local checkout:

```bash
pnpm openclaw plugins uninstall openclaw-codex-app-server
```

### 3. Start the local gateway

From the OpenClaw checkout:

```bash
pnpm gateway:watch
```

### 4. Optional local dependency override inside this repo

This repository no longer commits a machine-local `openclaw` dev dependency, so CI stays portable. If you want this plugin checkout to resolve `openclaw` from your own local OpenClaw source tree, add a local-only override in your working copy:

```bash
pnpm add -D openclaw@file:/absolute/path/to/openclaw
pnpm install
```

That override is for local development only. Do not commit the resulting `package.json` or `pnpm-lock.yaml` changes.

## Development Checks

```bash
pnpm test
pnpm typecheck
```
