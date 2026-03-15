# OpenClaw Codex App Server Plugin

Codex App Server as an OpenClaw plugin for Telegram and Discord conversations. It binds a chat to a Codex thread, forwards plain-text messages into that thread, and exposes command-driven controls for resume, planning, review, model selection, compaction, and more.

## Local Setup Before OpenClaw PR #45318 Lands

This plugin targets the plugin interface from [openclaw/openclaw#45318](https://github.com/openclaw/openclaw/pull/45318). Until that work is merged and shipped in the latest OpenClaw release, develop against a local OpenClaw checkout on that PR branch or `main` once merged.

### 0. Clone this repository

```bash
git clone <this-repo-url>
cd openclaw-codex-app-server
```

### 1. Check out OpenClaw with the plugin interface

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

Once the PR is merged, use `main` instead.

### 2. Install the plugin from your local checkout

From the openclaw repository:

```bash
pnpm openclaw plugins install --link "/absolute/path/to/openclaw-codex-app-server"
```

### 3. Start OpenClaw

From your OpenClaw checkout:

```bash
pnpm gateway:watch
```

### Optional: override `openclaw` locally inside this repo

This repository no longer commits a machine-local `openclaw` dev dependency, so CI stays portable. If you want a local checkout of this plugin repo to resolve `openclaw` from your own OpenClaw source tree, add a local-only override in your working copy:

```bash
pnpm add -D openclaw@file:/absolute/path/to/openclaw
pnpm install
```

That override is for local development only. Do not commit the resulting `package.json` or `pnpm-lock.yaml` changes.

## Typical Workflow

1. Start in the Telegram or Discord conversation where you want Codex bound.
2. Run `/codex_resume`.
3. Use the buttons to browse projects and threads, or pass filters in the command.
4. Once bound, plain text in that conversation routes to the selected Codex thread.
5. Use the control commands below as needed.

Buttons are presented for project and thread selection, model switching, and skill shortcuts. If your filter is ambiguous, the plugin sends a picker instead of guessing.

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
| `/codex_plan off` | Exit plan mode for this conversation. | Interrupts a lingering plan run so future turns go back to default coding mode. |
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

## Development Checks

```bash
pnpm test
pnpm typecheck
```
