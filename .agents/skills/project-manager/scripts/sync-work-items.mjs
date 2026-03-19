#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

const CONFIG_PATH = path.resolve(".agents/project-manager.config.json");
const DEFAULT_TRACKER_PATH = ".local/work-items.yaml";
const DEFAULT_LOCAL_ID_PREFIX = "item-";

function runGh(args) {
  return execFileSync("gh", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolveRepoFromGh() {
  const repo = JSON.parse(runGh(["repo", "view", "--json", "nameWithOwner"]));
  const nameWithOwner = repo?.nameWithOwner?.trim();
  if (!nameWithOwner) {
    throw new Error("Could not determine repo from gh repo view.");
  }
  return nameWithOwner;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing project manager config at ${CONFIG_PATH}`);
  }
  const raw = readJson(CONFIG_PATH);
  const repo =
    typeof raw.repo === "string" && raw.repo.trim() ? raw.repo.trim() : resolveRepoFromGh();
  const projectOwner =
    typeof raw.projectOwner === "string" && raw.projectOwner.trim()
      ? raw.projectOwner.trim()
      : repo.split("/")[0];
  const projectNumber =
    typeof raw.projectNumber === "number" && Number.isFinite(raw.projectNumber)
      ? raw.projectNumber
      : 0;
  if (projectNumber <= 0) {
    throw new Error(`Invalid projectNumber in ${CONFIG_PATH}`);
  }
  const trackerPath =
    typeof raw.trackerPath === "string" && raw.trackerPath.trim()
      ? path.resolve(raw.trackerPath.trim())
      : path.resolve(DEFAULT_TRACKER_PATH);
  const projectUrl =
    typeof raw.projectUrl === "string" && raw.projectUrl.trim()
      ? raw.projectUrl.trim()
      : `https://github.com/orgs/${projectOwner}/projects/${projectNumber}`;
  const localIdPrefix =
    typeof raw.localIdPrefix === "string" && raw.localIdPrefix.trim()
      ? raw.localIdPrefix.trim()
      : DEFAULT_LOCAL_ID_PREFIX;
  return {
    repo,
    projectOwner,
    projectNumber,
    projectUrl,
    trackerPath,
    localIdPrefix,
  };
}

function loadExistingTracker(trackerPath) {
  if (!fs.existsSync(trackerPath)) {
    return { version: 1, last_synced_at: null, items: [] };
  }

  const raw = fs.readFileSync(trackerPath, "utf8");
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

function nextLocalId(existingItems, localIdPrefix) {
  let max = 0;
  for (const item of existingItems) {
    const match =
      typeof item?.local_id === "string"
        ? item.local_id.match(new RegExp(`^${localIdPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d{4,})$`))
        : null;
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return `${localIdPrefix}${String(max + 1).padStart(4, "0")}`;
}

function mergeExistingItem(existingByIssue, issueNumber, fallbackLocalId, repo) {
  const current = existingByIssue.get(issueNumber);
  if (current && typeof current === "object" && current !== null) {
    return structuredClone(current);
  }
  return {
    local_id: fallbackLocalId,
    title: "",
    repo,
    source_note: "",
    github: {},
    state: {},
    notes: [],
  };
}

function main() {
  const config = loadConfig();
  const existing = loadExistingTracker(config.trackerPath);
  const existingByIssue = new Map();
  for (const item of existing.items) {
    const issueNumber = normalizeNumber(item?.github?.issue_number);
    if (issueNumber > 0) {
      existingByIssue.set(issueNumber, item);
    }
  }

  const issueList = JSON.parse(
    runGh([
      "issue",
      "list",
      "--repo",
      config.repo,
      "--state",
      "all",
      "--limit",
      "500",
      "--json",
      "number,state,title,url",
    ]),
  );
  const issueByNumber = new Map(issueList.map((issue) => [issue.number, issue]));

  const projectData = JSON.parse(
    runGh([
      "project",
      "item-list",
      String(config.projectNumber),
      "--owner",
      config.projectOwner,
      "--format",
      "json",
    ]),
  );

  const items = [];
  for (const item of projectData.items ?? []) {
    const content = item?.content ?? {};
    if (content.type !== "Issue") {
      continue;
    }
    if (content.repository !== config.repo) {
      continue;
    }
    const issueNumber = normalizeNumber(content.number);
    if (issueNumber <= 0) {
      continue;
    }

    const issue = issueByNumber.get(issueNumber);
    const merged = mergeExistingItem(
      existingByIssue,
      issueNumber,
      nextLocalId(existing.items, config.localIdPrefix),
      config.repo,
    );
    merged.title = content.title ?? issue?.title ?? merged.title ?? "";
    merged.repo = config.repo;
    merged.source_note = typeof merged.source_note === "string" ? merged.source_note : "";
    if (typeof merged.raw_example !== "string") {
      delete merged.raw_example;
    }
    merged.github = {
      ...(merged.github && typeof merged.github === "object" ? merged.github : {}),
      issue_number: issueNumber,
      issue_url: content.url ?? issue?.url ?? "",
      project_number: config.projectNumber,
      project_url: config.projectUrl,
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
      while (usedIds.has(`${config.localIdPrefix}${String(counter).padStart(4, "0")}`)) {
        counter += 1;
      }
      item.local_id = `${config.localIdPrefix}${String(counter).padStart(4, "0")}`;
      counter += 1;
    }
    usedIds.add(item.local_id);
  }

  const output = {
    version: 1,
    last_synced_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    items,
  };

  fs.mkdirSync(path.dirname(config.trackerPath), { recursive: true });
  fs.writeFileSync(config.trackerPath, YAML.stringify(output, { lineWidth: 0 }), "utf8");
  process.stdout.write(`Synced ${items.length} items to ${config.trackerPath}\n`);
}

main();
