import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk";
import { CodexAppServerClient } from "./client.js";
import { COMMANDS } from "./commands.js";
import { CodexPluginController } from "./controller.js";
import { COMMAND_HELP, renderCommandHelpText } from "./help.js";

function createApiMock(): OpenClawPluginApi {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-help-test-"));
  return {
    id: "test-plugin",
    pluginConfig: {
      enabled: true,
      defaultWorkspaceDir: "/repo/openclaw",
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    runtime: {
      state: {
        resolveStateDir: () => stateDir,
      },
      channel: {
        text: {
          chunkText: (text: string) => [text],
          resolveTextChunkLimit: () => 2000,
        },
      },
    },
    registerService: vi.fn(),
    registerInteractiveHandler: vi.fn(),
    onConversationBindingResolved: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;
}

function buildDiscordCommandContext(
  overrides: Partial<PluginCommandContext> & Record<string, unknown> = {},
): PluginCommandContext {
  return {
    senderId: "user-1",
    channel: "discord",
    channelId: "discord",
    isAuthorizedSender: true,
    args: "",
    commandBody: "/cas_status",
    config: {},
    from: "discord:channel:chan-1",
    to: "slash:user-1",
    accountId: "default",
    requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
    detachConversationBinding: vi.fn(async () => ({ removed: true })),
    getCurrentConversationBinding: vi.fn(async () => null),
    ...overrides,
  } as unknown as PluginCommandContext;
}

describe("command help metadata", () => {
  beforeEach(() => {
    vi.spyOn(CodexAppServerClient.prototype, "logStartupProbe").mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has help metadata for every registered command", () => {
    for (const [commandName] of COMMANDS) {
      expect(COMMAND_HELP[commandName]).toBeDefined();
      expect(COMMAND_HELP[commandName].summary.trim().length).toBeGreaterThan(0);
      expect(COMMAND_HELP[commandName].usage.trim().length).toBeGreaterThan(0);
      expect(COMMAND_HELP[commandName].examples.length).toBeGreaterThan(0);
    }
  });

  it("renders structured sections in help text", () => {
    const text = renderCommandHelpText("cas_resume");
    expect(text).toContain("/cas_resume");
    expect(text).toContain("Usage:");
    expect(text).toContain("Examples:");
    expect(text).toContain("Flags/Args:");
    expect(text).toContain("--model <name>");
    expect(text).toContain("--fast, --no-fast");
    expect(text).toContain("--yolo, --no-yolo");
  });

  it("documents status overrides in command help", () => {
    const text = renderCommandHelpText("cas_status");
    expect(text).toContain("/cas_status");
    expect(text).toContain("--model <name>");
    expect(text).toContain("--fast, --no-fast");
    expect(text).toContain("--yolo, --no-yolo");
    expect(text).toContain("With no flags, this shows the current status card");
  });

  it("returns command help when args are help, --help, or em-dash help", async () => {
    const controller = new CodexPluginController(createApiMock());
    const helpReply = await controller.handleCommand("cas_plan", buildDiscordCommandContext({
      args: "help",
      commandBody: "/cas_plan help",
    }));
    const longHelpReply = await controller.handleCommand("cas_model", buildDiscordCommandContext({
      args: "--help",
      commandBody: "/cas_model --help",
    }));
    const emDashHelpReply = await controller.handleCommand("cas_resume", buildDiscordCommandContext({
      args: "—help",
      commandBody: "/cas_resume —help",
    }));

    expect(helpReply.text).toContain("/cas_plan");
    expect(helpReply.text).toContain("Usage:");
    expect(helpReply.text).toContain("Examples:");
    expect(longHelpReply.text).toContain("/cas_model");
    expect(longHelpReply.text).toContain("Usage:");
    expect(longHelpReply.text).toContain("Examples:");
    expect(emDashHelpReply.text).toContain("/cas_resume");
    expect(emDashHelpReply.text).toContain("Usage:");
    expect(emDashHelpReply.text).toContain("Examples:");
  });
});
