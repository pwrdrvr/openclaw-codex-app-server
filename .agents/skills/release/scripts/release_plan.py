#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SEMVER_TAG_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")
CONVENTIONAL_RE = re.compile(r"^(?P<type>[a-z]+)(?:\([^)]+\))?(?P<breaking>!)?: (?P<summary>.+)$")
TRAILING_PR_RE = re.compile(r"\s+\(#\d+\)$")
HOUSEKEEPING_SUBJECT_RES = (
    re.compile(r"^docs: (?:add|update|write) changelog\b", re.IGNORECASE),
    re.compile(r"^chore(?:\(release\))?: release\b", re.IGNORECASE),
    re.compile(r"^chore(?:\(release\))?: prepare v\d+\.\d+\.\d+\b", re.IGNORECASE),
)
PATCH_TYPES = {"fix", "docs", "ci", "build", "chore", "deps", "test"}
FEATURE_TYPES = {"feat", "perf", "refactor"}
TYPE_ORDER = ["feat", "fix", "perf", "refactor", "docs", "test", "ci", "build", "chore", "deps", "other"]
SECTION_LABELS = {
    "feat": "Highlights",
    "fix": "Fixes",
    "perf": "Performance",
    "refactor": "Internal",
    "docs": "Docs",
    "test": "Internal",
    "ci": "Internal",
    "build": "Internal",
    "chore": "Internal",
    "deps": "Internal",
    "other": "Internal",
}
PATCH_WINDOW_DAYS = 7


@dataclass
class ReleaseInfo:
    tag: str
    name: str | None
    published_at: str | None


def run(cmd: list[str], cwd: str | None = None, check: bool = True) -> str:
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise RuntimeError(
            f"Command failed ({proc.returncode}): {' '.join(cmd)}\n"
            f"stdout:\n{proc.stdout}\n"
            f"stderr:\n{proc.stderr}"
        )
    return proc.stdout


def json_cmd(cmd: list[str], cwd: str | None = None) -> Any:
    output = run(cmd, cwd=cwd)
    if not output.strip():
        return None
    return json.loads(output)


def git(*args: str, cwd: str) -> str:
    return run(["git", *args], cwd=cwd).strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect release planning facts for a GitHub-release workflow.")
    parser.add_argument(
        "--output-dir",
        default=".local/release",
        help="Directory for release-plan.json and release-plan.md (default: .local/release)",
    )
    return parser.parse_args()


def iso_to_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def current_iso_date() -> str:
    return datetime.now().date().isoformat()


def parse_semver(tag: str) -> tuple[int, int, int]:
    match = SEMVER_TAG_RE.match(tag)
    if not match:
        raise ValueError(f"Unsupported tag format: {tag}")
    return tuple(int(part) for part in match.groups())


def format_tag(parts: tuple[int, int, int]) -> str:
    major, minor, patch = parts
    return f"v{major}.{minor}.{patch}"


def strip_conventional(subject: str) -> tuple[str, str]:
    cleaned = TRAILING_PR_RE.sub("", subject).strip()
    match = CONVENTIONAL_RE.match(cleaned)
    if not match:
        return "other", cleaned
    change_type = match.group("type")
    summary = match.group("summary").strip()
    return change_type, summary


def prioritize_type(types: set[str]) -> str:
    normalized = {change_type if change_type in SECTION_LABELS else "other" for change_type in types}
    for change_type in TYPE_ORDER:
        if change_type in normalized:
            return change_type
    return "other"


def is_housekeeping_commit(subject: str, files: list[str]) -> bool:
    normalized_files = [path for path in files if path]
    if normalized_files and set(normalized_files) == {"CHANGELOG.md"}:
        return True
    return any(pattern.search(subject) for pattern in HOUSEKEEPING_SUBJECT_RES)


def filter_status_lines(status_output: str, ignored_prefixes: list[str]) -> list[str]:
    kept: list[str] = []
    normalized_prefixes = [prefix.rstrip("/") + "/" for prefix in ignored_prefixes if prefix and prefix != "."]
    for raw_line in status_output.splitlines():
        line = raw_line.rstrip()
        if not line:
            continue
        path_part = line[3:] if len(line) > 3 else ""
        candidates = [candidate.strip() for candidate in path_part.split(" -> ")]
        if candidates and all(
            any(candidate == prefix[:-1] or candidate.startswith(prefix) for prefix in normalized_prefixes)
            for candidate in candidates
        ):
            continue
        kept.append(line)
    return kept


def get_repo_info(repo_root: str) -> dict[str, Any]:
    info = json_cmd(["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef,url"], cwd=repo_root)
    if not info or "nameWithOwner" not in info:
        raise RuntimeError("Could not determine repository info from gh repo view.")
    return info


def get_last_release(repo_root: str) -> ReleaseInfo | None:
    releases = json_cmd(
        [
            "gh",
            "release",
            "list",
            "--exclude-drafts",
            "--exclude-pre-releases",
            "--limit",
            "100",
            "--json",
            "tagName,name,publishedAt",
        ],
        cwd=repo_root,
    )
    for release in releases or []:
        tag = release.get("tagName")
        if tag and SEMVER_TAG_RE.match(tag):
            return ReleaseInfo(tag=tag, name=release.get("name"), published_at=release.get("publishedAt"))
    return None


def get_commit_files(repo_root: str, sha: str) -> list[str]:
    output = git("diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha, cwd=repo_root)
    return [line for line in output.splitlines() if line.strip()]


def get_commit_metadata(repo_root: str, sha: str) -> dict[str, Any]:
    output = run(
        ["git", "show", "-s", "--format=%H%x1f%s%x1f%an%x1f%ae%x1f%cI%x1f%b%x1e", sha],
        cwd=repo_root,
    ).rstrip("\n")
    if output.endswith("\x1e"):
        output = output[:-1]
    fields = output.split("\x1f", 5)
    if len(fields) != 6:
        raise RuntimeError(f"Unexpected git show output for {sha}")
    _, subject, author_name, author_email, committed_at, body = fields
    body = body.strip()
    files = get_commit_files(repo_root, sha)
    change_type, summary_seed = strip_conventional(subject)
    return {
        "sha": sha,
        "shortSha": sha[:7],
        "subject": subject,
        "body": body,
        "authorName": author_name,
        "authorEmail": author_email,
        "committedAt": committed_at,
        "files": files,
        "changeType": change_type,
        "summarySeed": summary_seed,
    }


def get_associated_pr(repo_root: str, repo_name: str, sha: str) -> dict[str, Any] | None:
    pulls = json_cmd(["gh", "api", f"repos/{repo_name}/commits/{sha}/pulls"], cwd=repo_root) or []
    if not pulls:
        return None
    selected = None
    for pull in pulls:
        if pull.get("merge_commit_sha") == sha:
            selected = pull
            break
    if selected is None:
        selected = pulls[0]
    author = selected.get("user") or {}
    return {
        "number": selected.get("number"),
        "title": selected.get("title"),
        "url": selected.get("html_url"),
        "authorLogin": author.get("login"),
        "mergeCommitSha": selected.get("merge_commit_sha"),
        "mergedAt": selected.get("merged_at"),
    }


def suggest_version(last_release: ReleaseInfo | None, meaningful_commits: list[dict[str, Any]]) -> dict[str, Any]:
    if last_release is None:
        return {
            "tag": "v0.1.0",
            "kind": "minor",
            "reason": "No published semver release was found, so start at v0.1.0.",
            "minorAlternative": None,
            "patchAlternative": None,
        }

    major, minor, patch = parse_semver(last_release.tag)
    minor_tag = format_tag((major, minor + 1, 0))
    patch_tag = format_tag((major, minor, patch + 1))
    published_at = iso_to_datetime(last_release.published_at)
    age_days = None
    if published_at is not None:
        age_days = (datetime.now(timezone.utc) - published_at).total_seconds() / 86400

    types = {commit["changeType"] for commit in meaningful_commits}
    patch_candidate = (
        meaningful_commits
        and len(meaningful_commits) <= 3
        and (age_days is not None and age_days <= PATCH_WINDOW_DAYS)
        and types.issubset(PATCH_TYPES)
        and not any(change_type in FEATURE_TYPES for change_type in types)
    )

    if patch_candidate:
        reason = (
            f"Patch suggested because the last release was only {age_days:.1f} days ago, "
            f"there are {len(meaningful_commits)} meaningful commits, and they all look patch-sized."
        )
        return {
            "tag": patch_tag,
            "kind": "patch",
            "reason": reason,
            "minorAlternative": minor_tag,
            "patchAlternative": None,
        }

    reason = (
        f"Minor suggested because the default release policy is a minor bump and this range includes "
        f"{len(meaningful_commits)} meaningful commits"
    )
    if any(change_type in FEATURE_TYPES for change_type in types):
        reason += " with feature/performance/refactor work."
    else:
        reason += "."
    return {
        "tag": minor_tag,
        "kind": "minor",
        "reason": reason,
        "minorAlternative": None,
        "patchAlternative": patch_tag,
    }


def build_release_items(repo_root: str, repo_name: str, commits: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: "OrderedDict[str, dict[str, Any]]" = OrderedDict()
    direct_count = 0

    for commit in commits:
        associated_pr = get_associated_pr(repo_root, repo_name, commit["sha"])
        if associated_pr and associated_pr.get("number") is not None:
            key = f"pr-{associated_pr['number']}"
            entry = grouped.get(key)
            if entry is None:
                entry = {
                    "kind": "pr",
                    "pr": associated_pr,
                    "commits": [],
                    "types": set(),
                }
                grouped[key] = entry
            entry["commits"].append(commit)
            entry["types"].add(commit["changeType"])
        else:
            key = f"commit-{direct_count}"
            direct_count += 1
            grouped[key] = {
                "kind": "commit",
                "commit": commit,
                "types": {commit["changeType"]},
            }

    items: list[dict[str, Any]] = []
    for entry in grouped.values():
        dominant_type = prioritize_type(entry["types"])
        if entry["kind"] == "pr":
            pr = entry["pr"]
            commit_summaries = [commit["summarySeed"] for commit in entry["commits"]]
            items.append(
                {
                    "kind": "pr",
                    "section": SECTION_LABELS[dominant_type],
                    "changeType": dominant_type,
                    "pr": pr,
                    "summarySeed": commit_summaries[0],
                    "rawTitle": pr.get("title"),
                    "contributorMention": f"@{pr['authorLogin']}" if pr.get("authorLogin") else None,
                    "commits": entry["commits"],
                    "rawInputs": commit_summaries,
                }
            )
        else:
            commit = entry["commit"]
            items.append(
                {
                    "kind": "commit",
                    "section": SECTION_LABELS[dominant_type],
                    "changeType": dominant_type,
                    "summarySeed": commit["summarySeed"],
                    "commit": commit,
                    "rawInputs": [commit["summarySeed"]],
                }
            )
    return items


def render_markdown(plan: dict[str, Any]) -> str:
    lines: list[str] = []
    repo = plan["repository"]["nameWithOwner"]
    lines.append("# Release Plan")
    lines.append("")
    lines.append(f"- Repo: `{repo}`")
    lines.append(f"- Default branch: `{plan['repository']['defaultBranch']}`")
    lines.append(f"- Planned branch tip: `{plan['planning']['baseSha']}`")
    lines.append(f"- Current branch: `{plan['workingTree']['currentBranch']}`")
    lines.append(f"- Clean working tree: `{str(plan['workingTree']['isClean']).lower()}`")

    last_release = plan.get("lastRelease")
    if last_release:
      lines.append(f"- Last release: `{last_release['tag']}` published `{last_release.get('publishedAt') or 'unknown'}`")
    else:
      lines.append("- Last release: none found")

    lines.append(f"- Commits on main since last release: `{plan['counts']['rawCommitCount']}`")
    lines.append(f"- Meaningful commits after filtering housekeeping: `{plan['counts']['meaningfulCommitCount']}`")
    lines.append(f"- Suggested tag: `{plan['suggestedVersion']['tag']}` ({plan['suggestedVersion']['kind']})")
    lines.append(f"- Version rationale: {plan['suggestedVersion']['reason']}")
    if plan["warnings"]:
        lines.append("")
        lines.append("## Warnings")
        lines.append("")
        for warning in plan["warnings"]:
            lines.append(f"- {warning}")

    if plan["ignoredCommits"]:
        lines.append("")
        lines.append("## Ignored Housekeeping Commits")
        lines.append("")
        for commit in plan["ignoredCommits"]:
            lines.append(f"- `{commit['shortSha']}` {commit['subject']}")

    if plan["items"]:
        lines.append("")
        lines.append("## Raw Release Inputs")
        lines.append("")
        grouped_items: "OrderedDict[str, list[dict[str, Any]]]" = OrderedDict()
        for item in plan["items"]:
            grouped_items.setdefault(item["section"], []).append(item)
        for section, section_items in grouped_items.items():
            lines.append(f"### {section}")
            lines.append("")
            for item in section_items:
                if item["kind"] == "pr":
                    pr = item["pr"]
                    mention = item["contributorMention"] or "unknown author"
                    lines.append(
                        f"- PR #{pr['number']}: seed `{item['summarySeed']}`; raw title `{item['rawTitle']}`; contributor {mention}"
                    )
                    for commit in item["commits"]:
                        lines.append(f"  - `{commit['shortSha']}` {commit['subject']}")
                else:
                    commit = item["commit"]
                    lines.append(f"- Direct commit `{commit['shortSha']}`: seed `{item['summarySeed']}` from `{commit['subject']}`")
            lines.append("")

    lines.append("## Changelog Heading")
    lines.append("")
    lines.append(f"Use this heading in `CHANGELOG.md`: `## {plan['suggestedVersion']['tag']} - {plan['generatedAtDate']}`")
    lines.append("")
    lines.append("Do not copy the raw titles verbatim into the release notes; rewrite them.")
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    args = parse_args()
    repo_root = git("rev-parse", "--show-toplevel", cwd=os.getcwd())
    output_dir = Path(repo_root) / args.output_dir
    try:
        output_dir_rel = output_dir.relative_to(Path(repo_root)).as_posix()
    except ValueError:
        output_dir_rel = ""
    repo_info = get_repo_info(repo_root)
    repo_name = repo_info["nameWithOwner"]
    default_branch = repo_info["defaultBranchRef"]["name"]
    remote_ref = f"refs/remotes/origin/{default_branch}"

    try:
        base_sha = git("rev-parse", remote_ref, cwd=repo_root)
    except RuntimeError:
        base_sha = git("rev-parse", default_branch, cwd=repo_root)

    current_branch = git("branch", "--show-current", cwd=repo_root) or "(detached HEAD)"
    working_tree_status = git("status", "--porcelain", "--untracked-files=all", cwd=repo_root)
    filtered_status_lines = filter_status_lines(working_tree_status, [output_dir_rel])
    is_clean = len(filtered_status_lines) == 0
    local_head = git("rev-parse", "HEAD", cwd=repo_root)

    last_release = get_last_release(repo_root)
    if last_release is None:
        commit_range = base_sha
        raw_commit_shas = git("rev-list", "--first-parent", "--reverse", base_sha, cwd=repo_root).splitlines()
    else:
        commit_range = f"{last_release.tag}..{base_sha}"
        raw_commit_output = git("rev-list", "--first-parent", "--reverse", commit_range, cwd=repo_root)
        raw_commit_shas = [line for line in raw_commit_output.splitlines() if line.strip()]

    raw_commits = [get_commit_metadata(repo_root, sha) for sha in raw_commit_shas]

    meaningful_commits: list[dict[str, Any]] = []
    ignored_commits: list[dict[str, Any]] = []
    for commit in raw_commits:
        if is_housekeeping_commit(commit["subject"], commit["files"]):
            ignored_commits.append(commit)
        else:
            meaningful_commits.append(commit)

    items = build_release_items(repo_root, repo_name, meaningful_commits)
    suggested_version = suggest_version(last_release, meaningful_commits)

    warnings: list[str] = []
    if not is_clean:
        warnings.append("Working tree is not clean; pause before editing or releasing.")
    if current_branch != default_branch:
        warnings.append(f"Current branch is {current_branch}, not the default branch {default_branch}.")
    if local_head != base_sha:
        warnings.append(
            f"Local HEAD {local_head[:7]} does not match origin/{default_branch} {base_sha[:7]}; fast-forward before releasing."
        )
    if len(meaningful_commits) < 3:
        warnings.append(
            f"Only {len(meaningful_commits)} meaningful commit(s) landed since the last release; warn before asking for approval."
        )
    if len(meaningful_commits) == 0:
        warnings.append("There are no meaningful commits to release after filtering housekeeping commits.")

    plan = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "generatedAtDate": current_iso_date(),
        "repository": {
            "nameWithOwner": repo_name,
            "url": repo_info["url"],
            "defaultBranch": default_branch,
        },
        "planning": {
            "baseRef": remote_ref,
            "baseSha": base_sha,
            "range": commit_range,
        },
        "workingTree": {
            "currentBranch": current_branch,
            "isClean": is_clean,
            "localHead": local_head,
            "statusLines": filtered_status_lines,
        },
        "lastRelease": (
            {
                "tag": last_release.tag,
                "name": last_release.name,
                "publishedAt": last_release.published_at,
            }
            if last_release
            else None
        ),
        "counts": {
            "rawCommitCount": len(raw_commits),
            "meaningfulCommitCount": len(meaningful_commits),
            "releaseItemCount": len(items),
        },
        "suggestedVersion": suggested_version,
        "warnings": warnings,
        "ignoredCommits": ignored_commits,
        "rawCommits": raw_commits,
        "items": items,
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / "release-plan.json"
    markdown_path = output_dir / "release-plan.md"
    json_path.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(plan), encoding="utf-8")

    print(f"Wrote {json_path}")
    print(f"Wrote {markdown_path}")
    print(f"Suggested tag: {suggested_version['tag']}")
    print(f"Meaningful commits since last release: {len(meaningful_commits)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
