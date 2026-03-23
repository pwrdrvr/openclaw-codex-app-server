---
name: test-ocas-openclaw
description: "Regression test the OpenClaw Codex App Server plugin against a live local OpenClaw instance in Telegram or Discord. Use when the user wants an end-to-end OCAS manual test pass, wants to verify binding, approvals, plan mode, review, compact, model, skills, MCP, rename, or other slash-command behavior, or wants reproducible bug notes from a live chat integration run."
---

# Test OCAS OpenClaw

Use this skill for manual regression passes of this plugin against a real local OpenClaw instance.

## Preconditions

- Confirm the plugin branch under test is linked into the local OpenClaw checkout and OpenClaw is running.
- If the test uses Telegram Web, use [$agent-browser](https://github.com/vercel-labs/agent-browser) from `~/.agents/skills/agent-browser`.
- If Telegram Web or Discord is not logged in, stop and ask the user to complete login.
- Prefer a low-risk Codex thread unless the user asks otherwise. In this repo, `discrawl` and `dupcanon` are safe defaults for resume tests.

## Canonical State Files

Use these when the UI and the plugin disagree:

- Core chat binding store: `~/.openclaw/telegram/thread-bindings-default.json`
- Plugin state: `~/.openclaw/openclaw-codex-app-server/state.json`

Read them when:

- a topic looks bound but `/cas_status` disagrees
- plan mode appears stuck
- a questionnaire should exist but Telegram Web does not render it
- slash replies appear in the wrong chat or topic

Treat the state files as diagnostic evidence, not as a thing to hand-edit.

## Regression Flow

1. Establish the target conversation.

- Stay in the requested group, DM, channel, or topic for the entire pass.
- If the expected Telegram topic is missing, check whether `/cas_resume --sync` renamed it. Rename it back or create a fresh test topic if needed.
- If slash-command routing leaks into `General`, log that as a bug and move the browser back to the intended topic before continuing.

2. Baseline the conversation.

- Run `/cas_status`.
- If the topic is already bound, run `/cas_detach` first, then confirm the unbound state with `/cas_status`.
- For Telegram topics, the reply must appear in the same topic. If it lands in `General`, record a routing bug.

3. Resume a thread.

- Prefer `/cas_resume` or `/cas_resume --all` with the normal picker flow.
- Avoid `/cas_resume --all <thread-id>` for now. It is a known regression path and may not surface the expected approval UX.
- When approval appears, use Allow Once unless the user asks otherwise.
- After binding, send `who are you`.
- Expect a Codex response. If the reply sounds like OpenClaw persona text instead of Codex, the bind failed.
- Run `/cas_status` again and verify:
  - `Binding: active`
  - the expected thread id or thread title
  - the expected model
  - `Plugin version: 0.0.0` for local dev branch testing when that is the expected version

4. Verify approval rendering.

- Send this exact prompt as plain text in the bound conversation:

```text
I want you to run `npm view dive` and make sure to ask to exit the sandbox as it needs network access.
```

- Expect a real execution approval dialog, not a plain text question about whether the user wants approval.
- Expect approval buttons such as `Approve` or the platform-equivalent action controls.
- Expect a code-formatted command area that shows `npm view dive`.
- Verify the displayed command is trimmed for presentation and does not leak a shell-launcher wrapper like `/bin/zsh -lc ...`.
- After verifying the dialog, approve the command with `Approve Once` or the platform-equivalent approval button so later tests are not blocked by a stale pending approval.
- If the model only asks a conversational question like "Do you want to allow..." without rendering execution approval controls, treat that test as invalid and rerun with the exact prompt above.

5. Verify plan mode.

- Use `/cas_plan <prompt>`. Do not test plan mode by sending the raw prompt without the command.
- Use a short questionnaire prompt first. A breakfast-choice prompt is good because it exercises `Prev`, `Next`, and a final Implement button.
- Expect:
  - questionnaire text
  - answer buttons
  - `Prev` and `Next` navigation when appropriate
  - final `Implement this plan?` buttons
- If plan mode gets stuck, `/cas_plan off` should exit it.

6. Verify long-plan truncation.

- Ask for a final plan longer than 4000 characters.
- Expect the Telegram preview to truncate and the plugin to attach the full Markdown plan when needed.

7. Cover other control commands as needed.

- `/cas_review`
  - Expected desktop-style base and branch questions may be missing. Log that if review starts immediately.
- `/cas_mcp`
  - Expect a list of configured MCP servers.
- `/cas_skills`
  - Expect installed skills. Current behavior may duplicate a text list plus buttons; log that as a display issue rather than a blocker.
- `/cas_model`
  - Expect model list and selection controls.
  - Model selection may not fully reflect back into `/cas_status` yet; log that mismatch.
- `/cas_fast`
  - Verify `on`, `off`, and `status` behavior when the conversation is bound.
- `/cas_compact`
  - Expect progress keepalives and a final context-usage report.
- `/cas_rename`
  - Verify thread rename and, if requested, `--sync` topic rename behavior.
- `/cas_diff`, `/cas_permissions`, `/cas_init`
  - Verify current forward-or-placeholder behavior instead of assuming full implementation.

8. Clean up.

- End by running `/cas_detach`.
- Confirm the conversation is no longer bound.

## Gotchas

- Telegram Web can go stale. If a simple request appears hung for more than about one minute, and the local state file already shows the pending questionnaire or callbacks, refresh Telegram Web with `Cmd+R` before calling it a backend bug.
- Plain text can still route correctly even when slash commands from a topic leak to `General`. Record both facts separately.
- A core binding can exist in `thread-bindings-default.json` while plugin-local state is stale or missing. Compare both files before concluding which side is wrong.
- Keep the browser anchored to the correct topic. It is easy to drift into `General` or the chat list while testing.

## Evidence To Capture

- Exact command sent
- Exact chat or topic where the reply appeared
- Whether the reply was plain text, buttons, or an attachment
- Relevant snippets from `state.json` and `thread-bindings-default.json` when UI behavior is suspicious
- Known-good versus observed behavior

## Formal Bug Notes

If the user wants the findings turned into issues, PR notes, or project-board items, use [$project-manager](./.agents/skills/project-manager/SKILL.md).
