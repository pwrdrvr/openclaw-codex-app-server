import type { ThreadSummary } from "./types.js";

function normalizeThreadText(value?: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return undefined;
  }
  const normalized = firstLine.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

export function getThreadDisplayTitle(
  thread: Pick<ThreadSummary, "threadId" | "title" | "summary">,
): string {
  return normalizeThreadText(thread.title) || normalizeThreadText(thread.summary) || thread.threadId;
}
