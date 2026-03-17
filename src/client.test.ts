import { describe, expect, it } from "vitest";
import { __testing } from "./client.js";

describe("buildTurnStartPayloads", () => {
  it("uses the canonical v2 turn/start payload for normal turns", () => {
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
    ]);
  });

  it("keeps collaboration payloads valid by including settings and preserving explicit null developer instructions", () => {
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
        threadId: "thread-123",
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
      },
    ]);
  });
});

describe("buildTurnSteerPayloads", () => {
  it("uses expectedTurnId plus text input for turn/steer", () => {
    expect(
      __testing.buildTurnSteerPayloads({
        threadId: "thread-123",
        turnId: "turn-456",
        text: "continue",
      }),
    ).toEqual([
      {
        threadId: "thread-123",
        expectedTurnId: "turn-456",
        input: [{ type: "text", text: "continue" }],
      },
    ]);
  });
});

describe("buildThreadResumePayloads", () => {
  it("uses the canonical camelCase resume payload", () => {
    expect(
      __testing.buildThreadResumePayloads({
        threadId: "thread-123",
        model: "gpt-5.4",
        cwd: "/tmp/workspace",
        serviceTier: "default",
      }),
    ).toEqual([
      {
        threadId: "thread-123",
        model: "gpt-5.4",
        cwd: "/tmp/workspace",
        serviceTier: "default",
      },
    ]);
  });
});

describe("extractStartupProbeInfo", () => {
  it("extracts server info from initialize responses without losing CLI probe details", () => {
    expect(
      __testing.extractStartupProbeInfo(
        {
          serverInfo: {
            name: "Codex App Server",
            version: "2026.3.15",
          },
        },
        {
          transport: "stdio",
          command: "codex",
          args: ["--foo"],
          resolvedCommandPath: "/opt/homebrew/bin/codex",
          cliVersion: "2026.3.15",
        },
      ),
    ).toEqual({
      transport: "stdio",
      command: "codex",
      args: ["--foo"],
      resolvedCommandPath: "/opt/homebrew/bin/codex",
      cliVersion: "2026.3.15",
      serverName: "Codex App Server",
      serverVersion: "2026.3.15",
    });
  });
});

describe("formatStdioProcessLog", () => {
  it("includes pid and command details for spawned processes", () => {
    expect(
      __testing.formatStdioProcessLog("spawned", {
        pid: 4321,
        command: "codex",
        args: ["app-server", "--stdio-json"],
      }),
    ).toBe(
      'codex app server process spawned pid=4321 command=codex args=["app-server","--stdio-json"]',
    );
  });

  it("includes exit status details for exited processes", () => {
    expect(
      __testing.formatStdioProcessLog("exited", {
        pid: 4321,
        code: 0,
        signal: null,
      }),
    ).toBe("codex app server process exited pid=4321 code=0 signal=<none>");
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

describe("extractFileEditSummariesFromNotification", () => {
  it("extracts relative paths and +/- stats from fileChange item notifications", () => {
    expect(
      __testing.extractFileEditSummariesFromNotification(
        {
          item: {
            type: "fileChange",
            id: "item-1",
            status: "inProgress",
            changes: [
              {
                path: "/repo/openclaw/src/a.ts",
                kind: "update",
                diff: "@@ -1 +1 @@\n-oldValue\n+newValue\n",
              },
              {
                path: "/repo/openclaw/README.md",
                kind: "add",
                diff: "line 1\nline 2\n",
              },
              {
                path: "/tmp/outside.txt",
                kind: "delete",
                diff: "gone\n",
              },
            ],
          },
        },
        "/repo/openclaw",
      ),
    ).toEqual([
      { path: "src/a.ts", verb: "Edited", added: 1, removed: 1 },
      { path: "README.md", verb: "Added", added: 2, removed: 0 },
      { path: "/tmp/outside.txt", verb: "Deleted", added: 0, removed: 1 },
    ]);
  });
});

describe("formatFileEditNotice", () => {
  it("matches the desktop-style single-file summary", () => {
    expect(
      __testing.formatFileEditNotice([
        { path: "AGENTS.md", verb: "Edited", added: 2, removed: 0 },
      ]),
    ).toBe("Edited `AGENTS.md` (+2 -0)");
  });

  it("renders a compact batch summary with per-file stats", () => {
    expect(
      __testing.formatFileEditNotice([
        { path: "src/a.ts", verb: "Edited", added: 1, removed: 1 },
        { path: "README.md", verb: "Added", added: 2, removed: 0 },
      ]),
    ).toBe(
      "Edited 2 files (+3 -1)\n- Added `README.md` (+2 -0)\n- Edited `src/a.ts` (+1 -1)",
    );
  });
});

describe("createFileEditNoticeBatcher", () => {
  it("merges repeated edits for the same file before flushing", async () => {
    const emitted: string[] = [];
    const batcher = __testing.createFileEditNoticeBatcher({
      onFlush: async (text: string) => {
        emitted.push(text);
      },
    });

    batcher.add([
      { path: "src/a.ts", verb: "Edited", added: 1, removed: 0 },
      { path: "README.md", verb: "Added", added: 2, removed: 0 },
    ]);
    batcher.add([{ path: "src/a.ts", verb: "Edited", added: 0, removed: 1 }]);

    expect(batcher.hasPending()).toBe(true);
    await batcher.flush();

    expect(emitted).toEqual([
      "Edited 2 files (+3 -1)\n- Added `README.md` (+2 -0)\n- Edited `src/a.ts` (+1 -1)",
    ]);
    expect(batcher.hasPending()).toBe(false);
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

describe("createPendingInputCoordinator", () => {
  it("surfaces only one pending approval at a time", async () => {
    const surfaced: Array<string | null> = [];
    const coordinator = __testing.createPendingInputCoordinator({
      inputTimeoutMs: 60_000,
      onPendingInput: async (state) => {
        surfaced.push(state?.requestId ?? null);
      },
    });

    const first = coordinator.enqueue({
      state: {
        requestId: "req-1",
        options: ["approve"],
        expiresAt: Date.now() + 60_000,
        method: "item/exec/requestApproval",
      },
      options: ["approve"],
      actions: [],
      methodLower: "item/exec/requestapproval",
    });
    const second = coordinator.enqueue({
      state: {
        requestId: "req-2",
        options: ["approve"],
        expiresAt: Date.now() + 60_000,
        method: "item/exec/requestApproval",
      },
      options: ["approve"],
      actions: [],
      methodLower: "item/exec/requestapproval",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(surfaced).toEqual(["req-1"]);
    expect(coordinator.current()?.state.requestId).toBe("req-1");

    await coordinator.settleCurrent({ index: 0, option: "approve" });
    await expect(first.response).resolves.toEqual({ index: 0, option: "approve" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(surfaced).toEqual(["req-1", null, "req-2"]);
    expect(coordinator.current()?.state.requestId).toBe("req-2");

    await coordinator.settleCurrent({ index: 0, option: "approve" });
    await expect(second.response).resolves.toEqual({ index: 0, option: "approve" });
  });
});
