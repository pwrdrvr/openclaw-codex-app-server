import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCommandUsage } from "./help.js";
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
      listProjects: false,
      startNew: false,
      syncTopic: false,
      cwd: undefined,
      query: "",
    });
  });

  it("parses em dash all from Telegram-style input", () => {
    expect(parseThreadSelectionArgs("—all")).toEqual({
      includeAll: true,
      listProjects: false,
      startNew: false,
      syncTopic: false,
      cwd: undefined,
      query: "",
    });
  });

  it("parses --all with a target query", () => {
    expect(parseThreadSelectionArgs("--all thread-home")).toEqual({
      includeAll: true,
      listProjects: false,
      startNew: false,
      syncTopic: false,
      cwd: undefined,
      query: "thread-home",
    });
  });

  it("parses --projects and expands a home-relative cwd", () => {
    expect(parseThreadSelectionArgs("--projects --cwd ~/github/openclaw")).toEqual({
      includeAll: false,
      listProjects: true,
      startNew: false,
      syncTopic: false,
      cwd: path.join(os.homedir(), "github/openclaw"),
      query: "",
    });
  });

  it("parses --sync separately from the query text", () => {
    expect(parseThreadSelectionArgs("—all —sync approvals")).toEqual({
      includeAll: true,
      listProjects: false,
      startNew: false,
      syncTopic: true,
      cwd: undefined,
      query: "approvals",
    });
  });

  it("parses --new separately from the query text", () => {
    expect(parseThreadSelectionArgs("--new openclaw")).toEqual({
      includeAll: false,
      listProjects: false,
      startNew: true,
      syncTopic: false,
      cwd: undefined,
      query: "openclaw",
    });
  });

  it("returns the shared usage text when --cwd is missing its value", () => {
    expect(parseThreadSelectionArgs("--cwd")).toEqual({
      includeAll: false,
      listProjects: false,
      startNew: false,
      syncTopic: false,
      cwd: undefined,
      requestedModel: undefined,
      requestedFast: undefined,
      requestedYolo: undefined,
      error: formatCommandUsage("cas_resume"),
      query: "",
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

  it("picks an exact summary fallback match when the thread has no explicit title", () => {
    const threads: ThreadSummary[] = [
      {
        threadId: "019d2cbc-9fee-7862-8d02-683dfef71851",
        summary: "What is wrong with this layout?",
        projectKey: "/workspace/openclaw-app-server",
      },
      ...THREADS,
    ];

    expect(selectThreadFromMatches(threads, "What is wrong with this layout?")).toEqual({
      kind: "unique",
      thread: threads[0],
    });
  });

  it("does not auto-pick the first fuzzy match when multiple threads exist", () => {
    expect(selectThreadFromMatches(THREADS, "thread")).toEqual({
      kind: "ambiguous",
      threads: THREADS,
    });
  });
});
