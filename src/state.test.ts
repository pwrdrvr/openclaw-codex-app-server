import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PluginStateStore, buildPluginSessionKey } from "./state.js";

async function makeStoreDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "oc-codex-plugin-"));
}

async function makeStore(dir?: string): Promise<PluginStateStore> {
  const resolvedDir = dir ?? (await makeStoreDir());
  const store = new PluginStateStore(resolvedDir);
  await store.load();
  return store;
}

describe("state store", () => {
  it("persists bindings and callbacks", async () => {
    const dir = await makeStoreDir();
    const store = await makeStore(dir);
    await store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "124",
      },
      threadId: "thread-pending",
      workspaceDir: "/tmp/pending",
      threadTitle: "Pending thread",
      updatedAt: Date.now(),
    });
    await store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: buildPluginSessionKey("thread-1"),
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
      contextUsage: {
        totalTokens: 9_800,
        contextWindow: 258_000,
        remainingPercent: 96,
      },
      updatedAt: Date.now(),
    });
    await store.upsertMonitorBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:monitor-1",
      },
      workspaceDir: "/tmp/work",
      lastSummarySignature: "Monitor: active",
      updatedAt: Date.now(),
    });
    await store.upsertThreadSeenState({
      threadId: "thread-1",
      lastSeenUpdatedAt: Date.now(),
      threadTitle: "Pending thread",
      workspaceDir: "/tmp/work",
      updatedAt: Date.now(),
    });
    const callback = await store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
      syncTopic: true,
    });
    const promptCallback = await store.putCallback({
      kind: "run-prompt",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      prompt: "Implement the plan.",
      workspaceDir: "/tmp/work",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "openai/gpt-5.4",
          developerInstructions: null,
        },
      },
    });
    const modelCallback = await store.putCallback({
      kind: "set-model",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      model: "gpt-5.2-codex",
    });
    const replyCallback = await store.putCallback({
      kind: "reply-text",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      text: "Okay. Staying in plan mode.",
    });
    const reloaded = await makeStore(dir);

    expect(reloaded.listBindings()).toHaveLength(1);
    expect(reloaded.listMonitorBindings()).toHaveLength(1);
    expect(reloaded.listBindings()[0]?.contextUsage?.totalTokens).toBe(9_800);
    expect(reloaded.listMonitorBindings()[0]?.workspaceDir).toBe("/tmp/work");
    expect(reloaded.getThreadSeenState("thread-1")?.threadTitle).toBe("Pending thread");
    expect(reloaded.getPendingBind({
      channel: "telegram",
      accountId: "default",
      conversationId: "124",
    })?.threadId).toBe("thread-pending");
    expect(reloaded.getCallback(callback.token)?.kind).toBe("resume-thread");
    const resumeCallback = reloaded.getCallback(callback.token);
    expect(resumeCallback?.kind).toBe("resume-thread");
    expect(resumeCallback && resumeCallback.kind === "resume-thread" ? resumeCallback.syncTopic : undefined).toBe(true);
    expect(reloaded.getCallback(promptCallback.token)?.kind).toBe("run-prompt");
    const runPrompt = reloaded.getCallback(promptCallback.token);
    expect(runPrompt && runPrompt.kind === "run-prompt" ? runPrompt.collaborationMode : undefined).toEqual({
      mode: "default",
      settings: {
        model: "openai/gpt-5.4",
        developerInstructions: null,
      },
    });
    expect(reloaded.getCallback(modelCallback.token)?.kind).toBe("set-model");
    expect(reloaded.getCallback(replyCallback.token)?.kind).toBe("reply-text");
  });

  it("removes pending requests and related callbacks", async () => {
    const store = await makeStore();
    await store.upsertPendingRequest({
      requestId: "req-1",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "chan-1",
      },
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
      state: {
        requestId: "req-1",
        options: ["yes"],
        expiresAt: Date.now() + 10_000,
      },
      updatedAt: Date.now(),
    });
    const callback = await store.putCallback({
      kind: "pending-input",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "chan-1",
      },
      requestId: "req-1",
      actionIndex: 0,
    });
    const questionnaireCallback = await store.putCallback({
      kind: "pending-questionnaire",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "chan-1",
      },
      requestId: "req-1",
      questionIndex: 0,
      action: "select",
      optionIndex: 0,
    });
    await store.removePendingRequest("req-1");
    expect(store.getPendingRequestById("req-1")).toBeNull();
    expect(store.getCallback(callback.token)).toBeNull();
    expect(store.getCallback(questionnaireCallback.token)).toBeNull();
  });

  it("clears a pending bind when the binding is finalized", async () => {
    const store = await makeStore();
    await store.upsertPendingBind({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1",
      },
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
      updatedAt: Date.now(),
    });

    await store.upsertBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "user:1",
      },
      sessionKey: buildPluginSessionKey("thread-1"),
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
      updatedAt: Date.now(),
    });

    expect(
      store.getPendingBind({
        channel: "discord",
        accountId: "default",
        conversationId: "user:1",
      }),
    ).toBeNull();
  });

  it("clears a pending bind when the conversation is explicitly removed", async () => {
    const store = await makeStore();
    await store.upsertPendingBind({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
      updatedAt: Date.now(),
    });

    await store.removeBinding({
      channel: "telegram",
      accountId: "default",
      conversationId: "123",
    });

    expect(
      store.getPendingBind({
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      }),
    ).toBeNull();
  });

  it("removes monitor bindings independently", async () => {
    const store = await makeStore();
    await store.upsertMonitorBinding({
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:monitor-1",
      },
      workspaceDir: "/repo/openclaw",
      updatedAt: Date.now(),
    });

    await store.removeMonitorBinding({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:monitor-1",
    });

    expect(
      store.getMonitorBinding({
        channel: "discord",
        accountId: "default",
        conversationId: "channel:monitor-1",
      }),
    ).toBeNull();
  });
});
