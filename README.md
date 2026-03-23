# OpenClaw Plugin For Codex App Server

This project has no product name. It is just an OpenClaw plugin that connects OpenClaw to the Codex App Server protocol so you can interact with your existing threads from Codex Desktop and Codex TUI through Telegram and Discord conversations.

`Codex` is mentioned here only to describe the protocol and toolchain this plugin connects to. This repository is independent and is not official, provided, sponsored, endorsed, or affiliated with OpenAI or Codex.

If `codex` already works on the machine running OpenClaw, this plugin should work too. It uses the same local Codex CLI and shared login state. There is no separate plugin login requirement for normal use.

## Quick Start

1. Install the plugin into OpenClaw.
2. Start in the Telegram or Discord conversation where you want the bridge bound.
3. Run `/cas_resume`.
4. Pick a project and thread, or search directly.
5. Once bound, plain text in that conversation routes to the selected Codex thread.

Buttons are presented for project and thread selection, model switching, and skill shortcuts. If your filter is ambiguous, the plugin sends a picker instead of guessing.

## Install In OpenClaw

These are the intended install commands for OpenClaw `2026.3.22` and newer, which include the binding and plugin interface this package requires.

Install:

```bash
openclaw plugins install openclaw-codex-app-server
```

Uninstall:

```bash
openclaw plugins uninstall openclaw-codex-app-server
```

OpenClaw `2026.3.22` and newer include the required binding and plugin interface changes. If you are testing before that release, use the local developer workflow at the bottom of this document.

Pre-release packages are published on matching npm dist-tags instead of `latest`. For example, a tag such as `v0.3.0-beta.1` publishes to `openclaw-codex-app-server@beta`, so `npm install openclaw-codex-app-server@latest` stays on the newest stable release.

## Why Try It

- Uses your existing local Codex CLI setup instead of a separate hosted bridge.
- Feels natural in chat: bind once with `/cas_resume`, then just talk.
- Keeps useful controls close at hand with `/cas_status`, `/cas_plan`, `/cas_review`, `/cas_model`, and more.
- Works well for Telegram and Discord conversations that you want tied to a real Codex thread.

## Typical Workflow

1. Run `/cas_resume` in the conversation you want to bind.
2. Use the picker buttons, or pass a filter like `/cas_resume release-fix` or `/cas_resume --projects`.
3. Send normal chat messages once the thread is bound.
4. Use control commands such as `/cas_status`, `/cas_plan`, `/cas_review`, `/cas_model`, and `/cas_stop` as needed.
5. If you leave plan mode through the normal `Implement this plan` button, you do not need `/cas_plan off`; use `/cas_plan off` only when you want to exit planning manually instead.

## Command Reference

| Command | What it does | Notes / examples |
| --- | --- | --- |
| `/cas_resume` | Bind this conversation to a Codex thread. | With no args, opens a picker for recent sessions in the current workspace. |
| `/cas_resume --projects` | Browse projects first. | Opens a project picker, then a thread picker. |
| `/cas_resume --all` | Search recent sessions across projects. | Useful when the thread is not in the current workspace. |
| `/cas_resume --cwd ~/github/openclaw` | Restrict browsing/search to one workspace. | `--cwd` accepts an absolute path or `~/...`. |
| `/cas_resume --sync` | Resume and try to sync the chat/topic name to the Codex thread. | You can combine this with other flags. |
| `/cas_resume release-fix` | Resume a matching thread by title or id. | If more than one thread matches, you get buttons to choose. |
| `/cas_status` | Show the current binding and thread state. | Includes thread id, model, workspace, sandbox, and permissions when available. |
| `/cas_detach` | Unbind this conversation from Codex. | Stops routing plain text from this conversation into the bound thread. |
| `/cas_stop` | Interrupt the active Codex run. | Only applies when a turn is currently in progress. |
| `/cas_steer <message>` | Send follow-up steer text to an active run. | Example: `/cas_steer focus on the failing tests first` |
| `/cas_plan <goal>` | Ask Codex to plan instead of execute. | The plugin relays plan questions and the final plan back into chat. |
| `/cas_plan off` | Exit plan mode for this conversation. | Use this when you want to leave planning manually instead of through the normal `Implement this plan` button. |
| `/cas_review` | Review the current uncommitted changes in the bound workspace. | Requires an existing binding. |
| `/cas_review <focus>` | Review with custom instructions. | Example: `/cas_review focus on thread selection regressions` |
| `/cas_compact` | Compact the bound Codex thread. | The plugin posts progress and final context usage. |
| `/cas_skills` | List available Codex skills for the workspace. | Adds buttons for up to eight skill shortcuts. |
| `/cas_skills review` | Filter the skills list. | Matches skill name, description, or cwd. |
| `/cas_experimental` | List experimental features reported by Codex. | Read-only. |
| `/cas_mcp` | List configured MCP servers. | Shows auth state and counts for tools/resources/templates. |
| `/cas_mcp github` | Filter MCP servers. | Matches name and auth status. |
| `/cas_fast` | Toggle fast mode for the bound thread. | Equivalent to switching the service tier between default and fast. |
| `/cas_fast on|off|status` | Set or inspect fast mode explicitly. | Example: `/cas_fast status` |
| `/cas_model` | List models and show model-selection buttons. | If the conversation is not bound yet, it lists models only. |
| `/cas_model gpt-5.4` | Set the model for the bound thread. | Requires an existing binding. |
| `/cas_permissions` | Show account, rate-limit, and thread permission information. | Works with or without a current binding. |
| `/cas_init ...` | Forward `/init` to Codex. | Sends the alias straight through to the App Server. |
| `/cas_diff ...` | Forward `/diff` to Codex. | Sends the alias straight through to the App Server. |
| `/cas_rename <new name>` | Rename the bound Codex thread. | Example: `/cas_rename approval flow cleanup` |
| `/cas_rename --sync <new name>` | Rename the thread and try to sync the conversation/topic name too. | Requires an existing binding. |

## Screenshot Placeholders

- `[TODO screenshot] /cas_resume --projects` project picker
- `[TODO screenshot] /cas_resume` thread picker with buttons
- `[TODO screenshot] bound conversation after /cas_status`
- `[TODO screenshot] /cas_model` button list

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
