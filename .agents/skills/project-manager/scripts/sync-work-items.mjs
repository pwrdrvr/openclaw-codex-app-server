#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const REPO = "pwrdrvr/openclaw-codex-app-server";
const PROJECT_OWNER = "pwrdrvr";
const PROJECT_NUMBER = 7;
const PROJECT_URL = "https://github.com/orgs/pwrdrvr/projects/7";
const TRACKER_PATH = path.resolve(".local/work-items.yaml");

function runGh(args) {
  return execFileSync("gh", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function loadExistingTracker() {
  if (!fs.existsSync(TRACKER_PATH)) {
    return { version: 1, last_synced_at: null, items: [] };
  }

  const raw = fs.readFileSync(TRACKER_PATH, "utf8");
  const parsed = YAML.parse(raw) ?? {};
  return {
    version: parsed.version ?? 1,
    last_synced_at: parsed.last_synced_at ?? null,
    items: Array.isArray(parsed.items) ? parsed.items : [],
  };
}

function normalizeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nextLocalId(existingItems) {
  let max = 0;
  for (const item of existingItems) {
    const match =
      typeof item?.local_id === "string" ? item.local_id.match(/^ocas-(\d{4,})$/) : null;
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `ocas-${String(max + 1).padStart(4, "0")}`;
}

function mergeExistingItem(existingByIssue, issueNumber, fallbackLocalId) {
  const current = existingByIssue.get(issueNumber);
  if (current && typeof current === "object" && current !== null) {
    return structuredClone(current);
  }
  return {
    local_id: fallbackLocalId,
    title: "",
    repo: REPO,
    source_note: "",
    github: {},
    state: {},
    notes: [],
  };
}

function main() {
  const existing = loadExistingTracker();
  const existingByIssue = new Map();
  for (const item of existing.items) {
    const issueNumber = normalizeNumber(item?.github?.issue_number);
    if (issueNumber > 0) {
      existingByIssue.set(issueNumber, item);
    }
  }

  const issueList = JSON.parse(
    runGh(["issue", "list", "--repo", REPO, "--state", "all", "--limit", "500", "--json", "number,state,title,url"]),
  );
  const issueByNumber = new Map(issueList.map((issue) => [issue.number, issue]));

  const projectData = JSON.parse(
    runGh(["project", "item-list", String(PROJECT_NUMBER), "--owner", PROJECT_OWNER, "--format", "json"]),
  );

  const items = [];
  for (const item of projectData.items ?? []) {
    const content = item?.content ?? {};
    if (content.type !== "Issue") {
      continue;
    }
    if (content.repository !== REPO) {
      continue;
    }
    const issueNumber = normalizeNumber(content.number);
    if (issueNumber <= 0) {
      continue;
    }

    const issue = issueByNumber.get(issueNumber);
    const merged = mergeExistingItem(existingByIssue, issueNumber, nextLocalId(existing.items));
    merged.title = content.title ?? issue?.title ?? merged.title ?? "";
    merged.repo = REPO;
    merged.source_note = typeof merged.source_note === "string" ? merged.source_note : "";
    if (typeof merged.raw_example !== "string") {
      delete merged.raw_example;
    }
    merged.github = {
      ...(merged.github && typeof merged.github === "object" ? merged.github : {}),
      issue_number: issueNumber,
      issue_url: content.url ?? issue?.url ?? "",
      project_number: PROJECT_NUMBER,
      project_url: PROJECT_URL,
      project_item_id: item.id ?? "",
    };
    merged.state = {
      ...(merged.state && typeof merged.state === "object" ? merged.state : {}),
      issue_state: issue?.state ?? "OPEN",
      project_status: item.status ?? "",
      workflow: item.workflow ?? "",
      priority: item.priority ?? "",
      size: item.size ?? "",
      branch: typeof merged.state?.branch === "string" ? merged.state.branch : "",
      pr_number: normalizeNumber(merged.state?.pr_number),
      pr_url: typeof merged.state?.pr_url === "string" ? merged.state.pr_url : "",
    };
    if (!Array.isArray(merged.notes)) {
      merged.notes = [];
    }
    items.push(merged);
  }

  items.sort((a, b) => normalizeNumber(a.github?.issue_number) - normalizeNumber(b.github?.issue_number));

  const usedIds = new Set();
  let counter = 1;
  for (const item of items) {
    if (typeof item.local_id !== "string" || usedIds.has(item.local_id)) {
      while (usedIds.has(`ocas-${String(counter).padStart(4, "0")}`)) {
        counter += 1;
      }
      item.local_id = `ocas-${String(counter).padStart(4, "0")}`;
      counter += 1;
    }
    usedIds.add(item.local_id);
  }

  const output = {
    version: 1,
    last_synced_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    items,
  };

  fs.mkdirSync(path.dirname(TRACKER_PATH), { recursive: true });
  fs.writeFileSync(TRACKER_PATH, YAML.stringify(output, { lineWidth: 0 }), "utf8");
  process.stdout.write(`Synced ${items.length} items to ${TRACKER_PATH}\n`);
}

main();
