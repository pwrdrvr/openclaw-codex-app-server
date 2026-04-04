import os from "node:os";
import path from "node:path";
import { formatCommandUsage } from "./help.js";
import type { ThreadSummary } from "./types.js";

export type ParsedThreadSelectionArgs = {
  includeAll: boolean;
  listProjects: boolean;
  startNew: boolean;
  syncTopic: boolean;
  page?: number;
  cwd?: string;
  requestedModel?: string;
  requestedFast?: boolean;
  requestedYolo?: boolean;
  error?: string;
  query: string;
};

export type ThreadSelectionResult =
  | { kind: "none" }
  | { kind: "unique"; thread: ThreadSummary }
  | { kind: "ambiguous"; threads: ThreadSummary[] };

function normalizeOptionDashes(text: string): string {
  return text
    .replace(/(^|\s)[\u2010-\u2015\u2212](?=\S)/g, "$1--")
    .replace(/[\u2010-\u2015\u2212]/g, "-");
}

function unwrapPairedDelimiters(value: string): string {
  let result = value.trim();
  const pairs: Array<[string, string]> = [
    ["<", ">"],
    ["＜", "＞"],
    ["《", "》"],
    ["`", "`"],
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [left, right] of pairs) {
      if (result.startsWith(left) && result.endsWith(right) && result.length > left.length + right.length) {
        result = result.slice(left.length, result.length - right.length).trim();
        changed = true;
      }
    }
  }
  return result;
}

function isLikelyThreadId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function normalizeThreadSelectionQuery(rawQuery: string): string {
  let query = unwrapPairedDelimiters(rawQuery);
  const labeledMatch = query.match(/^(?:thread\s*id|id)\s*[:：]\s*(.+)$/i);
  if (labeledMatch?.[1]) {
    const candidate = unwrapPairedDelimiters(labeledMatch[1]);
    if (isLikelyThreadId(candidate)) {
      return candidate;
    }
  }
  return query;
}

export function parseThreadSelectionArgs(args: string): ParsedThreadSelectionArgs {
  const tokens = normalizeOptionDashes(args)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  let includeAll = false;
  let listProjects = false;
  let startNew = false;
  let syncTopic = false;
  let page: number | undefined;
  let cwd: string | undefined;
  let requestedModel: string | undefined;
  let requestedFast: boolean | undefined;
  let requestedYolo: boolean | undefined;
  let error: string | undefined;
  const queryTokens: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--all" || token === "-a") {
      includeAll = true;
      continue;
    }
    if (token === "--projects" || token === "--project" || token === "-p") {
      listProjects = true;
      continue;
    }
    if (token === "--new") {
      startNew = true;
      continue;
    }
    if (token === "--sync") {
      syncTopic = true;
      continue;
    }
    if (token === "--page" || token.startsWith("--page=")) {
      const rawPageValue =
        token === "--page"
          ? tokens[index + 1]?.trim()
          : token.slice("--page=".length).trim();
      const parsedPage = Number(rawPageValue);
      if (!rawPageValue || !Number.isInteger(parsedPage) || parsedPage < 1) {
        error = "Usage: /cas_resume [--projects|-p] [--new [project]] [--all|-a] [--cwd <path>] [--page <number>=1+] [--sync] [--model <name>] [--fast|--no-fast] [--yolo|--no-yolo] [filter]";
        break;
      }
      page = parsedPage - 1;
      if (token === "--page") {
        index += 1;
      }
      continue;
    }
    if (token === "--fast") {
      requestedFast = true;
      continue;
    }
    if (token === "--no-fast") {
      requestedFast = false;
      continue;
    }
    if (token === "--yolo") {
      requestedYolo = true;
      continue;
    }
    if (token === "--no-yolo") {
      requestedYolo = false;
      continue;
    }
    if (token === "--model") {
      const next = tokens[index + 1]?.trim();
      if (next) {
        requestedModel = next;
        index += 1;
        continue;
      }
      error = formatCommandUsage("cas_resume");
      break;
    }
    if (token === "--cwd") {
      const next = tokens[index + 1]?.trim();
      if (next) {
        cwd = expandHomeDir(next);
        index += 1;
        continue;
      }
      error = formatCommandUsage("cas_resume");
      break;
    }
    queryTokens.push(token);
  }

  return {
    includeAll,
    listProjects,
    startNew,
    syncTopic,
    page,
    cwd,
    requestedModel,
    requestedFast,
    requestedYolo,
    error,
    query: normalizeThreadSelectionQuery(queryTokens.join(" ").trim()),
  };
}

export function expandHomeDir(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function selectThreadFromMatches(
  threads: ThreadSummary[],
  query: string,
): ThreadSelectionResult {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return { kind: "none" };
  }

  if (threads.length === 0) {
    return { kind: "none" };
  }

  const loweredQuery = trimmedQuery.toLowerCase();
  const exactMatch =
    threads.find((thread) => thread.threadId === trimmedQuery) ??
    threads.find((thread) => thread.title?.trim().toLowerCase() === loweredQuery);

  if (exactMatch) {
    return { kind: "unique", thread: exactMatch };
  }

  if (threads.length === 1) {
    return { kind: "unique", thread: threads[0] };
  }

  return { kind: "ambiguous", threads };
}
