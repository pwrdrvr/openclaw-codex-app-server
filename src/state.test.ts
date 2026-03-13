import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PluginStateStore, buildPluginSessionKey } from "./state.js";

async function makeStore(): Promise<PluginStateStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-codex-plugin-"));
  const store = new PluginStateStore(dir);
  await store.load();
  return store;
}

describe("state store", () => {
  it("persists bindings and callbacks", async () => {
    const store = await makeStore();
    await store.upsertBinding({
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "123",
      },
      sessionKey: buildPluginSessionKey("thread-1"),
      threadId: "thread-1",
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
    });
    expect(store.listBindings()).toHaveLength(1);
    expect(store.getCallback(callback.token)?.kind).toBe("resume-thread");
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
