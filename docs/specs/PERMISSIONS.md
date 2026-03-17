# Permissions, Trust, and File-Edit Approvals

This document captures current findings about how Codex trust, approval policy, sandbox policy, and file-edit approvals work upstream in `openai/codex`, plus the implications for this plugin.

This is a notes/spec document only. It does not imply that the behavior described here has already been implemented in this repository.

## Summary

- Codex project trust affects the default approval policy.
- The app-server protocol supports per-thread and per-turn overrides for approval policy and sandbox policy.
- There is no request-time `trusted=true` override in the protocol.
- File-edit approvals are a real first-class Codex flow, not just an undo/revert UX.
- For file changes that require approval, `item/started` describes a proposed edit; `item/completed` is the authoritative applied/failed/declined result.

## Upstream Trust Model

The Codex TUI explicitly asks whether the current directory is trusted:

Source:
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/tui/src/onboarding/trust_directory.rs#L54-L66>

```rust
Paragraph::new(
    "Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt injection.".to_string(),
)

let options: Vec<(&str, TrustDirectorySelection)> = vec![
    ("Yes, continue", TrustDirectorySelection::Trust),
    ("No, quit", TrustDirectorySelection::Quit),
];
```

That trust state feeds into approval-policy defaults:

Source:
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/core/src/config/mod.rs#L2019-L2029>

```rust
let mut approval_policy = approval_policy_override
    .or(config_profile.approval_policy)
    .or(cfg.approval_policy)
    .unwrap_or_else(|| {
        if active_project.is_trusted() {
            AskForApproval::OnRequest
        } else if active_project.is_untrusted() {
            AskForApproval::UnlessTrusted
        } else {
            AskForApproval::default()
        }
    });
```

Implication:

- A trusted repo and an untrusted repo can behave differently even with the same `~/.codex/config.toml`.
- “Added in Desktop” and “trusted by Codex” should be treated as separate concepts unless proven otherwise.

## Request-Time Overrides Exist

The protocol allows request-time overrides for approval policy and sandbox policy.

Sources:
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadStartParams.ts#L10-L18>
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/ThreadResumeParams.ts#L22-L38>
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/TurnStartParams.ts#L14-L23>

```ts
export type ThreadStartParams = {
  ...
  approvalPolicy?: AskForApproval | null,
  sandbox?: SandboxMode | null,
  ...
}
```

```ts
export type ThreadResumeParams = {
  threadId: string,
  ...
  approvalPolicy?: AskForApproval | null,
  sandbox?: SandboxMode | null,
  ...
}
```

```ts
export type TurnStartParams = {
  threadId: string,
  input: Array<UserInput>,
  ...
  approvalPolicy?: AskForApproval | null,
  sandboxPolicy?: SandboxPolicy | null,
  ...
}
```

The protocol-level approval values include:

Source:
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/AskForApproval.ts#L5>

```ts
export type AskForApproval =
  | "untrusted"
  | "on-failure"
  | "on-request"
  | { "reject": { ... } }
  | "never";
```

Important constraint: this is not the same thing as passing a `trusted` flag. The client can request a different approval/sandbox mode, but trust itself is still a project-level concept.

Sandbox overrides are also validated server-side and can be rejected:

Source:
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/app-server/src/codex_message_processor.rs#L1659-L1680>

```rust
let requested_policy = sandbox_policy.map(|policy| policy.to_core());
...
Some(policy) => match self.config.permissions.sandbox_policy.can_set(&policy) {
    Ok(()) => { ... }
    Err(err) => {
        ...
        message: format!("invalid sandbox policy: {err}"),
        ...
    }
}
```

Implication:

- The client can ask for “full access” behavior via explicit approval/sandbox overrides.
- The client cannot directly ask the app-server to mark a project as trusted.
- Overrides are subject to server-side constraints and are not guaranteed to be accepted.

## File-Edit Approvals Are First-Class

The app-server documents file-change approval as a distinct lifecycle:

Source:
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#L848-L858>

```md
1. `item/started` — emits a `fileChange` item with `changes` (diff chunk summaries) and `status: "inProgress"`. Show the proposed edits and paths to the user.
2. `item/fileChange/requestApproval` (request) — includes `itemId`, `threadId`, `turnId`, and an optional `reason`.
3. Client response — `{ "decision": "accept" }` or `{ "decision": "decline" }`.
4. `serverRequest/resolved`
5. `item/completed` — returns the same `fileChange` item with `status` updated to `completed`, `failed`, or `declined` after the patch attempt.
```

The event handling implementation matches that documented order:

Source:
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/app-server/src/bespoke_event_handling.rs#L375-L400>

```rust
if first_start {
    let item = ThreadItem::FileChange {
        id: item_id.clone(),
        changes: patch_changes.clone(),
        status: PatchApplyStatus::InProgress,
    };
    ...
    .send_server_notification(ServerNotification::ItemStarted(notification))
    .await;
}

let params = FileChangeRequestApprovalParams {
    thread_id: conversation_id.to_string(),
    turn_id: turn_id.clone(),
    item_id: item_id.clone(),
    reason,
    grant_root,
};
let (pending_request_id, rx) = outgoing
    .send_request(ServerRequestPayload::FileChangeRequestApproval(params))
    .await;
```

The TUI also treats patch approval as a dedicated approval type:

Source:
- `openai/codex`: <https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/approval_overlay.rs#L159-L162>

```rust
ApprovalRequest::ApplyPatch { .. } => (
    patch_options(),
    "Would you like to make the following edits?".to_string(),
),
```

Implication:

- These approval prompts are real patch approvals.
- They are not just an undo button or post-edit confirmation flow.
- If our UI shows a file-change approval, it should present it as approval for a proposed edit.

## Implications For This Plugin

Relevant local files:

- [`src/client.ts`](../../src/client.ts)
- [`src/pending-input.ts`](../../src/pending-input.ts)
- [`src/controller.ts`](../../src/controller.ts)

Current direction implied by the upstream protocol:

- `item/started` for `fileChange` should be treated as a proposed edit, not proof that the edit has already been applied.
- If a matching `item/fileChange/requestApproval` arrives, the approval prompt should include the file list and, when practical, diff context derived from the already-known `fileChange` item.
- The safest data source for approval display is the cached `item/started` payload keyed by `itemId`, not a best-effort re-read later.
- `item/completed` should be treated as the authoritative applied/failed/declined outcome.

This matters because a chat client can otherwise produce a confusing sequence such as:

1. “Edited `README.md` (+1 -1)”
2. “Approve File Changes”

That wording makes the approval look redundant or mistaken, even when the upstream protocol is behaving correctly.

## Current OpenClaw Gaps To Keep In Mind

These are not implementation decisions yet, just the known gaps to preserve in future work:

- We may want an operator-controlled way to request explicit `approvalPolicy` and sandbox overrides when starting/resuming a thread.
- If an approval prompt is shown, it should ideally carry the affected file list and maybe a compact diff summary.
- For channels like Telegram/Discord, the primary UX should probably remain a concise text summary, with optional diff attachment or fenced `diff` snippet as a secondary artifact.
- The thread or status output may need to surface the effective approval/sandbox mode so trust-driven behavior is easier to understand during debugging.
