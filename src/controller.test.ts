import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, PluginCommandContext } from "openclaw/plugin-sdk";
import { CodexAppServerClient } from "./client.js";
import { CodexPluginController } from "./controller.js";

const discordSdkState = vi.hoisted(() => ({
  buildDiscordComponentMessage: vi.fn((params: { spec: { text?: string; blocks?: unknown[] } }) => ({
    components: [params.spec.text ?? "", ...(params.spec.blocks ?? [])],
    entries: [{ id: "entry-1", kind: "button", label: "Tap" }],
    modals: [],
  })),
  editDiscordComponentMessage: vi.fn(async () => ({
    messageId: "message-1",
    channelId: "channel:chan-1",
  })),
  registerBuiltDiscordComponentMessage: vi.fn(),
  resolveDiscordAccount: vi.fn(() => ({ accountId: "default" })),
}));

vi.mock("openclaw/plugin-sdk/discord", () => ({
  buildDiscordComponentMessage: discordSdkState.buildDiscordComponentMessage,
  editDiscordComponentMessage: discordSdkState.editDiscordComponentMessage,
  registerBuiltDiscordComponentMessage: discordSdkState.registerBuiltDiscordComponentMessage,
  resolveDiscordAccount: discordSdkState.resolveDiscordAccount,
}));

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-app-server-test-"));
}

function createApiMock() {
  const stateDir = makeStateDir();
  const sendComponentMessage = vi.fn(async () => ({}));
  const sendMessageDiscord = vi.fn(async () => ({ messageId: "discord-msg-1", channelId: "channel:chan-1" }));
  const sendMessageTelegram = vi.fn(async () => ({ messageId: "1", chatId: "123" }));
  const discordTypingStart = vi.fn(async () => ({ refresh: vi.fn(async () => {}), stop: vi.fn() }));
  const renameTopic = vi.fn(async () => ({}));
  const resolveTelegramToken = vi.fn(() => ({ token: "telegram-token", source: "config" }));
  const editChannel = vi.fn(async () => ({}));
  const api = {
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
        bindings: {
          bind: vi.fn(async () => ({})),
          unbind: vi.fn(async () => []),
          resolveByConversation: vi.fn(() => null),
        },
        text: {
          chunkText: (text: string) => [text],
          resolveTextChunkLimit: (_cfg: unknown, _provider?: string, _accountId?: string | null, opts?: { fallbackLimit?: number }) =>
            opts?.fallbackLimit ?? 2000,
        },
        telegram: {
          sendMessageTelegram,
          resolveTelegramToken,
          typing: {
            start: vi.fn(async () => ({ refresh: vi.fn(async () => {}), stop: vi.fn() })),
          },
          conversationActions: {
            renameTopic,
          },
        },
        discord: {
          sendMessageDiscord,
          sendComponentMessage,
          typing: {
            start: discordTypingStart,
          },
          conversationActions: {
            editChannel,
          },
        },
      },
    },
    registerService: vi.fn(),
    registerInteractiveHandler: vi.fn(),
    onConversationBindingResolved: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;
  return {
    api,
    sendComponentMessage,
    sendMessageDiscord,
    sendMessageTelegram,
    discordTypingStart,
    renameTopic,
    resolveTelegramToken,
    editChannel,
    stateDir,
  };
}

async function createControllerHarness() {
  const {
    api,
    sendComponentMessage,
    sendMessageDiscord,
    sendMessageTelegram,
    discordTypingStart,
    renameTopic,
    resolveTelegramToken,
    editChannel,
    stateDir,
  } = createApiMock();
  const controller = new CodexPluginController(api);
  await controller.start();
  const clientMock = {
    listThreads: vi.fn(async () => [
      {
        threadId: "thread-1",
        title: "Discord Thread",
        projectKey: "/repo/openclaw",
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      },
    ]),
    listModels: vi.fn(async () => [
      { id: "openai/gpt-5.4", current: true },
      { id: "openai/gpt-5.3" },
    ]),
    listSkills: vi.fn(async () => [
      { name: "skill-a", description: "Skill A", cwd: "/repo/openclaw" },
      { name: "skill-b", description: "Skill B", cwd: "/repo/openclaw" },
    ]),
    readThreadState: vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
      model: "openai/gpt-5.4",
      cwd: "/repo/openclaw",
      serviceTier: "default",
    })),
    readThreadContext: vi.fn(async () => ({
      lastUserMessage: undefined,
      lastAssistantMessage: undefined,
    })),
    setThreadName: vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "Discord Thread",
    })),
    readAccount: vi.fn(async () => ({
      email: "test@example.com",
      planType: "pro",
      type: "chatgpt",
    })),
    readRateLimits: vi.fn(async () => []),
  };
  (controller as any).client = clientMock;
  (controller as any).readThreadHasChanges = vi.fn(async () => false);
  return {
    controller,
    api,
    clientMock,
    sendComponentMessage,
    sendMessageDiscord,
    sendMessageTelegram,
    discordTypingStart,
    renameTopic,
    resolveTelegramToken,
    editChannel,
    stateDir,
  };
}

async function createControllerHarnessWithoutLegacyBindings() {
  const harness = createApiMock();
  delete (harness.api as any).runtime.channel.bindings;
  const controller = new CodexPluginController(harness.api);
  await controller.start();
  return {
    controller,
    api: harness.api,
  };
}

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
const TEST_PLUGIN_VERSION = packageJson.version ?? "unknown";

function buildDiscordCommandContext(
  overrides: Partial<PluginCommandContext> & Record<string, unknown> = {},
): PluginCommandContext {
  return {
    senderId: "user-1",
    channel: "discord",
    channelId: "discord",
    isAuthorizedSender: true,
    args: "",
    commandBody: "/cas_resume",
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

function buildTelegramCommandContext(
  overrides: Partial<PluginCommandContext> & Record<string, unknown> = {},
): PluginCommandContext {
  return {
    senderId: "user-1",
    channel: "telegram",
    channelId: "telegram",
    isAuthorizedSender: true,
    args: "",
    commandBody: "/cas_status",
    config: {},
    from: "telegram:123",
    to: "telegram:123",
    accountId: "default",
    requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
    detachConversationBinding: vi.fn(async () => ({ removed: true })),
    getCurrentConversationBinding: vi.fn(async () => null),
    ...overrides,
  } as unknown as PluginCommandContext;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  discordSdkState.buildDiscordComponentMessage.mockClear();
  discordSdkState.editDiscordComponentMessage.mockClear();
  discordSdkState.registerBuiltDiscordComponentMessage.mockClear();
  discordSdkState.resolveDiscordAccount.mockClear();
  vi.spyOn(CodexAppServerClient.prototype, "logStartupProbe").mockResolvedValue();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
    })),
  );
});

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Discord controller flows", () => {
  it("starts cleanly without the legacy runtime.channel.bindings surface", async () => {
    const { controller } = await createControllerHarnessWithoutLegacyBindings();

    expect(controller).toBeInstanceOf(CodexPluginController);
  });

  it("stops the shared app-server client and interrupts active runs on service stop", async () => {
    const { controller } = await createControllerHarness();
    const interrupt = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    (controller as any).client.close = close;
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", aborted: true }),
        queueMessage: vi.fn(async () => false),
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
        interrupt,
        isAwaitingInput: vi.fn(() => false),
        getThreadId: vi.fn(() => "thread-1"),
      },
    });

    await controller.stop();

    expect(interrupt).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect((controller as any).activeRuns.size).toBe(0);
  });

  it("uses the real Discord conversation target for slash-command resume pickers", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();

    const reply = await controller.handleCommand("cas_resume", buildDiscordCommandContext());

    expect(reply).toEqual({
      text: "Sent a Codex thread picker to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Showing recent Codex sessions"),
      }),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("rejects resume when the thread worktree path no longer exists on disk", async () => {
    const { controller, clientMock } = await createControllerHarness();
    const missingWorktreePath = "/tmp/worktrees/bold-bartik/repo-name";
    clientMock.listThreads.mockResolvedValue([
      {
        threadId: "thread-stale",
        title: "Stale Worktree Thread",
        projectKey: missingWorktreePath,
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      },
    ]);
    clientMock.readThreadState.mockResolvedValue({
      threadId: "thread-stale",
      threadName: "Stale Worktree Thread",
      model: "openai/gpt-5.4",
      cwd: missingWorktreePath,
      serviceTier: "default",
    });

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "thread-stale",
        commandBody: "/cas_resume thread-stale",
      }),
    );

    expect(reply.text).toContain("Cannot resume");
    expect(reply.text).toContain(missingWorktreePath);
    expect(reply.text).toContain("no longer exists on disk");
  });

  it("resolves channel identity from ctx.to when ctx.from is a slash identity in a new Discord thread", async () => {
    // Regression test for brand-new Discord threads where the slash interaction
    // places the slash user identity in ctx.from and the channel target in ctx.to.
    const { controller, sendComponentMessage } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildDiscordCommandContext({
        from: "slash:user-1",
        to: "discord:channel:chan-1",
      }),
    );

    expect(reply).toEqual({
      text: "Sent a Codex thread picker to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Showing recent Codex sessions"),
      }),
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });

  it("sends Discord model pickers directly instead of returning Telegram buttons", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand("cas_model", buildDiscordCommandContext({
      commandBody: "/cas_model",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));

    expect(reply).toEqual({
      text: "Sent Codex model choices to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Current model"),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("sends Discord skills directly instead of returning Telegram buttons", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();

    const reply = await controller.handleCommand("cas_skills", buildDiscordCommandContext({
      commandBody: "/cas_skills",
    }));

    expect(reply).toEqual({
      text: "Sent Codex skills to this Discord conversation.",
    });
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: expect.stringContaining("Codex skills"),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("refreshes Discord pickers by editing the original interaction message", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "picker-view",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      view: {
        mode: "threads",
        includeAll: true,
        page: 0,
      },
    });
    const editMessage = vi.fn(async () => {});

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage,
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        components: expect.any(Array),
      }),
    );
    expect(discordSdkState.registerBuiltDiscordComponentMessage).toHaveBeenCalledWith({
      buildResult: expect.objectContaining({
        components: expect.any(Array),
        entries: expect.any(Array),
      }),
      messageId: "message-1",
    });
    expect(discordSdkState.editDiscordComponentMessage).not.toHaveBeenCalled();
    expect(sendComponentMessage).not.toHaveBeenCalled();
  });

  it("refreshes the Discord project picker by editing the interaction message", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "picker-view",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      view: {
        mode: "projects",
        includeAll: true,
        page: 0,
      },
    });
    const editMessage = vi.fn(async () => {});

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage,
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    expect(editMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        components: expect.any(Array),
      }),
    );
    expect(discordSdkState.registerBuiltDiscordComponentMessage).toHaveBeenCalledWith({
      buildResult: expect.objectContaining({
        components: expect.any(Array),
        entries: expect.any(Array),
      }),
      messageId: "message-1",
    });
    expect(discordSdkState.editDiscordComponentMessage).not.toHaveBeenCalled();
    expect(sendComponentMessage).not.toHaveBeenCalled();
  });

  it("falls back to direct Discord message edit when the interaction was already acknowledged", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "picker-view",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      view: {
        mode: "projects",
        includeAll: true,
        page: 0,
      },
    });
    const acknowledge = vi.fn(async () => {});
    const editMessage = vi.fn(async () => {
      throw new Error("Interaction has already been acknowledged.");
    });

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge,
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage,
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    expect(editMessage).toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(discordSdkState.registerBuiltDiscordComponentMessage).not.toHaveBeenCalled();
    expect(discordSdkState.editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "message-1",
      expect.objectContaining({
        text: expect.stringContaining("Choose a project to filter recent Codex sessions"),
      }),
      expect.objectContaining({ accountId: "default" }),
    );
    expect(sendComponentMessage).not.toHaveBeenCalled();
  });

  it("acknowledges and clears Discord pending-input buttons by message id", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertPendingRequest({
      requestId: "pending-1",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      state: {
        requestId: "pending-1",
        options: ["Approve Once", "Cancel"],
        expiresAt: Date.now() + 60_000,
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "pending-input",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      requestId: "pending-1",
      actionIndex: 0,
    });
    const acknowledge = vi.fn(async () => {});
    const clearComponents = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const followUp = vi.fn(async () => {});
    const submitPendingInput = vi.fn(async () => true);
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "done" }),
        queueMessage: vi.fn(async () => false),
        submitPendingInput,
        submitPendingInputPayload: vi.fn(async () => false),
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: vi.fn(() => true),
        getThreadId: vi.fn(() => "thread-1"),
      },
    });

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge,
        reply,
        followUp,
        editMessage: vi.fn(async () => {}),
        clearComponents,
      },
    } as any);

    expect(submitPendingInput).toHaveBeenCalledWith(0);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(clearComponents).not.toHaveBeenCalled();
    expect(discordSdkState.editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "message-1",
      {
        text: "Sent to Codex.",
      },
      expect.objectContaining({ accountId: "default" }),
    );
    expect(reply).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });

  it("does not send a second Discord response after completing a questionnaire", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertPendingRequest({
      requestId: "questionnaire-1",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      state: {
        requestId: "questionnaire-1",
        options: [],
        expiresAt: Date.now() + 60_000,
        questionnaire: {
          currentIndex: 1,
          awaitingFreeform: false,
          questions: [
            {
              index: 0,
              id: "milk",
              header: "Milk",
              prompt: "Do you like milk on cereal?",
              options: [
                { key: "A", label: "Yes", description: "Sure." },
                { key: "B", label: "No", description: "Nope." },
              ],
            },
            {
              index: 1,
              id: "type",
              header: "Type",
              prompt: "What kind of milk?",
              options: [
                { key: "A", label: "Whole", description: "Richer." },
                { key: "B", label: "2%", description: "Lighter." },
              ],
            },
          ],
          answers: [
            {
              kind: "option",
              optionKey: "A",
              optionLabel: "Yes",
            },
            null,
          ],
        },
      },
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "pending-questionnaire",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      requestId: "questionnaire-1",
      questionIndex: 1,
      action: "select",
      optionIndex: 0,
    });
    const acknowledge = vi.fn(async () => {});
    const clearComponents = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const followUp = vi.fn(async () => {});
    const submitPendingInputPayload = vi.fn(async () => true);
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "plan",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "done" }),
        queueMessage: vi.fn(async () => false),
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload,
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: vi.fn(() => true),
        getThreadId: vi.fn(() => "thread-1"),
      },
    });

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge,
        reply,
        followUp,
        editMessage: vi.fn(async () => {}),
        clearComponents,
      },
    } as any);

    expect(submitPendingInputPayload).toHaveBeenCalledWith({
      answers: {
        milk: { answers: ["Yes"] },
        type: { answers: ["Whole"] },
      },
    });
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(clearComponents).not.toHaveBeenCalled();
    expect(discordSdkState.editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "message-1",
      {
        text: "Recorded your answers and sent them to Codex.",
      },
      expect.objectContaining({ accountId: "default" }),
    );
    expect(reply).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });

  it("annotates delayed questionnaire replies so Codex can distinguish them from defaults", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T12:31:00-04:00"));
    try {
      const { controller } = await createControllerHarness();
      const createdAt = Date.now() - 52 * 60_000;
      await (controller as any).store.upsertPendingRequest({
        requestId: "questionnaire-2",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        state: {
          requestId: "questionnaire-2",
          options: [],
          expiresAt: Date.now() + 7 * 24 * 60 * 60_000,
          questionnaire: {
            currentIndex: 1,
            awaitingFreeform: false,
            questions: [
              {
                index: 0,
                id: "milk",
                header: "Milk",
                prompt: "Do you like milk on cereal?",
                options: [
                  { key: "A", label: "Cereal (Recommended)", description: "Default-looking choice." },
                  { key: "B", label: "Bagels", description: "Alternate choice." },
                ],
                guidance: [],
              },
              {
                index: 1,
                id: "type",
                header: "Type",
                prompt: "What kind of milk?",
                options: [
                  { key: "A", label: "Whole", description: "Richer." },
                  { key: "B", label: "2%", description: "Lighter." },
                ],
                guidance: [],
              },
            ],
            answers: [
              {
                kind: "option",
                optionKey: "A",
                optionLabel: "Cereal (Recommended)",
              },
              null,
            ],
            responseMode: "structured",
          },
        },
        createdAt,
        updatedAt: createdAt,
      });
      const callback = await (controller as any).store.putCallback({
        kind: "pending-questionnaire",
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        requestId: "questionnaire-2",
        questionIndex: 1,
        action: "select",
        optionIndex: 0,
      });
      const acknowledge = vi.fn(async () => {});
      const clearComponents = vi.fn(async () => {});
      const reply = vi.fn(async () => {});
      const followUp = vi.fn(async () => {});
      const submitPendingInputPayload = vi.fn(async () => true);
      (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        workspaceDir: "/repo/openclaw",
        mode: "plan",
        handle: {
          result: Promise.resolve({ threadId: "thread-1", text: "done" }),
          queueMessage: vi.fn(async () => false),
          submitPendingInput: vi.fn(async () => false),
          submitPendingInputPayload,
          interrupt: vi.fn(async () => {}),
          isAwaitingInput: vi.fn(() => true),
          getThreadId: vi.fn(() => "thread-1"),
        },
      });

      await controller.handleDiscordInteractive({
        channel: "discord",
        accountId: "default",
        interactionId: "interaction-2",
        conversationId: "channel:chan-1",
        auth: { isAuthorizedSender: true },
        interaction: {
          kind: "button",
          data: `codexapp:${callback.token}`,
          namespace: "codexapp",
          payload: callback.token,
          messageId: "message-2",
        },
        senderId: "user-1",
        senderUsername: "Ada",
        respond: {
          acknowledge,
          reply,
          followUp,
          editMessage: vi.fn(async () => {}),
          clearComponents,
        },
      } as any);

      expect(submitPendingInputPayload).toHaveBeenCalledWith({
        answers: {
          milk: {
            answers: [
              "Cereal (Recommended)",
              "user_note: This answer was selected by the user in chat after 52 minutes; it was not auto-selected.",
            ],
          },
          type: { answers: ["Whole"] },
        },
      });
      expect(acknowledge).toHaveBeenCalledTimes(1);
      expect(clearComponents).not.toHaveBeenCalled();
      expect(reply).not.toHaveBeenCalled();
      expect(followUp).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes raw Discord callback conversation ids for guild interactions", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "picker-view",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      view: {
        mode: "projects",
        includeAll: true,
        page: 0,
      },
    });

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "1481858418548412579",
      guildId: "guild-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
        clearComponents: vi.fn(async () => {
          throw new Error("Interaction has already been acknowledged.");
        }),
      },
    } as any);

    expect(sendComponentMessage).not.toHaveBeenCalled();
  });

  it("hydrates a pending approved binding when status is requested after core approval", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand("cas_status", buildDiscordCommandContext({
      commandBody: "/cas_status",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));

    expect(reply.text).toContain("Binding: active");
    expect((controller as any).store.getBinding({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:chan-1",
    })).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
      }),
    );
  });

  it("shows cas_status as none when no core binding exists", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/discrawl",
      threadTitle: "Summarize tools used",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildDiscordCommandContext({
        from: "discord:1177378744822943744",
        to: "slash:1177378744822943744",
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => null),
      }),
    );

    expect(reply.text).toContain("Binding: none");
    expect(reply.text).toContain(`Plugin version: ${TEST_PLUGIN_VERSION}`);
    expect(reply.text).not.toContain("Project folder: /repo/discrawl");
    expect(reply.text).not.toContain("Session: session-1");
  });

  it("does not hydrate a denied pending bind into cas_status", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/discrawl",
      threadTitle: "Summarize tools used",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_status",
      buildTelegramCommandContext({
        commandBody: "/cas_status",
        getCurrentConversationBinding: vi.fn(async () => null),
      }),
    );

    expect(reply.text).toContain("Binding: none");
    expect(reply.text).not.toContain("Project folder: /repo/discrawl");
    expect((controller as any).store.getBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    })).toBeNull();
  });

  it("shows plan mode on in cas_status when the bound conversation has an active plan run", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      updatedAt: Date.now(),
    });
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "plan",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "planned" }),
        queueMessage: vi.fn(async () => true),
        getThreadId: () => "thread-1",
        interrupt: vi.fn(async () => {}),
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });

    const reply = await controller.handleCommand("cas_status", buildDiscordCommandContext({
      commandBody: "/cas_status",
      getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
    }));

    expect(reply.text).toContain("Binding: active");
    expect(reply.text).toContain("Plan mode: on");
  });

  it("parses unicode em dash --sync for cas_rename and renames the Telegram topic", async () => {
    const { controller, clientMock, renameTopic } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Old Name",
      updatedAt: Date.now(),
    });
    clientMock.setThreadName = vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "New Topic Name",
    }));

    const reply = await controller.handleCommand(
      "cas_rename",
      buildTelegramCommandContext({
        args: "—sync New Topic Name",
        commandBody: "/cas_rename —sync New Topic Name",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(clientMock.setThreadName).toHaveBeenCalledWith({
      sessionKey: "session-1",
      threadId: "thread-1",
      name: "New Topic Name",
    });
    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "New Topic Name",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(reply).toEqual({ text: 'Renamed the Codex thread to "New Topic Name".' });
  });

  it("parses unicode em dash --sync for cas_resume and renames the Telegram topic", async () => {
    const { controller, renameTopic, sendMessageTelegram } = await createControllerHarness();

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "—sync thread-1",
        commandBody: "/cas_resume —sync thread-1",
        messageThreadId: 456,
      }),
    );

    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(reply).toEqual({});
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Thread Name: Discord Thread"),
      expect.objectContaining({ accountId: "default", messageThreadId: 456 }),
    );
  });

  it("pins the Telegram binding summary message on resume and unpins it on detach", async () => {
    const { controller } = await createControllerHarness();
    const fetchMock = vi.mocked(fetch);

    await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "thread-1",
        commandBody: "/cas_resume thread-1",
        messageThreadId: 456,
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-token/pinChatMessage",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(
      expect.objectContaining({
        chat_id: "123",
        message_id: 1,
      }),
    );
    expect(
      (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toEqual(
      expect.objectContaining({
        pinnedBindingMessage: {
          provider: "telegram",
          messageId: "1",
          chatId: "123",
        },
      }),
    );

    await controller.handleCommand(
      "cas_detach",
      buildTelegramCommandContext({
        commandBody: "/cas_detach",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "binding-1" })),
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottelegram-token/unpinChatMessage",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });

  it("pins the Discord binding summary message on resume and unpins it on detach", async () => {
    const { controller } = await createControllerHarness();
    const fetchMock = vi.mocked(fetch);
    vi.spyOn(controller as any, "resolveDiscordBotToken").mockResolvedValue("discord-token");

    await controller.handleCommand(
      "cas_resume",
      buildDiscordCommandContext({
        args: "thread-1",
        commandBody: "/cas_resume thread-1",
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel%3Achan-1/pins/discord-msg-1",
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({
          Authorization: "Bot discord-token",
        }),
      }),
    );
    expect(
      (controller as any).store.getBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      }),
    ).toEqual(
      expect.objectContaining({
        pinnedBindingMessage: {
          provider: "discord",
          messageId: "discord-msg-1",
          channelId: "channel:chan-1",
        },
      }),
    );

    await controller.handleCommand(
      "cas_detach",
      buildDiscordCommandContext({
        commandBody: "/cas_detach",
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "binding-1" })),
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://discord.com/api/v10/channels/channel%3Achan-1/pins/discord-msg-1",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bot discord-token",
        }),
      }),
    );
  });

  it("replays pending cas_resume --sync effects after approval hydrates on the next resume command", async () => {
    const { controller, clientMock, renameTopic, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadContext = vi.fn(async () => ({
      lastUserMessage: "What were we doing here?",
      lastAssistantMessage: "We were working on the app-server lifetime refactor.",
    }));
    const requestConversationBinding = vi
      .fn()
      .mockResolvedValueOnce({
        status: "pending" as const,
        reply: { text: "Plugin bind approval required" },
      });

    const pendingReply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--sync thread-1",
        commandBody: "/cas_resume --sync thread-1",
        messageThreadId: 456,
        requestConversationBinding,
      }),
    );

    expect(pendingReply).toEqual({ text: "Plugin bind approval required" });
    expect((controller as any).store.getPendingBind({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
    })).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        syncTopic: true,
        notifyBound: true,
      }),
    );

    const hydratedReply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_resume --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    await flushAsyncWork();

    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(hydratedReply).toEqual({});
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Thread Name: Discord Thread"),
      expect.objectContaining({ accountId: "default", messageThreadId: 456 }),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "Last User Request in Thread:",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "Last Agent Reply in Thread:",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("retries an incomplete cas_resume bind before falling back to the picker", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      syncTopic: true,
      notifyBound: true,
      updatedAt: Date.now(),
    });
    const requestConversationBinding = vi.fn(async () => ({
      status: "pending" as const,
      reply: { text: "Plugin bind approval required" },
    }));

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_resume --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => null),
        requestConversationBinding,
      }),
    );

    expect(reply).toEqual({ text: "Plugin bind approval required" });
    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "Bind this conversation to Codex thread Discord Thread.",
      }),
    );
  });

  it("rebinds an incomplete cas_resume bind when the retry is approved immediately", async () => {
    const { controller, renameTopic, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadContext = vi.fn(async () => ({
      lastUserMessage: "What were we doing here?",
      lastAssistantMessage: "We were working on the app-server lifetime refactor.",
    }));

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      syncTopic: true,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_resume",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_resume --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => null),
        requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      }),
    );

    await flushAsyncWork();

    expect(reply).toEqual({});
    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Thread Name: Discord Thread"),
      expect.objectContaining({ accountId: "default", messageThreadId: 456 }),
    );
    expect(
      (controller as any).store.getBinding({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
      }),
    );
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("applies pending bind effects immediately when core reports the bind was approved", async () => {
    const { controller, renameTopic, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.readThreadContext = vi.fn(async () => ({
      lastUserMessage: "What were we doing here?",
      lastAssistantMessage: "We were working on the app-server lifetime refactor.",
    }));

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      syncTopic: true,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    await controller.handleConversationBindingResolved({
      status: "approved",
      binding: {
        bindingId: "binding-1",
        pluginId: "openclaw-codex-app-server",
        pluginRoot: "/plugins/codex",
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
        threadId: 456,
        boundAt: Date.now(),
      },
      decision: "allow-once",
      request: {
        summary: "Bind this conversation to Codex thread Discord Thread.",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
        },
      },
    } as any);

    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Thread Name: Discord Thread"),
      expect.objectContaining({ accountId: "default", messageThreadId: 456 }),
    );
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "123",
      "Last User Request in Thread:",
      expect.objectContaining({ accountId: "default", messageThreadId: 456 }),
    );
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("clears pending bind state immediately when core reports the bind was denied", async () => {
    const { controller, renameTopic, sendMessageTelegram } = await createControllerHarness();

    await (controller as any).store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      syncTopic: true,
      notifyBound: true,
      updatedAt: Date.now(),
    });

    await controller.handleConversationBindingResolved({
      status: "denied",
      decision: "deny",
      request: {
        summary: "Bind this conversation to Codex thread Discord Thread.",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "123:topic:456",
          parentConversationId: "123",
          threadId: 456,
        },
      },
    } as any);

    expect(renameTopic).not.toHaveBeenCalled();
    expect(sendMessageTelegram).not.toHaveBeenCalled();
    expect(
      (controller as any).store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      }),
    ).toBeNull();
  });

  it("preserves syncTopic on Telegram resume pickers and renames the topic after callback bind", async () => {
    const { controller, renameTopic } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      syncTopic: true,
    });

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      requestConversationBinding: vi.fn(async () => ({ status: "bound" as const })),
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(renameTopic).toHaveBeenCalledWith(
      "123",
      456,
      "Discord Thread (openclaw)",
      expect.objectContaining({ accountId: "default" }),
    );
  });

  it("sends the Telegram bind approval prompt only once for resume callbacks", async () => {
    const { controller } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
    });
    const reply = vi.fn(async () => {});
    const buttons = [[{ text: "Allow once", callback_data: "pluginbind:approval:o" }]];

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      requestConversationBinding: vi.fn(async () => ({
        status: "pending" as const,
        reply: {
          text: "Plugin bind approval required",
          channelData: {
            telegram: {
              buttons,
            },
          },
        },
      })),
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply,
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith({
      text: "Plugin bind approval required",
      buttons,
    });
  });

  it("renders Telegram bind approval buttons from interactive reply blocks", async () => {
    const { controller } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
    });
    const reply = vi.fn(async () => {});

    await controller.handleTelegramInteractive({
      channel: "telegram",
      accountId: "default",
      conversationId: "123:topic:456",
      parentConversationId: "123",
      threadId: 456,
      requestConversationBinding: vi.fn(async () => ({
        status: "pending" as const,
        reply: {
          text: "Plugin bind approval required",
          interactive: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  {
                    label: "Allow once",
                    value: "pluginbind:approval:o",
                    style: "success",
                  },
                  {
                    label: "Always allow",
                    value: "pluginbind:approval:a",
                    style: "primary",
                  },
                  {
                    label: "Deny",
                    value: "pluginbind:approval:d",
                    style: "danger",
                  },
                ],
              },
            ],
          },
        } as any,
      })),
      callback: {
        payload: callback.token,
      },
      respond: {
        clearButtons: vi.fn(async () => {}),
        reply,
        editMessage: vi.fn(async () => {}),
      },
    } as any);

    expect(reply).toHaveBeenCalledWith({
      text: "Plugin bind approval required",
      buttons: [
        [
          { text: "Allow once", callback_data: "pluginbind:approval:o", style: "success" },
          { text: "Always allow", callback_data: "pluginbind:approval:a", style: "primary" },
          { text: "Deny", callback_data: "pluginbind:approval:d", style: "danger" },
        ],
      ],
    });
  });

  it("offers compact rename style buttons for cas_rename --sync without a name", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      threadTitle: "Discord Thread",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_rename",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_rename --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    expect(reply.text).toContain("Choose a name style");
    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons).toHaveLength(2);
    expect(buttons[0][0].text).toBe("Discord Thread (openclaw)");
    expect(buttons[1][0].text).toBe("Discord Thread");
    expect(String(buttons[0][0].callback_data)).toMatch(/^codexapp:/);
    expect(String(buttons[0][0].callback_data).length).toBeLessThan(64);
  });

  it("deduplicates repeated project suffixes in rename style suggestions", async () => {
    const { controller } = await createControllerHarness();
    (controller as any).client.readThreadState = vi.fn(async () => ({
      threadId: "thread-1",
      threadName: "Explore OAuth login for gifgrep (gifgrep) (gifgrep)",
      cwd: "/repo/gifgrep",
    }));
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123:topic:456",
        parentConversationId: "123",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/gifgrep",
      threadTitle: "Explore OAuth login for gifgrep (gifgrep) (gifgrep)",
      updatedAt: Date.now(),
    });

    const reply = await controller.handleCommand(
      "cas_rename",
      buildTelegramCommandContext({
        args: "--sync",
        commandBody: "/cas_rename --sync",
        messageThreadId: 456,
        getCurrentConversationBinding: vi.fn(async () => ({ bindingId: "b1" })),
      }),
    );

    const buttons = (reply.channelData as any)?.telegram?.buttons;
    expect(buttons).toHaveLength(2);
    expect(buttons[0][0].text).toBe("Explore OAuth login for gifgrep (gifgrep)");
    expect(buttons[1][0].text).toBe("Explore OAuth login for gifgrep");
  });

  it("requests approved conversation binding when binding a Discord thread", async () => {
    const { controller } = await createControllerHarness();
    const requestConversationBinding = vi.fn(async () => ({ status: "bound" as const }));

    await controller.handleCommand("cas_resume", buildDiscordCommandContext({
      args: "thread-1",
      commandBody: "/cas_resume thread-1",
      requestConversationBinding,
    }));

    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: expect.stringContaining("Bind this conversation to Codex thread"),
      }),
    );
  });

  it("sends the Discord bind approval prompt only once for resume callbacks", async () => {
    const { controller, sendComponentMessage } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
    });
    const acknowledge = vi.fn(async () => {});
    const clearComponents = vi.fn(async () => {});
    const reply = vi.fn(async () => {});
    const requestConversationBinding = vi.fn(async () => ({
      status: "pending" as const,
      reply: {
        text: "Plugin bind approval required",
        channelData: {
          telegram: {
            buttons: [[{ text: "Allow once", callback_data: "pluginbind:approval:o" }]],
          },
        },
      },
    }));

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      requestConversationBinding,
      respond: {
        acknowledge,
        reply,
        followUp: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
        clearComponents,
      },
    } as any);

    expect(sendComponentMessage).toHaveBeenCalledTimes(1);
    expect(sendComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      expect.objectContaining({
        text: "Plugin bind approval required",
      }),
      expect.objectContaining({ accountId: "default" }),
    );
    expect(discordSdkState.editDiscordComponentMessage).toHaveBeenCalledWith(
      "channel:chan-1",
      "message-1",
      {
        text: "Binding approval requested below.",
      },
      expect.objectContaining({ accountId: "default" }),
    );
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge.mock.invocationCallOrder[0]).toBeLessThan(
      requestConversationBinding.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(clearComponents).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("claims inbound Discord messages for raw thread ids after a typed bind", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalled();
  });

  it("matches a Discord binding even when the inbound event includes a parent conversation id", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "What is the CWD?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      parentConversationId: "987654321",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(startTurn).toHaveBeenCalled();
  });

  it("does not claim inbound Discord messages when only core binding state exists", async () => {
    const { controller } = await createControllerHarness();

    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: false });
  });

  it("uses a raw Discord channel id for the typing lease on inbound claims", async () => {
    const { controller, discordTypingStart } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
    }));

    const result = await controller.handleInboundClaim({
      content: "hello",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(discordTypingStart).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "1481858418548412579",
        accountId: "default",
      }),
    );
  });

  it("skips the Discord typing lease for bound DM inbound claims", async () => {
    const { controller, discordTypingStart } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
    }));

    const result = await controller.handleInboundClaim({
      content: "hello",
      channel: "discord",
      accountId: "default",
      conversationId: "user:1177378744822943744",
      isGroup: false,
      metadata: {},
    });

    expect(result).toEqual({ handled: true });
    expect(discordTypingStart).not.toHaveBeenCalled();
  });

  it("implements a plan by switching back to default mode with a short prompt", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const callback = await (controller as any).store.putCallback({
      kind: "run-prompt",
      token: "run-prompt-token",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      prompt: "Implement the plan.",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "openai/gpt-5.4",
          developerInstructions: null,
        },
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "implemented",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;
    const reply = vi.fn(async () => {});
    const followUp = vi.fn(async () => {});

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply,
        followUp,
        editMessage: vi.fn(async () => {}),
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    expect(reply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith({ text: "Sent the plan to Codex.", ephemeral: true });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Implement the plan.",
        collaborationMode: {
          mode: "default",
          settings: {
            model: "openai/gpt-5.4",
            developerInstructions: null,
          },
        },
      }),
    );
  });

  it("supports cas_plan off to interrupt an active plan run", async () => {
    const { controller } = await createControllerHarness();
    const interrupt = vi.fn(async () => {});
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "plan",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "planned" }),
        queueMessage: vi.fn(async () => true),
        getThreadId: () => "thread-1",
        interrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });

    const reply = await controller.handleCommand(
      "cas_plan",
      buildDiscordCommandContext({
        args: "off",
        commandBody: "/cas_plan off",
      }),
    );

    expect(interrupt).toHaveBeenCalled();
    expect(reply).toEqual({
      text: "Exited Codex plan mode. Future turns will use default coding mode.",
    });
  });

  it("restarts a lingering active plan run instead of queueing a normal inbound message into it", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const staleQueueMessage = vi.fn(async () => true);
    const staleInterrupt = vi.fn(async () => {});
    (controller as any).activeRuns.set("discord::default::channel:1481858418548412579::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      workspaceDir: "/repo/openclaw",
      mode: "plan",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale-plan" }),
        queueMessage: staleQueueMessage,
        getThreadId: () => "thread-1",
        interrupt: staleInterrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "And? Build it?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(staleQueueMessage).not.toHaveBeenCalled();
    expect(staleInterrupt).toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalled();
  });

  it("passes trusted local media roots when sending a Telegram plan attachment", async () => {
    const { controller, sendMessageTelegram, stateDir } = await createControllerHarness();
    const attachmentPath = path.join(stateDir, "tmp", "plan.md");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, "# Plan\n");

    const sent = await (controller as any).sendReply(
      {
        channel: "telegram",
        accountId: "default",
        conversationId: "8460800771",
      },
      {
        mediaUrl: attachmentPath,
      },
    );

    expect(sent).toBe(true);
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "8460800771",
      "",
      expect.objectContaining({
        mediaUrl: attachmentPath,
        mediaLocalRoots: expect.arrayContaining([stateDir, path.dirname(attachmentPath)]),
      }),
    );
  });

  it("passes trusted local media roots when sending a Discord plan attachment", async () => {
    const { controller, sendMessageDiscord, stateDir } = await createControllerHarness();
    const attachmentPath = path.join(stateDir, "tmp", "plan.md");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, "# Plan\n");

    const sent = await (controller as any).sendReply(
      {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1177378744822943744",
      },
      {
        mediaUrl: attachmentPath,
      },
    );

    expect(sent).toBe(true);
    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "user:1177378744822943744",
      "",
      expect.objectContaining({
        mediaUrl: attachmentPath,
        mediaLocalRoots: expect.arrayContaining([stateDir, path.dirname(attachmentPath)]),
      }),
    );
  });

  it("restarts a Discord bound run when the active queue path fails", async () => {
    const { controller } = await createControllerHarness();
    await (controller as any).store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      sessionKey: "session-1",
      threadId: "thread-1",
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });
    const staleInterrupt = vi.fn(async () => {});
    (controller as any).activeRuns.set("discord::default::channel:1481858418548412579::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:1481858418548412579",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale" }),
        queueMessage: vi.fn(async () => {
          throw new Error("codex app server rpc error (-32600): Invalid request: missing field `threadId`");
        }),
        getThreadId: () => "thread-1",
        interrupt: staleInterrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "hello",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    const result = await controller.handleInboundClaim({
      content: "who are you?",
      channel: "discord",
      accountId: "default",
      conversationId: "1481858418548412579",
      isGroup: true,
      metadata: { guildId: "guild-1" },
    });

    expect(result).toEqual({ handled: true });
    expect(staleInterrupt).toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        existingThreadId: "thread-1",
        prompt: "who are you?",
      }),
    );
  });

  it("warns and restarts when an active run declines a queued prompt", async () => {
    const { controller, api } = await createControllerHarness();
    const staleInterrupt = vi.fn(async () => {});
    (controller as any).activeRuns.set("discord::default::channel:chan-1::", {
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      workspaceDir: "/repo/openclaw",
      mode: "default",
      handle: {
        result: Promise.resolve({ threadId: "thread-1", text: "stale" }),
        queueMessage: vi.fn(async () => false),
        getThreadId: () => "thread-1",
        interrupt: staleInterrupt,
        isAwaitingInput: () => false,
        submitPendingInput: vi.fn(async () => false),
        submitPendingInputPayload: vi.fn(async () => false),
      },
    });
    const startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "fresh",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => true),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));
    (controller as any).client.startTurn = startTurn;

    await (controller as any).startTurn({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
      binding: {
        conversation: {
          channel: "discord",
          accountId: "default",
          conversationId: "channel:chan-1",
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "command",
    });

    expect(staleInterrupt).toHaveBeenCalled();
    expect(startTurn).toHaveBeenCalled();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("reached an active run but was not accepted; restarting"),
    );
  });

  it("does not send the plan keepalive after a questionnaire is already visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T13:10:00-04:00"));
    try {
      const harness = await createControllerHarness();
      const { controller } = harness;
      const { sendMessageTelegram } = harness;
      let resolveResult: ((value: unknown) => void) | undefined;
      const result = new Promise((resolve) => {
        resolveResult = resolve;
      });
      (controller as any).client.startTurn = vi.fn((params: any) => {
        void Promise.resolve().then(() =>
          params.onPendingInput?.({
            requestId: "req-plan-1",
            options: [],
            expiresAt: Date.now() + 7 * 24 * 60 * 60_000,
            method: "item/tool/requestUserInput",
            questionnaire: {
              currentIndex: 0,
              questions: [
                {
                  index: 0,
                  id: "breakfast",
                  header: "Breakfast",
                  prompt: "Do you like cereal or bagels?",
                  options: [
                    { key: "A", label: "Cereal (Recommended)", description: "Choose cereal." },
                    { key: "B", label: "Bagels", description: "Choose bagels." },
                  ],
                  guidance: [],
                  allowFreeform: true,
                },
              ],
              answers: [null],
              responseMode: "structured",
            },
          }),
        );
        return {
          result,
          getThreadId: () => "thread-1",
          queueMessage: vi.fn(async () => false),
          interrupt: vi.fn(async () => {}),
          isAwaitingInput: () => true,
          submitPendingInput: vi.fn(async () => false),
          submitPendingInputPayload: vi.fn(async () => false),
        };
      });

      await (controller as any).startPlan({
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "8460800771",
        },
        binding: null,
        workspaceDir: "/repo/openclaw",
        prompt: "Ask the breakfast question.",
      });

      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(12_500);

      const sentTexts = sendMessageTelegram.mock.calls.flatMap((call) => {
        const [, text] = call as unknown as [unknown, unknown];
        return typeof text === "string" ? [text] : [];
      });
      expect(sentTexts).toContain(
        "Starting Codex plan mode. I’ll relay the questions and final plan as they arrive.",
      );
      expect((controller as any).store.getPendingRequestById("req-plan-1")).not.toBeNull();
      expect(sentTexts).not.toContain("Codex is still planning...");

      resolveResult?.({
        threadId: "thread-1",
        aborted: true,
      });
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the user to log back in when Codex reports OpenAI auth is required", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    clientMock.readAccount.mockResolvedValue({
      type: "chatgpt",
      requiresOpenaiAuth: true,
    } as any);
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.reject(new Error("codex app server rpc error (-32001): unauthorized")),
      getThreadId: () => undefined,
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "8460800771",
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "8460800771",
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "8460800771",
      "Codex authentication failed on this machine. Run `codex logout` and `codex login`, then try again.",
      expect.anything(),
    );
    expect(clientMock.readAccount).toHaveBeenCalledWith({
      sessionKey: "session-1",
      refreshToken: true,
    });
  });

  it("maps obvious OAuth failures to the same re-login guidance even if account/read also fails", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    clientMock.readAccount.mockRejectedValue(new Error("account probe failed"));
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.reject(new Error("refresh token expired")),
      getThreadId: () => undefined,
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "8460800771",
      },
      binding: null,
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "8460800771",
      "Codex authentication failed on this machine. Run `codex logout` and `codex login`, then try again.",
      expect.anything(),
    );
  });

  it("surfaces explicit failed turns as auth failures when the terminal error is unauthorized", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        terminalStatus: "failed",
        terminalError: {
          message: "unauthorized",
          codexErrorInfo: "unauthorized",
          httpStatusCode: 401,
        },
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "8460800771",
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "8460800771",
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "8460800771",
      "Codex authentication failed on this machine. Run `codex logout` and `codex login`, then try again.",
      expect.anything(),
    );
    expect(clientMock.readAccount).toHaveBeenCalledWith({
      sessionKey: "session-1",
      refreshToken: true,
    });
  });

  it("keeps empty completed turns generic instead of inferring an auth failure", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        text: "",
        terminalStatus: "completed",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "8460800771",
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "8460800771",
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "8460800771",
      "Codex completed without a text reply.",
      expect.anything(),
    );
    expect(clientMock.readAccount).not.toHaveBeenCalled();
  });

  it("does not probe auth after an approval cancel completes without assistant text", async () => {
    const { controller, clientMock, sendMessageTelegram } = await createControllerHarness();
    (controller as any).client.startTurn = vi.fn(() => ({
      result: Promise.resolve({
        threadId: "thread-1",
        stoppedReason: "approval",
      }),
      getThreadId: () => "thread-1",
      queueMessage: vi.fn(async () => false),
      interrupt: vi.fn(async () => {}),
      isAwaitingInput: () => false,
      submitPendingInput: vi.fn(async () => false),
      submitPendingInputPayload: vi.fn(async () => false),
    }));

    await (controller as any).startTurn({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "8460800771",
      },
      binding: {
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "8460800771",
        },
        sessionKey: "session-1",
        threadId: "thread-1",
        workspaceDir: "/repo/openclaw",
        updatedAt: Date.now(),
      },
      workspaceDir: "/repo/openclaw",
      prompt: "who are you?",
      reason: "inbound",
    });

    await flushAsyncWork();
    expect(sendMessageTelegram).toHaveBeenCalledWith(
      "8460800771",
      "Cancelled the Codex approval request.",
      expect.anything(),
    );
    expect(clientMock.readAccount).not.toHaveBeenCalled();
  });

  it("dismisses the picker when cancel-picker callback is pressed", async () => {
    const { controller } = await createControllerHarness();
    const callback = await (controller as any).store.putCallback({
      kind: "cancel-picker",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:chan-1",
      },
    });
    const acknowledge = vi.fn(async () => {});
    const editMessage = vi.fn(async () => {});

    await controller.handleDiscordInteractive({
      channel: "discord",
      accountId: "default",
      interactionId: "interaction-1",
      conversationId: "channel:chan-1",
      auth: { isAuthorizedSender: true },
      interaction: {
        kind: "button",
        data: `codexapp:${callback.token}`,
        namespace: "codexapp",
        payload: callback.token,
        messageId: "message-1",
      },
      senderId: "user-1",
      senderUsername: "Ada",
      respond: {
        acknowledge,
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage,
        clearComponents: vi.fn(async () => {}),
      },
    } as any);

    // editPicker uses ctx.respond.editMessage first; when that succeeds it calls
    // registerBuiltDiscordComponentMessage instead of editDiscordComponentMessage
    expect(editMessage).toHaveBeenCalledTimes(1);
    expect(discordSdkState.registerBuiltDiscordComponentMessage).toHaveBeenCalledWith({
      buildResult: expect.objectContaining({
        components: expect.any(Array),
        entries: expect.any(Array),
      }),
      messageId: "message-1",
    });
    // The callback should be removed from the store
    expect((controller as any).store.getCallback(callback.token)).toBeNull();
  });
});
