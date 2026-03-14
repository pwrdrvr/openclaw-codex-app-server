import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { CALLBACK_TTL_MS, CALLBACK_TOKEN_BYTES, PLUGIN_ID, STORE_VERSION } from "./types.js";
import type {
  CallbackAction,
  CollaborationMode,
  ConversationTarget,
  StoreSnapshot,
  StoredBinding,
  StoredPendingBind,
  StoredPendingRequest,
} from "./types.js";

type PutCallbackInput =
  | {
      kind: "resume-thread";
      conversation: ConversationTarget;
      threadId: string;
      workspaceDir: string;
      syncTopic?: boolean;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "pending-input";
      conversation: ConversationTarget;
      requestId: string;
      actionIndex: number;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "pending-questionnaire";
      conversation: ConversationTarget;
      requestId: string;
      questionIndex: number;
      action: "select" | "prev" | "next" | "freeform";
      optionIndex?: number;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "picker-view";
      conversation: ConversationTarget;
      view: Extract<CallbackAction, { kind: "picker-view" }>["view"];
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "run-prompt";
      conversation: ConversationTarget;
      prompt: string;
      workspaceDir?: string;
      collaborationMode?: CollaborationMode;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "set-model";
      conversation: ConversationTarget;
      model: string;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "reply-text";
      conversation: ConversationTarget;
      text: string;
      token?: string;
      ttlMs?: number;
    };

function toConversationKey(target: ConversationTarget): string {
  const channel = target.channel.trim().toLowerCase();
  return [
    channel,
    target.accountId.trim(),
    target.conversationId.trim(),
    channel === "telegram" ? (target.parentConversationId?.trim() ?? "") : "",
  ].join("::");
}

function cloneSnapshot(value?: Partial<StoreSnapshot>): StoreSnapshot {
  return {
    version: STORE_VERSION,
    bindings: value?.bindings ?? [],
    pendingBinds: value?.pendingBinds ?? [],
    pendingRequests: value?.pendingRequests ?? [],
    callbacks: value?.callbacks ?? [],
  };
}

export class PluginStateStore {
  private snapshot = cloneSnapshot();

  constructor(private readonly rootDir: string) {}

  get dir(): string {
    return path.join(this.rootDir, PLUGIN_ID);
  }

  get filePath(): string {
    return path.join(this.dir, "state.json");
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<StoreSnapshot>;
      this.snapshot = cloneSnapshot(parsed);
      this.pruneExpired();
      await this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.snapshot = cloneSnapshot();
      await this.save();
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(this.snapshot, null, 2)}\n`, "utf8");
  }

  pruneExpired(now = Date.now()): void {
    this.snapshot.pendingBinds = this.snapshot.pendingBinds.filter(
      (entry) => now - entry.updatedAt < CALLBACK_TTL_MS,
    );
    this.snapshot.pendingRequests = this.snapshot.pendingRequests.filter(
      (entry) => entry.state.expiresAt > now,
    );
    this.snapshot.callbacks = this.snapshot.callbacks.filter((entry) => entry.expiresAt > now);
  }

  listBindings(): StoredBinding[] {
    return [...this.snapshot.bindings];
  }

  getBinding(target: ConversationTarget): StoredBinding | null {
    const key = toConversationKey(target);
    return this.snapshot.bindings.find((entry) => toConversationKey(entry.conversation) === key) ?? null;
  }

  async upsertBinding(binding: StoredBinding): Promise<void> {
    const key = toConversationKey(binding.conversation);
    this.snapshot.bindings = this.snapshot.bindings.filter(
      (entry) => toConversationKey(entry.conversation) !== key,
    );
    this.snapshot.pendingBinds = this.snapshot.pendingBinds.filter(
      (entry) => toConversationKey(entry.conversation) !== key,
    );
    this.snapshot.bindings.push(binding);
    await this.save();
  }

  async removeBinding(target: ConversationTarget): Promise<void> {
    const key = toConversationKey(target);
    this.snapshot.bindings = this.snapshot.bindings.filter(
      (entry) => toConversationKey(entry.conversation) !== key,
    );
    this.snapshot.pendingRequests = this.snapshot.pendingRequests.filter(
      (entry) => toConversationKey(entry.conversation) !== key,
    );
    this.snapshot.callbacks = this.snapshot.callbacks.filter(
      (entry) => toConversationKey(entry.conversation) !== key,
    );
    await this.save();
  }

  getPendingRequestByConversation(target: ConversationTarget): StoredPendingRequest | null {
    const key = toConversationKey(target);
    return (
      this.snapshot.pendingRequests.find((entry) => toConversationKey(entry.conversation) === key) ??
      null
    );
  }

  getPendingBind(target: ConversationTarget): StoredPendingBind | null {
    const key = toConversationKey(target);
    return (
      this.snapshot.pendingBinds.find((entry) => toConversationKey(entry.conversation) === key) ??
      null
    );
  }

  async upsertPendingBind(entry: StoredPendingBind): Promise<void> {
    const key = toConversationKey(entry.conversation);
    this.snapshot.pendingBinds = this.snapshot.pendingBinds.filter(
      (current) => toConversationKey(current.conversation) !== key,
    );
    this.snapshot.pendingBinds.push(entry);
    await this.save();
  }

  async removePendingBind(target: ConversationTarget): Promise<void> {
    const key = toConversationKey(target);
    this.snapshot.pendingBinds = this.snapshot.pendingBinds.filter(
      (entry) => toConversationKey(entry.conversation) !== key,
    );
    await this.save();
  }

  getPendingRequestById(requestId: string): StoredPendingRequest | null {
    return this.snapshot.pendingRequests.find((entry) => entry.requestId === requestId) ?? null;
  }

  async upsertPendingRequest(entry: StoredPendingRequest): Promise<void> {
    this.snapshot.pendingRequests = this.snapshot.pendingRequests.filter(
      (current) => current.requestId !== entry.requestId,
    );
    this.snapshot.pendingRequests.push(entry);
    await this.save();
  }

  async removePendingRequest(requestId: string): Promise<void> {
    this.snapshot.pendingRequests = this.snapshot.pendingRequests.filter(
      (entry) => entry.requestId !== requestId,
    );
    this.snapshot.callbacks = this.snapshot.callbacks.filter((entry) => {
      if (entry.kind !== "pending-input" && entry.kind !== "pending-questionnaire") {
        return true;
      }
      return entry.requestId !== requestId;
    });
    await this.save();
  }

  createCallbackToken(): string {
    return crypto.randomBytes(CALLBACK_TOKEN_BYTES).toString("base64url");
  }

  async putCallback(callback: PutCallbackInput): Promise<CallbackAction> {
    const now = Date.now();
    const entry: CallbackAction =
      callback.kind === "resume-thread"
        ? {
            kind: "resume-thread",
            conversation: callback.conversation,
            threadId: callback.threadId,
            workspaceDir: callback.workspaceDir,
            syncTopic: callback.syncTopic,
            token: callback.token ?? this.createCallbackToken(),
            createdAt: now,
            expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
          }
        : callback.kind === "pending-input"
          ? {
              kind: "pending-input",
              conversation: callback.conversation,
              requestId: callback.requestId,
              actionIndex: callback.actionIndex,
              token: callback.token ?? this.createCallbackToken(),
              createdAt: now,
              expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
            }
          : callback.kind === "pending-questionnaire"
            ? {
                kind: "pending-questionnaire",
                conversation: callback.conversation,
                requestId: callback.requestId,
                questionIndex: callback.questionIndex,
                action: callback.action,
                optionIndex: callback.optionIndex,
                token: callback.token ?? this.createCallbackToken(),
                createdAt: now,
                expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
              }
          : callback.kind === "picker-view"
            ? {
              kind: "picker-view",
              conversation: callback.conversation,
              view: callback.view,
              token: callback.token ?? this.createCallbackToken(),
              createdAt: now,
              expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
              }
            : callback.kind === "run-prompt"
              ? {
                  kind: "run-prompt",
                  conversation: callback.conversation,
                  prompt: callback.prompt,
                  workspaceDir: callback.workspaceDir,
                  collaborationMode: callback.collaborationMode,
                  token: callback.token ?? this.createCallbackToken(),
                  createdAt: now,
                  expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                }
              : callback.kind === "set-model"
                ? {
                  kind: "set-model",
                  conversation: callback.conversation,
                  model: callback.model,
                  token: callback.token ?? this.createCallbackToken(),
                  createdAt: now,
                  expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                  }
                : {
                    kind: "reply-text",
                    conversation: callback.conversation,
                    text: callback.text,
                    token: callback.token ?? this.createCallbackToken(),
                    createdAt: now,
                    expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                };
    this.snapshot.callbacks = this.snapshot.callbacks.filter(
      (current) => current.token !== entry.token,
    );
    this.snapshot.callbacks.push(entry);
    await this.save();
    return entry;
  }

  getCallback(token: string): CallbackAction | null {
    return this.snapshot.callbacks.find((entry) => entry.token === token) ?? null;
  }

  async removeCallback(token: string): Promise<void> {
    this.snapshot.callbacks = this.snapshot.callbacks.filter((entry) => entry.token !== token);
    await this.save();
  }
}

export function buildPluginSessionKey(threadId: string): string {
  return `${PLUGIN_ID}:thread:${threadId.trim()}`;
}

export function buildConversationKey(target: ConversationTarget): string {
  return toConversationKey(target);
}
