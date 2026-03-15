import { describe, expect, it } from "vitest";
import { __testing } from "./client.js";

describe("buildTurnStartPayloads", () => {
  it("keeps legacy text and message input fallbacks for normal turns", () => {
    expect(
      __testing.buildTurnStartPayloads({
        threadId: "thread-123",
        prompt: "ship it",
        model: "gpt-5.4",
      }),
    ).toEqual([
      {
        threadId: "thread-123",
        input: [{ type: "text", text: "ship it" }],
        model: "gpt-5.4",
      },
      {
        thread_id: "thread-123",
        input: [{ type: "text", text: "ship it" }],
        model: "gpt-5.4",
      },
      {
        threadId: "thread-123",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "ship it" }],
          },
        ],
        model: "gpt-5.4",
      },
      {
        thread_id: "thread-123",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "ship it" }],
          },
        ],
        model: "gpt-5.4",
      },
    ]);
  });

  it("prefers text-only collaboration payloads and preserves explicit null developer instructions", () => {
    expect(
      __testing.buildTurnStartPayloads({
        threadId: "thread-123",
        prompt: "plan it",
        model: "gpt-5.4",
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5.4",
            developerInstructions: null,
          },
        },
      }),
    ).toEqual([
      {
        threadId: "thread-123",
        input: [{ type: "text", text: "plan it" }],
        model: "gpt-5.4",
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5.4",
            developerInstructions: null,
          },
        },
      },
      {
        thread_id: "thread-123",
        input: [{ type: "text", text: "plan it" }],
        model: "gpt-5.4",
        collaboration_mode: {
          mode: "plan",
          settings: {
            model: "gpt-5.4",
            developer_instructions: null,
          },
        },
      },
      {
        threadId: "thread-123",
        input: [{ type: "text", text: "plan it" }],
        model: "gpt-5.4",
        collaborationMode: {
          mode: "plan",
        },
      },
      {
        thread_id: "thread-123",
        input: [{ type: "text", text: "plan it" }],
        model: "gpt-5.4",
        collaboration_mode: {
          mode: "plan",
        },
      },
      {
        threadId: "thread-123",
        input: [{ type: "text", text: "plan it" }],
        model: "gpt-5.4",
      },
      {
        thread_id: "thread-123",
        input: [{ type: "text", text: "plan it" }],
        model: "gpt-5.4",
      },
    ]);
  });
});

describe("extractThreadTokenUsageSnapshot", () => {
  it("prefers current-context usage over cumulative totals when both are present", () => {
    expect(
      __testing.extractThreadTokenUsageSnapshot({
        threadId: "thread-123",
        tokenUsage: {
          last: {
            totalTokens: 139_000,
            inputTokens: 120_000,
            cachedInputTokens: 9_000,
            outputTokens: 10_000,
          },
          total: {
            totalTokens: 56_100_000,
            inputTokens: 55_000_000,
            cachedInputTokens: 300_000,
            outputTokens: 1_100_000,
          },
          modelContextWindow: 258_000,
        },
      }),
    ).toEqual({
      totalTokens: 139_000,
      inputTokens: 120_000,
      cachedInputTokens: 9_000,
      outputTokens: 10_000,
      reasoningOutputTokens: undefined,
      contextWindow: 258_000,
      remainingTokens: 119_000,
      remainingPercent: 46,
    });
  });

  it("normalizes thread/tokenUsage/updated notifications into a context snapshot", () => {
    expect(
      __testing.extractThreadTokenUsageSnapshot({
        threadId: "thread-123",
        turnId: "turn-123",
        tokenUsage: {
          total: {
            totalTokens: 54_000,
            inputTokens: 49_000,
            cachedInputTokens: 3_000,
            outputTokens: 5_000,
            reasoningOutputTokens: 1_000,
          },
          modelContextWindow: 272_000,
        },
      }),
    ).toEqual({
      totalTokens: 54_000,
      inputTokens: 49_000,
      cachedInputTokens: 3_000,
      outputTokens: 5_000,
      reasoningOutputTokens: 1_000,
      contextWindow: 272_000,
      remainingTokens: 218_000,
      remainingPercent: 80,
    });
  });
});

describe("extractFileChangePathsFromReadResult", () => {
  it("formats in-workspace files as relative paths and keeps outside files absolute", () => {
    expect(
      __testing.extractFileChangePathsFromReadResult(
        {
          thread: {
            turns: [
              {
                id: "turn-1",
                items: [
                  {
                    type: "fileChange",
                    id: "item-1",
                    changes: [
                      { path: "/repo/openclaw/src/a.ts", kind: "update" },
                      { path: "/repo/openclaw/docs/b.md", kind: "add" },
                      { path: "/tmp/outside.txt", kind: "delete" },
                    ],
                  },
                ],
              },
            ],
          },
        },
        "item-1",
        "/repo/openclaw",
      ),
    ).toEqual(["src/a.ts", "docs/b.md", "/tmp/outside.txt"]);
  });
});

describe("extractRateLimitSummaries", () => {
  it("extracts primary and secondary window snapshots from rateLimitsByLimitId", () => {
    expect(
      __testing.extractRateLimitSummaries({
        rateLimitsByLimitId: {
          codex: {
            limitName: "Codex",
            primary: {
              usedPercent: 15,
              windowDurationMins: 300,
              resetsAt: "2026-03-13T10:03:00-04:00",
            },
            secondary: {
              usedPercent: 9,
              windowDurationMins: 10_080,
              resetsAt: "2026-03-14T10:03:00-04:00",
            },
          },
        },
      }),
    ).toEqual([
      {
        name: "5h limit",
        limitId: "codex",
        usedPercent: 15,
        remaining: 85,
        resetAt: new Date("2026-03-13T10:03:00-04:00").getTime(),
        windowSeconds: 18_000,
        windowMinutes: 300,
      },
      {
        name: "Weekly limit",
        limitId: "codex",
        usedPercent: 9,
        remaining: 91,
        resetAt: new Date("2026-03-14T10:03:00-04:00").getTime(),
        windowSeconds: 604_800,
        windowMinutes: 10_080,
      },
    ]);
  });

  it("merges generic rows into existing named windows without losing used percentages", () => {
    expect(
      __testing.extractRateLimitSummaries({
        rateLimits: [
          {
            name: "5h limit",
            resetAt: "2026-03-13T10:03:00-04:00",
            windowSeconds: 18_000,
          },
        ],
        rateLimitsByLimitId: {
          codex: {
            primary: {
              usedPercent: 15,
              windowDurationMins: 300,
            },
          },
        },
      }),
    ).toEqual([
      {
        name: "5h limit",
        limitId: "codex",
        remaining: 85,
        usedPercent: 15,
        resetAt: new Date("2026-03-13T10:03:00-04:00").getTime(),
        windowSeconds: 18_000,
        windowMinutes: 300,
      },
    ]);
  });
});
