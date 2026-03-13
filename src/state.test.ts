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
    const callback = await store.putCallback({
      kind: "resume-thread",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      threadId: "thread-1",
      workspaceDir: "/tmp/work",
    });
    const promptCallback = await store.putCallback({
      kind: "run-prompt",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      prompt: "$skill-creator",
      workspaceDir: "/tmp/work",
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
    expect(reloaded.listBindings()[0]?.contextUsage?.totalTokens).toBe(9_800);
    expect(reloaded.getCallback(callback.token)?.kind).toBe("resume-thread");
    expect(reloaded.getCallback(promptCallback.token)?.kind).toBe("run-prompt");
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
    await store.removePendingRequest("req-1");
    expect(store.getPendingRequestById("req-1")).toBeNull();
    expect(store.getCallback(callback.token)).toBeNull();
  });
});
