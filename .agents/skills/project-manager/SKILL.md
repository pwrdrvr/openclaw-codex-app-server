---
name: project-manager
description: "Manage GitHub issues and the GitHub Project board for this repository, while keeping the local tracker in sync. Use when the user wants to capture freeform requirements as issues, flesh out issue descriptions from repo or upstream research, triage Priority/Size/Workflow/Status, add issues or PRs to project 7, or reconcile GitHub state with `.local/work-items.yaml`."
---

# Project Manager

Use this skill for repo-specific project management on [OpenClaw Codex App Server Project](https://github.com/orgs/pwrdrvr/projects/7).

## Automation Preference

- Prefer Node scripts for repo-local automation.
- If a script needs dependencies, add them as repo `devDependencies` and invoke them through `pnpm` or `node`.
- Avoid Python for repo-local skill automation unless a Python-native library is clearly worth the extra runtime dependency.

## Canonical Locations

- Treat GitHub Issues and PRs as the public source of truth.
- Treat `.local/work-items.yaml` as a derived repo-local cross-reference map that can be regenerated from the project board.
- Put temporary issue writeups only in `.local/issue-drafts/`.
- Do not create parallel scratch directories or alternate tracker files for the same purpose.

Current repo-specific locations:

- Project board: `https://github.com/orgs/pwrdrvr/projects/7`
- Local tracker: `.local/work-items.yaml`
- Issue drafts: `.local/issue-drafts/`
- Local id prefix: `ocas-`

Refresh the derived tracker with:

```bash
pnpm project:sync
```

## Workflow

1. Explore before filing.

- Read local code, tests, docs, and upstream references before creating or expanding an issue.
- Prefer issue bodies with concrete findings, source pointers, and proposed scope over vague placeholders.

2. Draft locally when the issue is non-trivial.

- Write or refresh the issue body in `.local/issue-drafts/<nn>-<slug>.md`.
- Reuse that file for edits; do not fork the same issue into multiple local scratch notes.

3. Create or update the GitHub issue.

- Use `gh issue create`, `gh issue edit`, and `gh issue comment`.
- Keep titles short and imperative, usually starting with `Plugin:`.

4. Add the issue or PR to project `7`.

- Use `gh project item-add 7 --owner pwrdrvr --url <issue-or-pr-url>`.
- Set `Status`, `Priority`, `Size`, and `Workflow`.

5. Sync `.local/work-items.yaml`.

- Add or update the item entry with issue number, URLs, project item id, workflow, status, priority, size, and concise notes.
- Update `last_synced_at` whenever the tracker changes.
- Prefer pushing durable notes into GitHub issues or `.local/issue-drafts/`; the tracker should stay compact.

6. Reconcile if anything drifted.

- Use `gh issue list`, `gh project item-list`, and `gh project field-list` to confirm GitHub matches the local tracker.

## Field Conventions

- `Status`: `Inbox`, `Ready`, `In Progress`, `In Review`, `Done`
- `Workflow`: `Plan`, `Review`, `Threads`, `Worktrees`, `Branches`

Triage heuristic for this repo:

- `P0`: quick wins that shrink the board fast, plus high-visibility completeness or pizazz work
- `P1`: larger user-visible completeness work
- `P2`: infrastructure, refactors, planning spikes, and corner-case cleanup unless they are very quick

Size heuristic:

- `XS` or `S`: obvious quick wins
- `M`: bounded feature or bug fix with a few moving parts
- `L`: visible feature touching multiple flows
- `XL`: large architectural or cross-cutting work

## Command Pattern

Start by discovering current project field ids instead of assuming they never change:

```bash
gh project field-list 7 --owner pwrdrvr --format json
```

Typical flow:

```bash
gh issue create --repo pwrdrvr/openclaw-codex-app-server --title "<title>" --body-file .local/issue-drafts/<file>.md
gh project item-add 7 --owner pwrdrvr --url <issue-or-pr-url> --format json
gh project item-edit --project-id <project-id> --id <item-id> --field-id <field-id> --single-select-option-id <option-id>
gh project item-list 7 --owner pwrdrvr --format json
```

Refresh the local tracker:

```bash
pnpm project:sync
```

## Tracker Shape

Each `.local/work-items.yaml` item should keep:

- `local_id`
- `title`
- `repo`
- `source_note`
- `github.issue_number`
- `github.issue_url`
- `github.project_number`
- `github.project_url`
- `github.project_item_id`
- `state.issue_state`
- `state.project_status`
- `state.workflow`
- `state.priority`
- `state.size`
- optional branch / PR fields
- concise `notes`

Keep notes factual and short. Store raw findings and writeups in the issue draft file or GitHub issue, not as sprawling tracker prose.
