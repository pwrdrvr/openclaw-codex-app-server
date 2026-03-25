import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { CALLBACK_TTL_MS, CALLBACK_TOKEN_BYTES, PLUGIN_ID, STORE_VERSION } from "./types.js";
import type {
  CallbackAction,
  CollaborationMode,
  ConversationTarget,
  ConversationPreferences,
  PermissionsMode,
  StoreSnapshot,
  StoredBinding,
  StoredPendingBind,
  StoredPendingRequest,
} from "./types.js";

type PutCallbackInput =
  | {
      kind: "start-new-thread";
      conversation: ConversationTarget;
      workspaceDir: string;
      syncTopic?: boolean;
      requestedModel?: string;
      requestedFast?: boolean;
      requestedYolo?: boolean;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "resume-thread";
      conversation: ConversationTarget;
      threadId: string;
      workspaceDir: string;
      syncTopic?: boolean;
      requestedModel?: string;
      requestedFast?: boolean;
      requestedYolo?: boolean;
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
      kind: "rename-thread";
      conversation: ConversationTarget;
      style: "thread-project" | "thread";
      syncTopic: boolean;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "toggle-fast";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "show-reasoning-picker";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "set-reasoning";
      conversation: ConversationTarget;
      reasoningEffort: string;
      returnToStatus?: boolean;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "toggle-permissions";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "compact-thread";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "stop-run";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "refresh-status";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "detach-thread";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "show-skills";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "show-mcp";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "run-skill";
      conversation: ConversationTarget;
      skillName: string;
      workspaceDir?: string;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "show-skill-help";
      conversation: ConversationTarget;
      skillName: string;
      description?: string;
      cwd?: string;
      enabled?: boolean;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "show-model-picker";
      conversation: ConversationTarget;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "set-model";
      conversation: ConversationTarget;
      model: string;
      returnToStatus?: boolean;
      statusMessage?: Extract<CallbackAction, { kind: "set-model" }>["statusMessage"];
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "reply-text";
      conversation: ConversationTarget;
      text: string;
      token?: string;
      ttlMs?: number;
    }
  | {
      kind: "cancel-picker";
      conversation: ConversationTarget;
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

function normalizePermissionsMode(value?: string | null): PermissionsMode | undefined {
  return value === "full-access" ? "full-access" : value === "default" ? "default" : undefined;
}

function inferPermissionsModeFromLegacyFields(params: {
  permissionsMode?: string | null;
  appServerProfile?: string | null;
  preferredApprovalPolicy?: string | null;
  preferredSandbox?: string | null;
}): PermissionsMode {
  const explicit =
    normalizePermissionsMode(params.permissionsMode) ??
    normalizePermissionsMode(params.appServerProfile);
  if (explicit) {
    return explicit;
  }
  const approval = params.preferredApprovalPolicy?.trim();
  const sandbox = params.preferredSandbox?.trim();
  if (approval === "never" && sandbox === "danger-full-access") {
    return "full-access";
  }
  return "default";
}

function normalizeConversationPreferences(
  value: (ConversationPreferences & {
    preferredApprovalPolicy?: string;
    preferredSandbox?: string;
  }) | undefined,
): ConversationPreferences | undefined {
  if (!value) {
    return undefined;
  }
  return {
    preferredModel: value.preferredModel,
    preferredReasoningEffort: value.preferredReasoningEffort,
    preferredServiceTier: value.preferredServiceTier,
    updatedAt: value.updatedAt,
  };
}

function normalizeSnapshot(value?: Partial<StoreSnapshot>): StoreSnapshot {
  const snapshot = cloneSnapshot(value);
  snapshot.version = STORE_VERSION;
  snapshot.bindings = snapshot.bindings.map((binding) => {
    const legacyPreferences = binding.preferences as
      | (ConversationPreferences & {
          preferredApprovalPolicy?: string;
          preferredSandbox?: string;
        })
      | undefined;
    return {
      ...binding,
      permissionsMode: inferPermissionsModeFromLegacyFields({
        permissionsMode: (binding as StoredBinding & { permissionsMode?: string }).permissionsMode,
        appServerProfile: (binding as StoredBinding & { appServerProfile?: string }).appServerProfile,
        preferredApprovalPolicy: legacyPreferences?.preferredApprovalPolicy,
        preferredSandbox: legacyPreferences?.preferredSandbox,
      }),
      pendingPermissionsMode:
        normalizePermissionsMode(
          (binding as StoredBinding & { pendingPermissionsMode?: string }).pendingPermissionsMode,
        ) ??
        normalizePermissionsMode(
          (binding as StoredBinding & { pendingAppServerProfile?: string }).pendingAppServerProfile,
        ),
      preferences: normalizeConversationPreferences(legacyPreferences),
    };
  });
  snapshot.pendingBinds = snapshot.pendingBinds.map((entry) => {
    const legacyPreferences = entry.preferences as
      | (ConversationPreferences & {
          preferredApprovalPolicy?: string;
          preferredSandbox?: string;
        })
      | undefined;
    return {
      ...entry,
      permissionsMode: inferPermissionsModeFromLegacyFields({
        permissionsMode: (entry as StoredPendingBind & { permissionsMode?: string }).permissionsMode,
        appServerProfile: (entry as StoredPendingBind & { appServerProfile?: string }).appServerProfile,
        preferredApprovalPolicy: legacyPreferences?.preferredApprovalPolicy,
        preferredSandbox: legacyPreferences?.preferredSandbox,
      }),
      preferences: normalizeConversationPreferences(legacyPreferences),
    };
  });
  return snapshot;
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
      this.snapshot = normalizeSnapshot(parsed);
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
    this.snapshot.pendingBinds = this.snapshot.pendingBinds.filter(
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
      callback.kind === "start-new-thread"
        ? {
            kind: "start-new-thread",
            conversation: callback.conversation,
            workspaceDir: callback.workspaceDir,
            syncTopic: callback.syncTopic,
            requestedModel: callback.requestedModel,
            requestedFast: callback.requestedFast,
            requestedYolo: callback.requestedYolo,
            token: callback.token ?? this.createCallbackToken(),
            createdAt: now,
            expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
          }
      : callback.kind === "resume-thread"
        ? {
            kind: "resume-thread",
            conversation: callback.conversation,
            threadId: callback.threadId,
            workspaceDir: callback.workspaceDir,
            syncTopic: callback.syncTopic,
            requestedModel: callback.requestedModel,
            requestedFast: callback.requestedFast,
            requestedYolo: callback.requestedYolo,
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
              : callback.kind === "rename-thread"
                ? {
                    kind: "rename-thread",
                    conversation: callback.conversation,
                    style: callback.style,
                    syncTopic: callback.syncTopic,
                    token: callback.token ?? this.createCallbackToken(),
                    createdAt: now,
                    expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                  }
              : callback.kind === "set-model"
                ? {
                    kind: "set-model",
                    conversation: callback.conversation,
                    model: callback.model,
                    returnToStatus: callback.returnToStatus,
                    statusMessage: callback.statusMessage,
                  token: callback.token ?? this.createCallbackToken(),
                  createdAt: now,
                  expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                  }
                : callback.kind === "toggle-fast"
                  ? {
                      kind: "toggle-fast",
                      conversation: callback.conversation,
                      token: callback.token ?? this.createCallbackToken(),
                      createdAt: now,
                      expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                    }
                : callback.kind === "show-reasoning-picker"
                  ? {
                      kind: "show-reasoning-picker",
                      conversation: callback.conversation,
                      token: callback.token ?? this.createCallbackToken(),
                      createdAt: now,
                      expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                    }
              : callback.kind === "set-reasoning"
                ? {
                    kind: "set-reasoning",
                    conversation: callback.conversation,
                    reasoningEffort: callback.reasoningEffort,
                    returnToStatus: callback.returnToStatus,
                    token: callback.token ?? this.createCallbackToken(),
                    createdAt: now,
                    expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                  }
                  : callback.kind === "toggle-permissions"
                    ? {
                        kind: "toggle-permissions",
                        conversation: callback.conversation,
                        token: callback.token ?? this.createCallbackToken(),
                        createdAt: now,
                        expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                      }
                    : callback.kind === "compact-thread"
                      ? {
                          kind: "compact-thread",
                          conversation: callback.conversation,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "stop-run"
                      ? {
                          kind: "stop-run",
                          conversation: callback.conversation,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "refresh-status"
                      ? {
                          kind: "refresh-status",
                          conversation: callback.conversation,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "detach-thread"
                      ? {
                          kind: "detach-thread",
                          conversation: callback.conversation,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "show-skills"
                      ? {
                          kind: "show-skills",
                          conversation: callback.conversation,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "show-mcp"
                      ? {
                          kind: "show-mcp",
                          conversation: callback.conversation,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "run-skill"
                      ? {
                          kind: "run-skill",
                          conversation: callback.conversation,
                          skillName: callback.skillName,
                          workspaceDir: callback.workspaceDir,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "show-skill-help"
                      ? {
                          kind: "show-skill-help",
                          conversation: callback.conversation,
                          skillName: callback.skillName,
                          description: callback.description,
                          cwd: callback.cwd,
                          enabled: callback.enabled,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                    : callback.kind === "show-model-picker"
                      ? {
                          kind: "show-model-picker",
                          conversation: callback.conversation,
                          token: callback.token ?? this.createCallbackToken(),
                          createdAt: now,
                          expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                        }
                : callback.kind === "reply-text"
                  ? {
                      kind: "reply-text",
                      conversation: callback.conversation,
                      text: callback.text,
                      token: callback.token ?? this.createCallbackToken(),
                      createdAt: now,
                      expiresAt: now + (callback.ttlMs ?? CALLBACK_TTL_MS),
                    }
                  : {
                      kind: "cancel-picker",
                      conversation: callback.conversation,
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
