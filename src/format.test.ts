import os from "node:os";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexPlanMarkdownPreview,
  formatAccountSummary,
  formatBoundThreadSummary,
  formatCodexPlanAttachmentFallback,
  formatCodexPlanAttachmentSummary,
  formatCodexPlanInlineText,
  formatCodexPlanSteps,
  formatCodexReviewFindingMessage,
  formatCodexStatusText,
  formatContextUsageAlert,
  getCodexStatusTimeZoneLabel,
  formatMcpServers,
  formatModels,
  formatSkills,
  formatThreadPickerIntro,
  formatThreadButtonLabel,
  parseCodexReviewOutput,
} from "./format.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
const TEST_PLUGIN_VERSION = packageJson.version ?? "unknown";
const TEST_WORKTREE_PATH = "/workspace/.codex/worktrees/41fb/openclaw";
const TEST_PROJECT_PATH = "/workspace/openclaw";
const TEST_EMAIL = "user@example.com";
const TEST_MASKED_EMAIL = "use...@...ple.com";

function shortenHomePathForTest(value: string): string {
  const home = os.homedir();
  if (value === home) {
    return "~";
  }
  if (value.startsWith(`${home}/`)) {
    return `~/${value.slice(home.length + 1)}`;
  }
  return value;
}

describe("formatThreadButtonLabel", () => {
  it("uses worktree and age badges while keeping the project suffix at the end", () => {
    expect(
      formatThreadButtonLabel({
        thread: {
          threadId: "019cdaf5-54be-7ba2-b610-dd71b0efb42b",
          title: "App Server Redux - Plugin Surface Build",
          projectKey: "/workspace/.codex/worktrees/cb00/openclaw",
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
          projectKey: "/workspace/.openclaw/workspace",
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
          workspaceDir: TEST_WORKTREE_PATH,
          threadTitle: "Fix Telegram approval flow",
          updatedAt: 1,
        },
        state: {
          threadId: "019cc00d-6cf4-7c11-afcd-2673db349a21",
          threadName: "Fix Telegram approval flow",
          cwd: TEST_WORKTREE_PATH,
        },
      }),
    ).toBe(
      [
        "Codex thread bound.",
        "Project: openclaw",
        "Thread Name: Fix Telegram approval flow",
        "Thread ID: 019cc00d-6cf4-7c11-afcd-2673db349a21",
        `Worktree Path: ${TEST_WORKTREE_PATH}`,
      ].join("\n"),
    );
  });
});

describe("formatCodexStatusText", () => {
  it("matches the old operational Codex status shape", () => {
    const text = formatCodexStatusText({
      pluginVersion: TEST_PLUGIN_VERSION,
      bindingActive: true,
      threadState: {
        threadId: "019cc00d-6cf4-7c11-afcd-2673db349a21",
        threadName: "Fix Telegram approval flow",
        model: "gpt-5.4",
        modelProvider: "openai",
        reasoningEffort: "high",
        serviceTier: "default",
        cwd: TEST_WORKTREE_PATH,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      },
      account: {
        type: "chatgpt",
        email: TEST_EMAIL,
        planType: "pro",
      },
      projectFolder: TEST_PROJECT_PATH,
      worktreeFolder: TEST_WORKTREE_PATH,
      planMode: false,
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

    expect(text).toContain("Binding: Fix Telegram approval flow (openclaw)");
    expect(text).toContain(`Plugin version: ${TEST_PLUGIN_VERSION}`);
    expect(text).toContain("Model: openai/gpt-5.4 · reasoning high");
    expect(text).toContain(`Project folder: ${shortenHomePathForTest(TEST_PROJECT_PATH)}`);
    expect(text).toContain(`Worktree folder: ${shortenHomePathForTest(TEST_WORKTREE_PATH)}`);
    expect(text).toContain("Fast mode: off");
    expect(text).toContain("Plan mode: off");
    expect(text).toContain("Context usage: unavailable until Codex emits a token-usage update");
    expect(text).toContain("Permissions: Default");
    expect(text).toContain(`Account: ${TEST_MASKED_EMAIL} (pro)`);
    expect(text).toContain("Thread: 019cc00d-6cf4-7c11-afcd-2673db349a21");
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

  it("shows plan mode on when the bound conversation has an active plan run", () => {
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
      planMode: true,
      rateLimits: [],
    });

    expect(text).toContain("Plan mode: on");
  });

  it("omits plan mode when the conversation is not bound", () => {
    const text = formatCodexStatusText({
      bindingActive: false,
      account: {
        type: "chatgpt",
        email: "user@example.com",
        planType: "pro",
      },
      projectFolder: "/repo/openclaw",
      worktreeFolder: "/repo/openclaw/workspace",
      rateLimits: [],
    });

    expect(text).not.toContain("Plan mode:");
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

    const expectedFiveHourReset = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date("2026-03-07T17:28:00Z"));

    expect(text).toContain(`Rate limits timezone: ${getCodexStatusTimeZoneLabel()}`);
    expect(text).toContain(`5h limit: 89% left (resets ${expectedFiveHourReset})`);
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
    expect(formatCodexPlanAttachmentSummary(plan)).toContain("Plan preview:");
    expect(formatCodexPlanAttachmentSummary(plan)).not.toContain(
      "The full plan is attached as Markdown.",
    );
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

  it("shows fallback message when workspace threads fell back to global", () => {
    const text = formatThreadPickerIntro({
      page: 0,
      totalPages: 1,
      totalItems: 5,
      includeAll: true,
      fallbackToGlobal: true,
    });

    expect(text).toContain("No threads in this workspace. Showing recent threads from all projects.");
  });

  it("does not show fallback message for normal global listing", () => {
    const text = formatThreadPickerIntro({
      page: 0,
      totalPages: 1,
      totalItems: 5,
      includeAll: true,
    });

    expect(text).not.toContain("No threads in this workspace");
    expect(text).toContain("Showing recent Codex threads across all projects.");
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

describe("formatAccountSummary", () => {
  it("masks account emails in the detailed account summary", () => {
    const text = formatAccountSummary(
      {
        type: "chatgpt",
        email: TEST_EMAIL,
        planType: "pro",
      },
      [],
    );

    expect(text).toContain(`Email: ${TEST_MASKED_EMAIL}`);
    expect(text).not.toContain(`Email: ${TEST_EMAIL}`);
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

describe("formatContextUsageAlert", () => {
  it("returns a warning message when level is warning", () => {
    const result = formatContextUsageAlert({
      level: "warning",
      usage: { totalTokens: 150_000, contextWindow: 200_000, remainingPercent: 25 },
    });
    expect(result).toContain("Context notice:");
    expect(result).toContain("Consider compacting");
    expect(result).toContain("150k / 200k tokens used");
  });

  it("returns a critical message when level is critical", () => {
    const result = formatContextUsageAlert({
      level: "critical",
      usage: { totalTokens: 186_000, contextWindow: 200_000, remainingPercent: 7 },
    });
    expect(result).toContain("Context alert:");
    expect(result).toContain("Compact soon");
    expect(result).toContain("186k / 200k tokens used");
  });

  it("falls back to unknown usage when snapshot is empty", () => {
    const result = formatContextUsageAlert({
      level: "warning",
      usage: {},
    });
    expect(result).toContain("unknown usage");
  });
});
