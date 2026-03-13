import type { ThreadSummary } from "./types.js";

export type ParsedThreadSelectionArgs = {
  includeAll: boolean;
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

export function parseThreadSelectionArgs(args: string): ParsedThreadSelectionArgs {
  const tokens = normalizeOptionDashes(args)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  let includeAll = false;
  const queryTokens: string[] = [];

  for (const token of tokens) {
    if (token === "--all" || token === "-a") {
      includeAll = true;
      continue;
    }
    queryTokens.push(token);
  }

  return {
    includeAll,
    query: queryTokens.join(" ").trim(),
  };
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
