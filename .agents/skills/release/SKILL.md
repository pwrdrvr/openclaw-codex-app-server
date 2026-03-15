---
name: release
description: "Plan and publish a GitHub Release in a tag-driven repository. Use when a user asks to cut, prepare, or publish a software release, propose the next vX.Y.Z tag, draft better release notes from PRs and direct commits since the last release, update CHANGELOG.md, create the tag pinned to an exact commit, and watch the publish workflow."
---

# Release

Use this skill for repos that publish from GitHub Releases and want human-written notes instead of GitHub's generated summary.

## Guardrails

- Prefer the repo's default branch from `gh repo view`; do not guess.
- Start from a clean working tree. If tracked files are dirty, stop and ask before continuing.
- If the current branch is not the default branch, stop and ask before switching.
- Fetch before planning: `git fetch origin --tags`.
- Fast-forward the default branch before editing: `git pull --ff-only origin <default-branch>`.
- Never force-push the default branch.
- Never use GitHub generated release notes for this workflow.
- Always create the release tag with a leading `v`, for example `v0.1.0`.
- Always pin the release to the exact changelog commit SHA with `gh release create --target <sha>`.
- If `origin/<default-branch>` moves after planning or before pushing, stop and regenerate the release plan.

## Helper Script

Use the bundled planner to gather release facts and raw note inputs:

```bash
python3 .agents/skills/release/scripts/release_plan.py --output-dir .local/release
```

It writes:

- `.local/release/release-plan.json`
- `.local/release/release-plan.md`

The planner:

- finds the latest published semver release
- counts first-parent commits on the default branch since that release
- filters leaked release-housekeeping commits such as changelog-only commits
- proposes the next tag
- groups PR-backed changes separately from direct commits on `main`
- captures contributor mentions for PR-backed items

## Approval Prompt

Before making any changelog edit, commit, push, tag, or release, show the user:

- the last release tag
- the raw and meaningful commit counts since that release
- the suggested new tag and why
- whether the change looks like a minor release or a small emergency patch
- the exact commit SHA currently at `origin/<default-branch>`

If the meaningful commit count is less than `3`, explicitly warn that there are not many changes in this release and ask whether they still want to proceed.

## Notes And Changelog Rules

- Do not copy PR titles verbatim into release notes.
- Rewrite each PR-backed item into a clearer user-facing bullet.
- For direct commits on `main` with no PR, use the commit subject and body as raw input and rewrite those too.
- Add the PR author mention on the same line for PR-backed entries.
- Keep the same substance in `CHANGELOG.md` and the GitHub release notes.
- Prefer grouped sections such as `Highlights`, `Fixes`, `Performance`, `Docs`, and `Internal` when they fit the release.
- If `CHANGELOG.md` does not exist, create it with a `# Changelog` header.
- Insert the new release section at the top, directly under the file header if there is one.
- Use a heading in this shape:

```md
## v0.1.0 - 2026-03-15
```

- If you make a dedicated changelog commit, use a subject like:

```bash
docs: add changelog for v0.1.0
```

## Versioning Heuristic

Use the planner's suggestion unless the user overrides it.

- Default to a minor bump: `v0.1.0` -> `v0.2.0`.
- Use a patch bump only for a small hotfix shortly after the previous release.
- Treat `v0.9.0` -> `v0.10.0` as the normal next minor bump.
- Do not jump from `v0.9.0` to `v1.0.0` unless the user explicitly asks.

The bundled planner treats a patch release as the default only when all of these are true:

- the last release is recent
- there are only a few meaningful commits
- the included changes are patch-sized fix/docs/ci/chore/deps style work
- there is no obvious feature or larger performance/restructure change

## Execution Flow

1. Prepare the repo.

```bash
git fetch origin --tags
default_branch=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
current_branch=$(git branch --show-current)
test "$current_branch" = "$default_branch"
git pull --ff-only origin "$default_branch"
python3 .agents/skills/release/scripts/release_plan.py --output-dir .local/release
```

2. Read `.local/release/release-plan.md` and summarize the proposed release for approval.

3. After approval, write:

- `.local/release/release-notes.md`
- `CHANGELOG.md`

4. Commit and push the changelog commit on top of the planned branch tip.

```bash
git add CHANGELOG.md
git commit -m "docs: add changelog for <tag>"
git push origin HEAD:"$default_branch"
release_sha=$(git rev-parse HEAD)
```

5. Create the release from that exact commit.

```bash
gh release create "<tag>" \
  --target "$release_sha" \
  --title "<tag>" \
  --notes-file .local/release/release-notes.md
```

6. Verify the release and watch the publish workflow.

```bash
gh release view "<tag>"
run_id=$(gh run list --workflow publish.yml --event release --limit 10 --json databaseId,headSha,status,conclusion \
  --jq '.[] | select(.headSha == "'"$release_sha"'") | .databaseId' | head -n1)
gh run watch "$run_id"
```

If the publish workflow fails, inspect it yourself:

```bash
gh run view "$run_id" --log-failed
```

## Best Practices

- Re-read the generated notes before publishing; fix awkward wording instead of shipping raw commit text.
- Keep release bullets user-facing and outcome-oriented, not implementation-jargon heavy.
- Mention direct-to-main commits that would otherwise be invisible to GitHub's PR-based notes.
- If the approval gap was long, rerun the planner immediately before editing `CHANGELOG.md`.
- If the push to the default branch is rejected, stop and regenerate notes from the new branch tip instead of rebasing blindly.
