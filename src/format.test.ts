import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexPlanMarkdownPreview,
  formatBoundThreadSummary,
  formatCodexPlanAttachmentFallback,
  formatCodexPlanAttachmentSummary,
  formatCodexPlanInlineText,
  formatCodexPlanSteps,
  formatCodexReviewFindingMessage,
  formatCodexStatusText,
  formatMcpServers,
  formatModels,
  formatSkills,
  formatThreadPickerIntro,
  formatThreadButtonLabel,
  parseCodexReviewOutput,
} from "./format.js";

describe("formatThreadButtonLabel", () => {
  it("uses worktree and age badges while keeping the project suffix at the end", () => {
    expect(
      formatThreadButtonLabel({
        thread: {
          threadId: "019cdaf5-54be-7ba2-b610-dd71b0efb42b",
          title: "App Server Redux - Plugin Surface Build",
          projectKey: "/Users/huntharo/.codex/worktrees/cb00/openclaw",
          updatedAt: Date.now() - 4 * 60_000,
          createdAt: Date.now() - 10 * 60 * 60_000,
        },
        includeProjectSuffix: true,
        isWorktree: true,
        hasChanges: true,
      }),
    ).toContain("🌿 ✏️ App Server Redux - Plugin Surface Build (openclaw) U:4m C:10h");
  });

  it("falls back to the final workspace segment for non-worktree paths", () => {
    expect(
      formatThreadButtonLabel({
        thread: {
          threadId: "019cbef1-376b-7312-98aa-24488c7499d4",
          projectKey: "/Users/huntharo/.openclaw/workspace",
        },
        includeProjectSuffix: true,
      }),
    ).toBe("019cbef1-376b-7312-98aa-24488c7499d4 (workspace)");
  });
});

describe("formatBoundThreadSummary", () => {
  it("includes project, thread metadata, and replay context", () => {
    expect(
      formatBoundThreadSummary({
        binding: {
          conversation: {
            channel: "telegram",
            accountId: "default",
            conversationId: "chat-1",
          },
          sessionKey: "openclaw-codex-app-server:thread:abc",
          threadId: "019cc00d-6cf4-7c11-afcd-2673db349a21",
          workspaceDir: "/Users/huntharo/.codex/worktrees/41fb/openclaw",
          threadTitle: "Fix Telegram approval flow",
          updatedAt: 1,
        },
        state: {
          threadId: "019cc00d-6cf4-7c11-afcd-2673db349a21",
          threadName: "Fix Telegram approval flow",
          cwd: "/Users/huntharo/.codex/worktrees/41fb/openclaw",
        },
      }),
    ).toBe(
      [
        "Codex thread bound.",
        "Project: openclaw",
        "Thread Name: Fix Telegram approval flow",
        "Thread ID: 019cc00d-6cf4-7c11-afcd-2673db349a21",
        "Worktree Path: /Users/huntharo/.codex/worktrees/41fb/openclaw",
      ].join("\n"),
    );
  });
});

describe("formatCodexStatusText", () => {
  it("matches the old operational Codex status shape", () => {
    const text = formatCodexStatusText({
      bindingActive: true,
      threadState: {
        threadId: "019cc00d-6cf4-7c11-afcd-2673db349a21",
        threadName: "Fix Telegram approval flow",
        model: "gpt-5.4",
        modelProvider: "openai",
        reasoningEffort: "high",
        serviceTier: "default",
        cwd: "/Users/huntharo/.codex/worktrees/41fb/openclaw",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      account: {
        type: "chatgpt",
        email: "huntharo@gmail.com",
        planType: "pro",
      },
      projectFolder: "/Users/huntharo/github/openclaw",
      worktreeFolder: "/Users/huntharo/.codex/worktrees/41fb/openclaw",
      rateLimits: [
        {
          name: "5h limit",
          usedPercent: 15,
          resetAt: new Date("2026-03-13T10:03:00-04:00").getTime(),
          windowSeconds: 18_000,
        },
        {
          name: "Weekly limit",
          usedPercent: 15,
          resetAt: new Date("2026-03-14T10:03:00-04:00").getTime(),
          windowSeconds: 604_800,
        },
      ],
    });

    expect(text).toContain("OpenAI Codex");
    expect(text).toContain("Binding: active");
    expect(text).toContain("Thread: Fix Telegram approval flow");
    expect(text).toContain("Model: openai/gpt-5.4 · reasoning high");
    expect(text).toContain("Project folder: ~/github/openclaw");
    expect(text).toContain("Worktree folder: ~/.codex/worktrees/41fb/openclaw");
    expect(text).toContain("Fast mode: off");
    expect(text).toContain("Context usage: unavailable until Codex emits a token-usage update");
    expect(text).toContain("Permissions: Default");
    expect(text).toContain("Account: huntharo@gmail.com (pro)");
    expect(text).toContain("Session: 019cc00d-6cf4-7c11-afcd-2673db349a21");
    expect(text).toContain("Rate limits timezone:");
    expect(text).toContain("5h limit: 85% left");
    expect(text).toContain("Weekly limit: 85% left");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats context usage once a fresh token snapshot exists", () => {
    const text = formatCodexStatusText({
      bindingActive: true,
      threadState: {
        threadId: "thread-123",
        threadName: "Plan TASKS doc refresh",
        model: "gpt-5.4",
        modelProvider: "openai",
        reasoningEffort: "high",
        cwd: "/repo/openclaw",
      },
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "pro",
      },
      projectFolder: "/repo/openclaw",
      worktreeFolder: "/repo/openclaw",
      contextUsage: {
        totalTokens: 139_000,
        contextWindow: 258_000,
      },
      rateLimits: [
        {
          name: "5h limit",
          usedPercent: 4,
        },
      ],
    });

    expect(text).toContain("Context usage: 139k / 258k tokens used (54% full)");
  });

  it("does not render a partial context usage line when only the window size is known", () => {
    const text = formatCodexStatusText({
      bindingActive: true,
      threadState: {
        threadId: "thread-123",
        threadName: "Plan TASKS doc refresh",
        model: "gpt-5.4",
        modelProvider: "openai",
        cwd: "/repo/openclaw",
      },
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "pro",
      },
      projectFolder: "/repo/openclaw",
      worktreeFolder: "/repo/openclaw",
      contextUsage: {
        contextWindow: 272_000,
      },
      rateLimits: [],
    });

    expect(text).not.toContain("Context usage: ? / 272k");
    expect(text).toContain("Context usage: unavailable until Codex emits a token-usage update");
  });

  it("hides non-matching model-specific rate-limit rows", () => {
    const text = formatCodexStatusText({
      bindingActive: true,
      threadState: {
        threadId: "thread-123",
        threadName: "Plan TASKS doc refresh",
        model: "gpt-5.4",
        modelProvider: "openai",
        cwd: "/repo/openclaw",
      },
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "pro",
      },
      projectFolder: "/repo/openclaw",
      worktreeFolder: "/repo/openclaw",
      rateLimits: [
        { name: "5h limit", usedPercent: 4 },
        { name: "Weekly limit", usedPercent: 17 },
        { name: "GPT-5.3-Codex-Spark 5h limit", usedPercent: 0 },
        { name: "GPT-5.3-Codex-Spark Weekly limit", usedPercent: 0 },
      ],
    });

    expect(text).toContain("5h limit: 96% left");
    expect(text).toContain("Weekly limit: 83% left");
    expect(text).not.toContain("GPT-5.3-Codex-Spark 5h limit");
    expect(text).not.toContain("GPT-5.3-Codex-Spark Weekly limit");
  });

  it("groups model-specific rate-limit rows after generic rows", () => {
    const text = formatCodexStatusText({
      bindingActive: true,
      threadState: {
        threadId: "thread-123",
        threadName: "Plan TASKS doc refresh",
        model: "gpt-5.3-codex-spark",
        modelProvider: "openai",
        cwd: "/repo/openclaw",
      },
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "pro",
      },
      projectFolder: "/repo/openclaw",
      worktreeFolder: "/repo/openclaw",
      rateLimits: [
        { name: "GPT-5.3-Codex-Spark Weekly limit", usedPercent: 0 },
        { name: "Weekly limit", usedPercent: 17 },
        { name: "GPT-5.3-Codex-Spark 5h limit", usedPercent: 0 },
        { name: "5h limit", usedPercent: 4 },
      ],
    });

    const genericFiveHourIndex = text.indexOf("5h limit: 96% left");
    const genericWeeklyIndex = text.indexOf("Weekly limit: 83% left");
    const sparkFiveHourIndex = text.indexOf("GPT-5.3-Codex-Spark 5h limit: 100% left");
    const sparkWeeklyIndex = text.indexOf("GPT-5.3-Codex-Spark Weekly limit: 100% left");

    expect(genericFiveHourIndex).toBeGreaterThan(-1);
    expect(genericWeeklyIndex).toBeGreaterThan(genericFiveHourIndex);
    expect(sparkFiveHourIndex).toBeGreaterThan(genericWeeklyIndex);
    expect(sparkWeeklyIndex).toBeGreaterThan(sparkFiveHourIndex);
  });

  it("formats reset windows in local time and rolls stale anchors forward", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:00:00-05:00"));

    const text = formatCodexStatusText({
      bindingActive: true,
      threadState: {
        threadId: "thread-123",
        threadName: "Plan TASKS doc refresh",
        model: "gpt-5.4",
        modelProvider: "openai",
        cwd: "/repo/openclaw",
      },
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "pro",
      },
      projectFolder: "/repo/openclaw",
      worktreeFolder: "/repo/openclaw",
      rateLimits: [
        {
          name: "5h limit",
          usedPercent: 11,
          resetAt: new Date("2026-01-21T07:28:00-05:00").getTime(),
          windowSeconds: 18_000,
        },
        {
          name: "Weekly limit",
          usedPercent: 20,
          resetAt: new Date("2026-01-21T07:34:00-05:00").getTime(),
          windowSeconds: 604_800,
        },
      ],
    });

    expect(text).toContain(
      `Rate limits timezone: ${new Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    );
    expect(text).toContain("5h limit: 89% left (resets 12:28 PM)");
    expect(text).toContain("Weekly limit: 80% left (resets Mar 11)");
    expect(text).not.toContain("Jan 21");
  });
});

describe("Codex plan delivery formatting", () => {
  it("builds a truncated markdown preview for large plans", () => {
    const preview = buildCodexPlanMarkdownPreview(`# Plan\n\n${"Long section.\n".repeat(300)}`, 120);
    expect(preview).toContain("[Preview truncated. Open the attachment for the full plan.]");
    expect(preview?.length).toBeGreaterThan(120);
  });

  it("formats the attachment summary and fallback texts", () => {
    const plan = {
      explanation: "This needs the full rollout guide attached.",
      steps: [{ step: "Write the rollout", status: "inProgress" as const }],
      markdown: `# Plan\n\n${"Long section.\n".repeat(10)}`,
    };
    expect(formatCodexPlanAttachmentSummary(plan)).toContain("The full plan is attached as Markdown.");
    expect(formatCodexPlanAttachmentSummary(plan)).toContain("Plan preview:");
    expect(formatCodexPlanAttachmentFallback(plan)).toContain(
      "I couldn't attach the full Markdown plan here, so here's a condensed inline summary instead.",
    );
    expect(formatCodexPlanAttachmentFallback(plan)).toContain("# Plan");
  });
});

describe("formatThreadPickerIntro", () => {
  it("includes a legend for resume badges", () => {
    const text = formatThreadPickerIntro({
      page: 0,
      totalPages: 7,
      totalItems: 56,
      includeAll: true,
    });

    expect(text).toContain("Legend: 🌿 worktree, ✏️ uncommitted changes, U updated, C created.");
  });

  it("mentions topic sync when the resume picker is in sync mode", () => {
    const text = formatThreadPickerIntro({
      page: 0,
      totalPages: 1,
      totalItems: 3,
      includeAll: true,
      syncTopic: true,
    });

    expect(text).toContain("sync the current channel/topic name");
  });
});

describe("formatSkills", () => {
  it("matches the old skill summary shape and filtering", () => {
    expect(
      formatSkills({
        workspaceDir: "/repo/openclaw",
        filter: "creator",
        skills: [
          {
            cwd: "/repo/openclaw",
            name: "skill-creator",
            description: "Create or update a Codex skill",
            enabled: true,
          },
          {
            cwd: "/repo/openclaw",
            name: "legacy-helper",
            description: "Old helper",
            enabled: false,
          },
        ],
      }),
    ).toContain("skill-creator - Create or update a Codex skill");
  });
});

describe("formatMcpServers", () => {
  it("matches the old MCP summary shape", () => {
    expect(
      formatMcpServers({
        servers: [
          {
            name: "github",
            authStatus: "authenticated",
            toolCount: 12,
            resourceCount: 3,
            resourceTemplateCount: 1,
          },
        ],
      }),
    ).toContain("github · auth=authenticated · tools=12 · resources=3 · templates=1");
  });
});

describe("formatModels", () => {
  it("shows the current model followed by the available list", () => {
    const text = formatModels(
      [
        { id: "gpt-5.3-codex", current: true },
        { id: "gpt-5.2-codex" },
      ],
      {
        threadId: "thread-1",
        model: "gpt-5.3-codex",
      },
    );

    expect(text).toContain("Current model: gpt-5.3-codex");
    expect(text).toContain("Available models:");
    expect(text).toContain("- gpt-5.2-codex");
  });
});

describe("parseCodexReviewOutput", () => {
  it("parses summary text and structured findings from the old review format", () => {
    const parsed = parseCodexReviewOutput([
      "Looks solid overall.",
      "",
      "[P1] Prefer Stylize helpers Location: /tmp/file.rs:10-20",
      "Use .dim()/.bold() chaining instead of manual Style.",
      "",
      "[P2] Keep helper names consistent Location: /tmp/file.rs:30-35",
      "Rename the helper to match the surrounding naming pattern.",
    ].join("\n"));

    expect(parsed.summary).toBe("Looks solid overall.");
    expect(parsed.findings).toHaveLength(2);
    expect(formatCodexReviewFindingMessage({ finding: parsed.findings[0]!, index: 0 })).toContain(
      "P1\nPrefer Stylize helpers\nLocation: /tmp/file.rs:10-20",
    );
  });
});

describe("formatCodexPlanInlineText", () => {
  it("renders explanation, steps, and markdown for plan output", () => {
    const plan = {
      explanation: "Break the work into safe increments.",
      steps: [
        { step: "Capture the current behavior", status: "completed" as const },
        { step: "Patch Telegram delivery", status: "inProgress" as const },
      ],
      markdown: "# Plan\n\n- Patch the command",
    };

    expect(formatCodexPlanSteps(plan.steps)).toContain("- [x] Capture the current behavior");
    expect(formatCodexPlanInlineText(plan)).toContain("Break the work into safe increments.");
    expect(formatCodexPlanInlineText(plan)).toContain("# Plan");
  });
});
