import { describe, expect, it } from "vitest";
import {
  parseThreadSelectionArgs,
  selectThreadFromMatches,
} from "./thread-selection.js";
import type { ThreadSummary } from "./types.js";

const THREADS: ThreadSummary[] = [
  {
    threadId: "thread-openclaw",
    title: "OpenClaw work",
    projectKey: "/workspace/openclaw",
  },
  {
    threadId: "thread-home",
    title: "Home dotfiles",
    projectKey: "/workspace/home",
  },
];

describe("thread selection args", () => {
  it("parses --all without inventing a query", () => {
    expect(parseThreadSelectionArgs("--all")).toEqual({
      includeAll: true,
      query: "",
    });
  });

  it("parses em dash all from Telegram-style input", () => {
    expect(parseThreadSelectionArgs("—all")).toEqual({
      includeAll: true,
      query: "",
    });
  });

  it("parses --all with a target query", () => {
    expect(parseThreadSelectionArgs("--all thread-home")).toEqual({
      includeAll: true,
      query: "thread-home",
    });
  });
});

describe("thread selection", () => {
  it("picks an exact thread id match", () => {
    expect(selectThreadFromMatches(THREADS, "thread-home")).toEqual({
      kind: "unique",
      thread: THREADS[1],
    });
  });

  it("does not auto-pick the first fuzzy match when multiple threads exist", () => {
    expect(selectThreadFromMatches(THREADS, "thread")).toEqual({
      kind: "ambiguous",
      threads: THREADS,
    });
  });
});
