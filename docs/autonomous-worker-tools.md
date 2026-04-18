# Autonomous Worker Tools

This document describes the **agent-callable** tool layer added on top of `openclaw-codex-app-server`.

## Goal

Allow OpenClaw to orchestrate one or more Codex workers **directly via Codex app-server**, without requiring a human to drive `/cas_resume`, `/cas_status`, or `/cas_endpoint` manually.

This is intended for flows like:

- `windows-main` -> browser / Jira / Teams / email / authenticated context worker
- `nestdev` -> repo implementation worker
- OpenClaw -> planner / router / memory / reporting layer

## Why direct app-server instead of MCP here?

Because the worker relationship is conversational/stateful:

- persistent threads
- turn execution
- resume / continue
- interrupt
- thread state and replay
- native Codex approvals / pending input semantics

MCP is still useful **inside** Codex for tools, but for **OpenClaw -> Codex worker control**, app-server is the primary transport.

## Exposed tools

### `codex_workers_describe_endpoints`

Returns:

- default endpoint
- default workspace/model
- configured endpoints
- whether each endpoint supports `full-access`

### `codex_workers_list_threads`

Lists threads on an endpoint.

Useful before reusing a thread or when trying to resolve a stable worker thread by name.

Key params:

- `endpointId`
- `workspaceDir`
- `includeAllWorkspaces`
- `filter`
- `permissionsMode`

### `codex_workers_run_task`

Runs a prompt on a Codex worker.

Supports:

- starting a fresh turn
- continuing an existing `threadId`
- creating a named thread with `threadName`
- reusing a named thread with `reuseThreadByName=true`
- optional model / reasoning / service tier overrides
- optional collaboration payload
- optional multimodal `input`

Key params:

- `endpointId`
- `prompt`
- `workspaceDir`
- `threadId`
- `threadName`
- `reuseThreadByName`
- `permissionsMode`
- `model`
- `reasoningEffort`
- `serviceTier`
- `collaborationMode`
- `input`

Return shape includes:

- resolved endpoint/workspace/profile
- resulting `threadId`
- whether a thread was created or reused
- any captured `pendingInput`
- the Codex turn result

### `codex_workers_read_thread_context`

Reads:

- thread state
- thread replay/context summary

Useful when OpenClaw wants to inspect a worker thread before resuming it.

## Pending input behavior

Autonomous tool calls cannot complete an interactive approval loop by themselves.

So the current behavior is:

1. detect pending approval/input
2. capture a compact `pendingInput` summary
3. interrupt the run
4. return control to OpenClaw

This avoids deadlocks.

## Recommended orchestration pattern

### Phase 1 — direct autonomous orchestration

Use these tools directly from OpenClaw:

1. gather context on `windows-main`
2. pass the structured result to `nestdev`
3. continue the same named thread when useful
4. inspect thread context if a run needs to be resumed later

### Phase 2 — add ClawFlow above it

ClawFlow is the natural next layer when you want:

- persistent multi-step jobs
- waiting/resume states
- small persisted outputs
- one owner session around multiple worker turns

So the intended stack is:

- **Codex app-server plugin tools first**
- **ClawFlow second**

## Safety / ops notes

- Prefer loopback or authenticated websocket endpoints.
- For autonomous write actions, use a dedicated endpoint/profile intentionally configured for that purpose.
- Keep `CAS` as the human fallback/debug surface even after autonomous tools are enabled.
