import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type {
  PluginConversationBindingResolvedEvent,
  OpenClawPluginApi,
  OpenClawPluginService,
  PluginCommandContext,
  PluginInteractiveButtons,
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveTelegramHandlerContext,
  ReplyPayload,
  ConversationRef,
} from "openclaw/plugin-sdk";
import {
  buildDiscordComponentMessage,
  editDiscordComponentMessage,
  registerBuiltDiscordComponentMessage,
  type DiscordComponentMessageSpec,
  resolveDiscordAccount,
} from "openclaw/plugin-sdk/discord";
import { resolvePluginSettings, resolveWorkspaceDir } from "./config.js";
import { CodexAppServerClient, type ActiveCodexRun, isMissingThreadError } from "./client.js";
import {
  formatAccountSummary,
  formatBinding,
  formatBoundThreadSummary,
  formatCodexPlanAttachmentFallback,
  formatCodexPlanAttachmentSummary,
  formatCodexPlanInlineText,
  formatCodexReviewFindingMessage,
  formatCodexStatusText,
  formatExperimentalFeatures,
  formatMcpServers,
  formatModels,
  parseCodexReviewOutput,
  formatProjectPickerIntro,
  formatReviewCompletion,
  formatSkills,
  formatThreadButtonLabel,
  formatThreadPickerIntro,
  formatThreadState,
  formatTurnCompletion,
} from "./format.js";
import type { AccountSummary, CollaborationMode, TurnTerminalError } from "./types.js";
import {
  addQuestionnaireResponseNote,
  buildPendingQuestionnaireResponse,
  formatPendingQuestionnairePrompt,
  questionnaireCurrentQuestionHasAnswer,
  questionnaireIsComplete,
  requestToken,
} from "./pending-input.js";
import {
  buildConversationKey,
  buildPluginSessionKey,
  PluginStateStore,
} from "./state.js";
import {
  parseThreadSelectionArgs,
  selectThreadFromMatches,
} from "./thread-selection.js";
import {
  filterThreadsByProjectName,
  getProjectName,
  listProjects,
  paginateItems,
} from "./thread-picker.js";
import {
  INTERACTIVE_NAMESPACE,
  PLUGIN_ID,
  type CallbackAction,
  type ConversationTarget,
  type PendingInputState,
  type StoredBinding,
  type StoredPendingBind,
  type StoredPendingRequest,
} from "./types.js";

type ActiveRunRecord = {
  conversation: ConversationTarget;
  workspaceDir: string;
  mode: "default" | "plan" | "review";
  handle: ActiveCodexRun;
};

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const PLUGIN_VERSION = (() => {
  try {
    const packageJson = require("../package.json") as { version?: unknown };
    return typeof packageJson.version === "string" && packageJson.version.trim()
      ? packageJson.version.trim()
      : "unknown";
  } catch {
    return "unknown";
  }
})();

type PickerRender = {
  text: string;
  buttons: PluginInteractiveButtons | undefined;
};

type PickerResponders = {
  conversation: ConversationTarget;
  clear: () => Promise<void>;
  reply: (text: string) => Promise<void>;
  editPicker: (picker: PickerRender) => Promise<void>;
  requestConversationBinding?: (
    params?: { summary?: string },
  ) => Promise<
    | { status: "bound" }
    | { status: "pending"; reply: ReplyPayload }
    | { status: "error"; message: string }
  >;
};

const DELAYED_QUESTIONNAIRE_NOTE_THRESHOLD_MS = 15 * 60_000;

function formatElapsedDuration(elapsedMs: number): string {
  const totalMinutes = Math.max(1, Math.round(elapsedMs / 60_000));
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"} ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

type ScopedBindingApi = {
  requestConversationBinding?: (
    params?: { summary?: string },
  ) => Promise<
    | { status: "bound" }
    | { status: "pending"; reply: ReplyPayload }
    | { status: "error"; message: string }
  >;
  detachConversationBinding?: () => Promise<{ removed: boolean }>;
  getCurrentConversationBinding?: () => Promise<unknown>;
};

type HydratedBindingResult = {
  binding: StoredBinding;
  pendingBind?: StoredPendingBind;
};

type PlanDelivery = {
  summaryText: string;
  attachmentPath?: string;
  attachmentFallbackText?: string;
};

type DeliveredMessageRef =
  | {
      provider: "telegram";
      messageId: string;
      chatId: string;
    }
  | {
      provider: "discord";
      messageId: string;
      channelId: string;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asScopedBindingApi(value: object): ScopedBindingApi {
  return value as ScopedBindingApi;
}

function isTelegramChannel(channel: string): boolean {
  return channel.trim().toLowerCase() === "telegram";
}

function isDiscordChannel(channel: string): boolean {
  return channel.trim().toLowerCase() === "discord";
}

function buildPlainReply(text: string): ReplyPayload {
  return { text };
}

function normalizeTelegramChatId(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("telegram:")) {
    return trimmed.slice("telegram:".length);
  }
  return trimmed;
}

function normalizeDiscordConversationId(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("discord:channel:")) {
    return `channel:${trimmed.slice("discord:channel:".length)}`;
  }
  if (trimmed.startsWith("discord:group:")) {
    return `channel:${trimmed.slice("discord:group:".length)}`;
  }
  if (trimmed.startsWith("discord:user:")) {
    return `user:${trimmed.slice("discord:user:".length)}`;
  }
  if (trimmed.startsWith("discord:")) {
    return `user:${trimmed.slice("discord:".length)}`;
  }
  if (trimmed.startsWith("slash:")) {
    return undefined;
  }
  return trimmed;
}

function denormalizeDiscordConversationId(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("channel:")) {
    return trimmed.slice("channel:".length);
  }
  if (trimmed.startsWith("user:")) {
    return trimmed.slice("user:".length);
  }
  if (trimmed.startsWith("discord:channel:")) {
    return trimmed.slice("discord:channel:".length);
  }
  if (trimmed.startsWith("discord:user:")) {
    return trimmed.slice("discord:user:".length);
  }
  if (trimmed.startsWith("discord:")) {
    return trimmed.slice("discord:".length);
  }
  return trimmed;
}

function normalizeDiscordInteractiveConversationId(params: {
  conversationId?: string;
  guildId?: string;
}): string | undefined {
  const normalized = normalizeDiscordConversationId(params.conversationId);
  if (!normalized) {
    return undefined;
  }
  if (normalized.includes(":")) {
    return normalized;
  }
  return params.guildId ? `channel:${normalized}` : `user:${normalized}`;
}

function toConversationTargetFromCommand(ctx: PluginCommandContext): ConversationTarget | null {
  if (isTelegramChannel(ctx.channel)) {
    const chatId = normalizeTelegramChatId(ctx.to ?? ctx.from ?? ctx.senderId);
    if (!chatId) {
      return null;
    }
    return {
      channel: "telegram",
      accountId: ctx.accountId ?? "default",
      conversationId:
        typeof ctx.messageThreadId === "number" ? `${chatId}:topic:${ctx.messageThreadId}` : chatId,
      parentConversationId: typeof ctx.messageThreadId === "number" ? chatId : undefined,
      threadId: ctx.messageThreadId,
    };
  }
  if (isDiscordChannel(ctx.channel)) {
    // In brand-new Discord threads, the slash interaction may place the slash
    // user identity in ctx.from (e.g. "slash:user-id") while ctx.to holds the
    // real channel target. Prefer ctx.to when ctx.from is a slash identity so
    // /cas_resume resolves to the correct channel from the first attempt.
    const sourceId = ctx.from?.startsWith("slash:") ? ctx.to : (ctx.from ?? ctx.to);
    const conversationId = normalizeDiscordConversationId(sourceId);
    if (!conversationId) {
      return null;
    }
    return {
      channel: "discord",
      accountId: ctx.accountId ?? "default",
      conversationId,
    };
  }
  return null;
}

function toConversationTargetFromInbound(event: {
  channel: string;
  accountId?: string;
  conversationId?: string;
  parentConversationId?: string;
  threadId?: string | number;
  isGroup?: boolean;
  metadata?: Record<string, unknown>;
}): ConversationTarget | null {
  if (!event.accountId || !event.conversationId) {
    return null;
  }
  const channel = event.channel.trim().toLowerCase();
  const conversationIdRaw = event.conversationId?.trim();
  const conversationId =
    channel === "discord"
      ? (() => {
          const normalized = normalizeDiscordConversationId(conversationIdRaw);
          if (!normalized) {
            return undefined;
          }
          if (normalized.includes(":")) {
            return normalized;
          }
          const guildId =
            typeof event.metadata?.guildId === "string" ? event.metadata.guildId.trim() : "";
          const isChannel = Boolean(event.parentConversationId?.trim() || event.isGroup || guildId);
          return `${isChannel ? "channel" : "user"}:${normalized}`;
        })()
      : event.conversationId;
  const parentConversationId =
    channel === "discord"
      ? normalizeDiscordConversationId(event.parentConversationId)
      : event.parentConversationId;
  if (!conversationId) {
    return null;
  }
  return {
    channel,
    accountId: event.accountId,
    conversationId,
    parentConversationId,
    threadId:
      typeof event.threadId === "number"
        ? event.threadId
        : typeof event.threadId === "string"
          ? Number.isFinite(Number(event.threadId))
            ? Number(event.threadId)
            : undefined
          : undefined,
  };
}

function buildReplyWithButtons(text: string, buttons?: PluginInteractiveButtons): ReplyPayload {
  return buttons
    ? {
        text,
        channelData: {
          telegram: {
            buttons,
          },
        },
      }
    : { text };
}

function extractReplyButtons(reply: ReplyPayload): PluginInteractiveButtons | undefined {
  const telegramButtons = asRecord(reply.channelData?.telegram)?.buttons;
  if (Array.isArray(telegramButtons)) {
    return telegramButtons as PluginInteractiveButtons;
  }
  const interactive = asRecord((reply as ReplyPayload & { interactive?: unknown }).interactive);
  const blocks = Array.isArray(interactive?.blocks) ? interactive.blocks : [];
  const rows: PluginInteractiveButtons = [];
  for (const block of blocks) {
    const blockRecord = asRecord(block);
    if (blockRecord?.type !== "buttons") {
      continue;
    }
    const buttons = Array.isArray(blockRecord.buttons) ? blockRecord.buttons : [];
    const row = buttons
      .map((button) => {
        const buttonRecord = asRecord(button);
        if (!buttonRecord) {
          return null;
        }
        const text = typeof buttonRecord?.label === "string" ? buttonRecord.label.trim() : "";
        const callbackData =
          typeof buttonRecord?.value === "string" ? buttonRecord.value.trim() : "";
        if (!text || !callbackData) {
          return null;
        }
        const style: "danger" | "success" | "primary" | undefined =
          buttonRecord.style === "danger" ||
          buttonRecord.style === "success" ||
          buttonRecord.style === "primary"
            ? buttonRecord.style
            : undefined;
        return {
          text,
          callback_data: callbackData,
          style,
        };
      })
      .filter((button): button is NonNullable<typeof button> => Boolean(button));
    if (row.length > 0) {
      rows.push(row);
    }
  }
  return rows.length > 0 ? rows : undefined;
}

function parseFastAction(
  argsText: string,
): "toggle" | "on" | "off" | "status" | { error: string } {
  const normalized = argsText.trim().toLowerCase();
  if (!normalized) {
    return "toggle";
  }
  if (normalized === "on" || normalized === "off" || normalized === "status") {
    return normalized;
  }
  return { error: "Usage: /cas_fast [on|off|status]" };
}

function normalizeServiceTier(value: string | undefined | null): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function formatFastModeValue(value: string | undefined): string {
  const normalized = normalizeServiceTier(value);
  if (!normalized || normalized === "default" || normalized === "auto") {
    return "off";
  }
  if (normalized === "fast" || normalized === "priority") {
    return "on";
  }
  return normalized;
}

const PLAN_PROGRESS_DELAY_MS = 12_000;
const REVIEW_PROGRESS_DELAY_MS = 12_000;
const COMPACT_PROGRESS_DELAY_MS = 12_000;
const COMPACT_PROGRESS_INTERVAL_MS = 15_000;
const PLAN_INLINE_TEXT_LIMIT = 2600;

function isTransportClosedMessage(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.trim().toLowerCase();
  return (
    normalized.includes("stdio not connected") ||
    normalized.includes("websocket not connected") ||
    normalized.includes("stdio closed") ||
    normalized.includes("websocket closed") ||
    normalized.includes("socket closed") ||
    normalized.includes("broken pipe")
  );
}

function formatFailureText(kind: "plan" | "review" | "compact", error: unknown): string {
  if (isTransportClosedMessage(error)) {
    return `Codex ${kind} failed because the App Server connection closed. Please retry the command or rejoin the thread.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Codex ${kind} failed: ${message}`;
}

function formatInterruptedText(kind: "plan" | "review"): string {
  return `Codex ${kind} was interrupted before it finished.`;
}

function formatContextUsageText(usage: { totalTokens?: number; contextWindow?: number }): string | undefined {
  if (typeof usage.totalTokens !== "number") {
    return undefined;
  }
  const total = usage.totalTokens >= 1000 ? `${(usage.totalTokens / 1000).toFixed(usage.totalTokens >= 10000 ? 0 : 1)}k` : String(usage.totalTokens);
  const context =
    typeof usage.contextWindow === "number"
      ? usage.contextWindow >= 1000
        ? `${(usage.contextWindow / 1000).toFixed(usage.contextWindow >= 10000 ? 0 : 1)}k`
        : String(usage.contextWindow)
      : "?";
  const percent =
    typeof usage.contextWindow === "number" && usage.contextWindow > 0
      ? Math.round((usage.totalTokens / usage.contextWindow) * 100)
      : undefined;
  return `${total} / ${context} tokens used${typeof percent === "number" ? ` (${percent}% full)` : ""}`;
}

function normalizeOptionDashes(text: string): string {
  return text
    .replace(/(^|\s)[\u2010-\u2015\u2212](?=\S)/g, "$1--")
    .replace(/[\u2010-\u2015\u2212]/g, "-");
}

function parsePlanArgs(args: string): { mode: "off" } | { mode: "start"; prompt: string } {
  const normalized = normalizeOptionDashes(args).trim();
  if (!normalized) {
    return { mode: "start", prompt: "" };
  }
  if (normalized === "off" || normalized === "--off") {
    return { mode: "off" };
  }
  return { mode: "start", prompt: args.trim() };
}

function parseRenameArgs(args: string): { syncTopic: boolean; name: string } | null {
  const tokens = normalizeOptionDashes(args)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  let syncTopic = false;
  const nameParts: string[] = [];
  for (const token of tokens) {
    if (token === "--sync") {
      syncTopic = true;
      continue;
    }
    nameParts.push(token);
  }
  const name = nameParts.join(" ").trim();
  if (!syncTopic && !name) {
    return null;
  }
  return { syncTopic, name };
}

function buildResumeTopicName(params: { title?: string; projectKey?: string; threadId: string }): string | undefined {
  const threadName = params.title?.trim() || params.threadId.trim();
  if (!threadName) {
    return undefined;
  }
  const projectName = path.basename(params.projectKey?.replace(/[\\/]+$/, "").trim() || "");
  const normalizedThreadName = normalizeThreadTitleProjectSuffix(threadName, projectName);
  return projectName ? `${normalizedThreadName} (${projectName})` : normalizedThreadName;
}

function buildThreadOnlyName(params: { title?: string; projectKey?: string; threadId: string }): string | undefined {
  const threadName = params.title?.trim() || params.threadId.trim();
  const projectName = path.basename(params.projectKey?.replace(/[\\/]+$/, "").trim() || "");
  return normalizeThreadTitleProjectSuffix(threadName, projectName) || undefined;
}

function normalizeThreadTitleProjectSuffix(threadName: string, projectName?: string): string {
  let normalized = threadName.trim();
  if (!normalized) {
    return normalized;
  }
  // Collapse duplicated trailing parenthetical groups from repeated sync renames.
  normalized = normalized.replace(/(?: (\(([^()]+)\)))(?: \(\2\))+$/, " $1").trim();
  if (projectName) {
    const repeatedProjectSuffix = new RegExp(`(?: \\(${escapeRegExp(projectName)}\\))+$`);
    normalized = normalized.replace(repeatedProjectSuffix, "").trim();
  }
  return normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function truncateDiscordLabel(text: string, maxChars = 80): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function summarizeTextForLog(text: string, maxChars = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "<empty>";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export class CodexPluginController {
  private readonly settings;
  private readonly client;
  private readonly activeRuns = new Map<string, ActiveRunRecord>();
  private readonly threadChangesCache = new Map<string, Promise<boolean | undefined>>();
  private readonly store;
  private serviceWorkspaceDir?: string;
  private lastRuntimeConfig?: unknown;
  private started = false;

  constructor(private readonly api: OpenClawPluginApi) {
    this.settings = resolvePluginSettings(this.api.pluginConfig);
    this.client = new CodexAppServerClient(this.settings, this.api.logger);
    this.store = new PluginStateStore(this.api.runtime.state.resolveStateDir());
  }

  createService(): OpenClawPluginService {
    return {
      id: `${PLUGIN_ID}-service`,
      start: async (ctx) => {
        this.serviceWorkspaceDir = ctx.workspaceDir;
        await this.start();
      },
      stop: async () => {
        await this.stop();
      },
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.store.load();
    await this.client.logStartupProbe().catch(() => undefined);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    for (const active of this.activeRuns.values()) {
      await active.handle.interrupt().catch(() => undefined);
    }
    this.activeRuns.clear();
    await this.client.close().catch(() => undefined);
    this.started = false;
  }

  async handleConversationBindingResolved(
    event: PluginConversationBindingResolvedEvent,
  ): Promise<void> {
    await this.start();
    const conversation: ConversationTarget = {
      channel: event.request.conversation.channel,
      accountId: event.request.conversation.accountId,
      conversationId: event.request.conversation.conversationId,
      parentConversationId: event.request.conversation.parentConversationId,
      threadId: (() => {
        if (typeof event.request.conversation.threadId === "number") {
          return event.request.conversation.threadId;
        }
        if (typeof event.request.conversation.threadId !== "string") {
          return undefined;
        }
        const normalized = Number(event.request.conversation.threadId.trim());
        return Number.isFinite(normalized) ? normalized : undefined;
      })(),
    };
    const pending = this.store.getPendingBind(conversation);
    if (!pending) {
      this.api.logger.debug?.(
        `codex binding approved without pending local bind conversation=${conversation.conversationId}`,
      );
      return;
    }
    if (event.status === "denied") {
      await this.store.removePendingBind(conversation);
      return;
    }
    await this.bindConversation(conversation, {
      threadId: pending.threadId,
      workspaceDir: pending.workspaceDir,
      threadTitle: pending.threadTitle,
    });
    if (pending.syncTopic) {
      const syncedName = buildResumeTopicName({
        title: pending.threadTitle,
        projectKey: pending.workspaceDir,
        threadId: pending.threadId,
      });
      if (syncedName) {
        await this.renameConversationIfSupported(conversation, syncedName);
      }
    }
    if (pending.notifyBound) {
      await this.sendBoundConversationSummary(conversation);
    }
  }

  private formatConversationForLog(conversation: ConversationTarget): string {
    return [
      `channel=${conversation.channel}`,
      `account=${conversation.accountId ?? "<none>"}`,
      `conversation=${conversation.conversationId}`,
      `parent=${conversation.parentConversationId ?? "<none>"}`,
      `thread=${conversation.threadId == null ? "<none>" : String(conversation.threadId)}`,
    ].join(" ");
  }

  async handleInboundClaim(event: {
    content: string;
    channel: string;
    accountId?: string;
    conversationId?: string;
    parentConversationId?: string;
    threadId?: string | number;
    isGroup?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<{ handled: boolean }> {
    try {
      if (!this.settings.enabled) {
        return { handled: false };
      }
      await this.start();
      const conversation = toConversationTargetFromInbound(event);
      if (!conversation) {
        return { handled: false };
      }
      const activeKey = buildConversationKey(conversation);
      const active = this.activeRuns.get(activeKey);
      if (active) {
        if (active.mode === "plan") {
          this.api.logger.debug?.(
            `codex inbound claim restarting active plan run conversation=${conversation.conversationId}`,
          );
          this.activeRuns.delete(activeKey);
          await active.handle.interrupt().catch(() => undefined);
        } else {
        const pending = this.store.getPendingRequestByConversation(conversation);
        if (pending?.state.questionnaire && !event.content.trim().startsWith("/")) {
          const handled = await this.handlePendingQuestionnaireFreeformAnswer(
            conversation,
            pending,
            active.handle,
            event.content,
          );
          if (handled) {
            return { handled: true };
          }
        }
        try {
          const handled = await active.handle.queueMessage(event.content);
          if (handled) {
            return { handled: true };
          }
          this.api.logger.warn(
            `codex inbound claim could not enqueue message for active run; restarting thread conversation=${conversation.conversationId}`,
          );
        } catch (error) {
          this.api.logger.warn(
            `codex inbound claim active run enqueue failed; restarting thread conversation=${conversation.conversationId}: ${String(error)}`,
          );
        }
        this.activeRuns.delete(activeKey);
        await active.handle.interrupt().catch(() => undefined);
        }
      }
      const existingBinding = this.store.getBinding(conversation);
      const hydratedBinding = existingBinding ? null : await this.hydrateApprovedBinding(conversation);
      const resolvedBinding = existingBinding ?? hydratedBinding?.binding ?? null;
      this.api.logger.debug?.(
        `codex inbound claim channel=${conversation.channel} account=${conversation.accountId} conversation=${conversation.conversationId} parent=${conversation.parentConversationId ?? "<none>"} local=${resolvedBinding ? "yes" : "no"}`,
      );
      if (!resolvedBinding) {
        return { handled: false };
      }
      if (hydratedBinding?.pendingBind?.syncTopic) {
        const syncedName = buildResumeTopicName({
          title: hydratedBinding.pendingBind.threadTitle,
          projectKey: hydratedBinding.pendingBind.workspaceDir,
          threadId: hydratedBinding.pendingBind.threadId,
        });
        if (syncedName) {
          await this.renameConversationIfSupported(conversation, syncedName);
        }
      }
      this.api.logger.debug?.(
        `codex inbound claim starting turn ${this.formatConversationForLog(conversation)} workspace=${resolvedBinding.workspaceDir} thread=${resolvedBinding.threadId} prompt="${summarizeTextForLog(event.content)}"`,
      );
      await this.startTurn({
        conversation,
        binding: resolvedBinding,
        workspaceDir: resolvedBinding.workspaceDir,
        prompt: event.content,
        reason: "inbound",
      });
      this.api.logger.debug?.(
        `codex inbound claim turn accepted ${this.formatConversationForLog(conversation)}`,
      );
      return { handled: true };
    } catch (error) {
      const detail =
        error instanceof Error ? `${error.message}\n${error.stack ?? ""}`.trim() : String(error);
      this.api.logger.error(`codex inbound claim failed: ${detail}`);
      throw error;
    }
  }

  async handleTelegramInteractive(ctx: PluginInteractiveTelegramHandlerContext): Promise<void> {
    await this.start();
    const bindingApi = asScopedBindingApi(ctx);
    const callback = this.store.getCallback(ctx.callback.payload);
    if (!callback) {
      await ctx.respond.reply({ text: "That Codex action expired. Please retry the command." });
      return;
    }
    await this.dispatchCallbackAction(callback, {
      conversation: {
        channel: "telegram",
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        parentConversationId: ctx.parentConversationId,
        threadId: ctx.threadId,
      },
      clear: async () => {
        await ctx.respond.clearButtons().catch(() => undefined);
      },
      reply: async (text) => {
        await ctx.respond.reply({ text });
      },
      editPicker: async (picker) => {
        await ctx.respond.editMessage({
          text: picker.text,
          buttons: picker.buttons,
        });
      },
      requestConversationBinding: async (params) => {
        const requestConversationBinding = bindingApi.requestConversationBinding;
        if (!requestConversationBinding) {
          return { status: "error", message: "Conversation binding is unavailable." } as const;
        }
        const result = await requestConversationBinding(params);
        if (result.status === "pending") {
          const buttons = extractReplyButtons(result.reply);
          await ctx.respond.reply({
            text: result.reply.text ?? "Bind approval requested.",
            buttons,
          });
          return { status: "pending", reply: result.reply } as const;
        }
        return result;
      },
    });
  }

  async handleDiscordInteractive(ctx: PluginInteractiveDiscordHandlerContext): Promise<void> {
    await this.start();
    const bindingApi = asScopedBindingApi(ctx);
    const callback = this.store.getCallback(ctx.interaction.payload);
    if (!callback) {
      await ctx.respond.reply({ text: "That Codex action expired. Please retry the command.", ephemeral: true });
      return;
    }
    const callbackConversationId =
      callback.conversation.channel === "discord"
        ? normalizeDiscordConversationId(callback.conversation.conversationId)
        : undefined;
    const conversationId =
      callbackConversationId ??
      normalizeDiscordInteractiveConversationId({
        conversationId: ctx.conversationId,
        guildId: ctx.guildId,
      });
    if (!conversationId) {
      await ctx.respond.reply({
        text: "I couldn’t determine the Discord conversation for that action. Please retry the command.",
        ephemeral: true,
      });
      return;
    }
    const conversation: ConversationTarget = {
      channel: "discord",
      accountId: callback.conversation.accountId ?? ctx.accountId,
      conversationId,
      parentConversationId: callback.conversation.parentConversationId ?? ctx.parentConversationId,
    };
    let interactionSettled = false;
    try {
      if (callback.kind === "resume-thread") {
        await ctx.respond
          .acknowledge()
          .then(() => {
            interactionSettled = true;
          })
          .catch(() => undefined);
      }
      await this.dispatchCallbackAction(callback, {
        conversation,
        clear: async () => {
          const messageId = ctx.interaction.messageId?.trim();
          if ((callback.kind === "pending-input" || callback.kind === "pending-questionnaire") && messageId) {
            await ctx.respond
              .acknowledge()
              .then(() => {
                interactionSettled = true;
              })
              .catch(() => undefined);
            const completionText =
              callback.kind === "pending-questionnaire"
                ? "Recorded your answers and sent them to Codex."
                : "Sent to Codex.";
            await editDiscordComponentMessage(
              conversation.conversationId,
              messageId,
              {
                text: completionText,
              },
              {
                accountId: conversation.accountId,
              },
            ).catch((error) => {
              this.api.logger.warn(
                `codex discord ${callback.kind} clear failed conversation=${conversationId}: ${String(error)}`,
              );
            });
            return;
          }
          try {
            await ctx.respond.clearComponents();
            interactionSettled = true;
          } catch {
            await ctx.respond
              .acknowledge()
              .then(() => {
                interactionSettled = true;
              })
              .catch(() => undefined);
          }
        },
        reply: async (text) => {
          if (interactionSettled) {
            await ctx.respond.followUp({ text, ephemeral: true });
            return;
          }
          await ctx.respond.reply({ text, ephemeral: true });
          interactionSettled = true;
        },
        editPicker: async (picker) => {
          this.api.logger.debug(
            `codex discord picker refresh conversation=${conversationId} rows=${picker.buttons?.length ?? 0}`,
          );
          const messageId = ctx.interaction.messageId?.trim();
          const builtPicker = this.buildDiscordPickerMessage(picker);
          try {
            await ctx.respond.editMessage({
              components: builtPicker.components,
            });
            interactionSettled = true;
            if (messageId) {
              registerBuiltDiscordComponentMessage({
                buildResult: builtPicker,
                messageId,
              });
            }
            return;
          } catch (error) {
            const detail = String(error);
            this.api.logger.warn(
              `codex discord picker edit failed conversation=${conversationId}: ${detail}`,
            );
            if (messageId) {
              if (!detail.includes("already been acknowledged")) {
                await ctx.respond
                  .acknowledge()
                  .then(() => {
                    interactionSettled = true;
                  })
                  .catch(() => undefined);
              }
              await editDiscordComponentMessage(
                conversation.conversationId,
                messageId,
                this.buildDiscordPickerSpec(picker),
                {
                  accountId: conversation.accountId,
                },
              );
              return;
            }
          }
          await this.sendDiscordPicker(conversation, picker);
        },
        requestConversationBinding: async (params) => {
          const requestConversationBinding = bindingApi.requestConversationBinding;
          if (!requestConversationBinding) {
            return { status: "error", message: "Conversation binding is unavailable." } as const;
          }
          const result = await requestConversationBinding(params);
          if (result.status === "pending") {
            const buttons = extractReplyButtons(result.reply);
            await this.sendDiscordPicker(conversation, {
              text: result.reply.text ?? "Bind approval requested.",
              buttons,
            });
            const originalMessageId = ctx.interaction.messageId?.trim();
            if (callback.kind === "resume-thread" && originalMessageId) {
              await editDiscordComponentMessage(
                conversation.conversationId,
                originalMessageId,
                {
                  text: "Binding approval requested below.",
                },
                {
                  accountId: conversation.accountId,
                },
              ).catch(() => undefined);
            }
            return { status: "pending", reply: result.reply } as const;
          }
          return result;
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      this.api.logger.warn(`codex discord interactive failed conversation=${conversationId}: ${detail}`);
      const errorReply = {
        text: "Codex hit an error handling that action. Please retry the command.",
        ephemeral: true,
      } as const;
      const sendError = interactionSettled ? ctx.respond.followUp(errorReply) : ctx.respond.reply(errorReply);
      await sendError.catch(() => undefined);
    }
  }

  async handleCommand(commandName: string, ctx: PluginCommandContext): Promise<ReplyPayload> {
    await this.start();
    this.lastRuntimeConfig = ctx.config;
    const bindingApi = asScopedBindingApi(ctx);
    const conversation = toConversationTargetFromCommand(ctx);
    const currentBinding =
      conversation && bindingApi.getCurrentConversationBinding
        ? await bindingApi.getCurrentConversationBinding()
        : null;
    const pendingBind = conversation ? this.store.getPendingBind(conversation) : null;
    const existingBinding =
      conversation && currentBinding ? this.store.getBinding(conversation) : null;
    const hydratedBinding =
      conversation && currentBinding && !existingBinding
        ? await this.hydrateApprovedBinding(conversation)
        : null;
    const binding = existingBinding ?? hydratedBinding?.binding ?? null;
    const args = ctx.args?.trim() ?? "";
    if (isDiscordChannel(ctx.channel)) {
      this.api.logger.debug(
        `codex discord command /${commandName} from=${ctx.from ?? "<none>"} to=${ctx.to ?? "<none>"} conversation=${conversation?.conversationId ?? "<none>"}`,
      );
    }

    switch (commandName) {
      case "cas_resume":
        return await this.handleJoinCommand(
          conversation,
          binding,
          args,
          ctx.channel,
          ctx,
          pendingBind,
          hydratedBinding?.pendingBind,
        );
      case "cas_detach":
        if (!conversation) {
          return { text: "This command needs a Telegram or Discord conversation." };
        }
        const detachResult = await bindingApi.detachConversationBinding?.();
        await this.unbindConversation(conversation);
        return {
          text: detachResult?.removed
            ? "Detached this conversation from Codex."
            : "This conversation is not currently bound to Codex.",
        };
      case "cas_status":
        return await this.handleStatusCommand(
          conversation,
          binding,
          Boolean(currentBinding || binding),
        );
      case "cas_stop":
        return await this.handleStopCommand(conversation);
      case "cas_steer":
        return await this.handleSteerCommand(conversation, args);
      case "cas_plan":
        return await this.handlePlanCommand(conversation, binding, args);
      case "cas_review":
        return await this.handleReviewCommand(conversation, binding, args);
      case "cas_compact":
        return await this.handleCompactCommand(conversation, binding);
      case "cas_skills":
        return await this.handleSkillsCommand(conversation, binding, args);
      case "cas_experimental":
        return await this.handleExperimentalCommand(binding);
      case "cas_mcp":
        return await this.handleMcpCommand(binding, args);
      case "cas_fast":
        return await this.handleFastCommand(binding, args);
      case "cas_model":
        return await this.handleModelCommand(conversation, binding, args);
      case "cas_permissions":
        return await this.handlePermissionsCommand(binding);
      case "cas_init":
        return await this.handlePromptAlias(conversation, binding, args, "/init");
      case "cas_diff":
        return await this.handlePromptAlias(conversation, binding, args, "/diff");
      case "cas_rename":
        return await this.handleRenameCommand(conversation, binding, args);
      default:
        return { text: "Unknown Codex command." };
    }
  }

  private async handleListCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    filter: string,
    channel: string,
  ): Promise<ReplyPayload> {
    const parsed = parseThreadSelectionArgs(filter);
    if (!conversation) {
      return { text: "This command needs a Telegram or Discord conversation." };
    }
    const picker = parsed.listProjects
      ? await this.renderProjectPicker(conversation, binding, parsed, 0)
      : await this.renderThreadPicker(conversation, binding, parsed, 0);
    if (isDiscordChannel(channel) && picker.buttons) {
      try {
        await this.sendDiscordPicker(conversation, picker);
        return { text: "Sent a Codex thread picker to this Discord conversation." };
      } catch (error) {
        this.api.logger.warn(`codex discord picker send failed: ${String(error)}`);
        return { text: picker.text };
      }
    }
    return buildReplyWithButtons(picker.text, picker.buttons);
  }

  private async handleJoinCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    args: string,
    channel: string,
    ctx: PluginCommandContext,
    pendingBind?: StoredPendingBind | null,
    hydratedPendingBind?: StoredPendingBind,
  ): Promise<ReplyPayload> {
    const bindingApi = asScopedBindingApi(ctx);
    if (!conversation) {
      return { text: "This command needs a Telegram or Discord conversation." };
    }
    const parsed = parseThreadSelectionArgs(args);
    if (
      hydratedPendingBind?.notifyBound &&
      !parsed.listProjects &&
      !parsed.query
    ) {
      if (hydratedPendingBind.syncTopic) {
        const syncedName = buildResumeTopicName({
          title: hydratedPendingBind.threadTitle,
          projectKey: hydratedPendingBind.workspaceDir,
          threadId: hydratedPendingBind.threadId,
        });
        if (syncedName) {
          await this.renameConversationIfSupported(conversation, syncedName);
        }
      }
      await this.sendBoundConversationSummary(conversation);
      return {};
    }
    if (pendingBind && !binding && !parsed.listProjects && !parsed.query) {
      const syncTopic = parsed.syncTopic || Boolean(pendingBind.syncTopic);
      const bindResult = await this.requestConversationBinding(
        conversation,
        {
          threadId: pendingBind.threadId,
          workspaceDir: pendingBind.workspaceDir,
          threadTitle: pendingBind.threadTitle,
          syncTopic,
          notifyBound: true,
        },
        bindingApi.requestConversationBinding,
      );
      if (bindResult.status === "pending") {
        return bindResult.reply;
      }
      if (bindResult.status === "error") {
        return { text: bindResult.message };
      }
      if (syncTopic) {
        const syncedName = buildResumeTopicName({
          title: pendingBind.threadTitle,
          projectKey: pendingBind.workspaceDir,
          threadId: pendingBind.threadId,
        });
        if (syncedName) {
          await this.renameConversationIfSupported(conversation, syncedName);
        }
      }
      await this.sendBoundConversationSummary(conversation);
      return {};
    }
    if (parsed.listProjects || !parsed.query) {
      const passthroughArgs = [
        parsed.includeAll ? "--all" : "",
        parsed.listProjects ? "--projects" : "",
        parsed.syncTopic ? "--sync" : "",
        parsed.cwd ? `--cwd ${parsed.cwd}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      return await this.handleListCommand(conversation, binding, passthroughArgs, channel);
    }
    const workspaceDir = this.resolveThreadWorkspaceDir(parsed, binding, false);
    const selection = await this.resolveSingleThread(
      binding?.sessionKey,
      workspaceDir,
      parsed.query,
    );
    if (selection.kind === "none") {
      return { text: `No Codex thread matched "${parsed.query}".` };
    }
    if (selection.kind === "ambiguous") {
      const picker = await this.renderThreadPicker(conversation, binding, parsed, 0);
      if (isDiscordChannel(channel) && picker.buttons) {
        try {
          await this.sendDiscordPicker(conversation, picker);
          return {
            text: `Multiple Codex threads matched "${parsed.query}". Sent a picker to this Discord conversation.`,
          };
        } catch (error) {
          this.api.logger.warn(`codex discord picker send failed: ${String(error)}`);
          return { text: picker.text };
        }
      }
      return buildReplyWithButtons(picker.text, picker.buttons);
    }
    const bindResult = await this.requestConversationBinding(conversation, {
      threadId: selection.thread.threadId,
      workspaceDir:
        selection.thread.projectKey ||
        workspaceDir ||
        resolveWorkspaceDir({
          bindingWorkspaceDir: binding?.workspaceDir,
          configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
          serviceWorkspaceDir: this.serviceWorkspaceDir,
      }),
      threadTitle: selection.thread.title,
      syncTopic: parsed.syncTopic,
      notifyBound: true,
    }, bindingApi.requestConversationBinding);
    if (bindResult.status === "pending") {
      return bindResult.reply;
    }
    if (bindResult.status === "error") {
      return { text: bindResult.message };
    }
    if (parsed.syncTopic) {
      const syncedName = buildResumeTopicName({
        title: selection.thread.title,
        projectKey: selection.thread.projectKey,
        threadId: selection.thread.threadId,
      });
      if (syncedName) {
        await this.renameConversationIfSupported(conversation, syncedName);
      }
    }
    await this.sendBoundConversationSummary(conversation);
    return {};
  }

  private async handleStatusCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    bindingActive: boolean,
  ): Promise<ReplyPayload> {
    return {
      text: await this.buildStatusText(conversation, binding, bindingActive),
    };
  }

  private async handleStopCommand(conversation: ConversationTarget | null): Promise<ReplyPayload> {
    if (!conversation) {
      return { text: "This command needs a Telegram or Discord conversation." };
    }
    const active = this.activeRuns.get(buildConversationKey(conversation));
    if (!active) {
      return { text: "No active Codex run to stop." };
    }
    await active.handle.interrupt();
    return { text: "Stopping Codex now." };
  }

  private async handleSteerCommand(
    conversation: ConversationTarget | null,
    args: string,
  ): Promise<ReplyPayload> {
    if (!conversation) {
      return { text: "This command needs a Telegram or Discord conversation." };
    }
    const prompt = args.trim();
    if (!prompt) {
      return { text: "Usage: /cas_steer <message>" };
    }
    const active = this.activeRuns.get(buildConversationKey(conversation));
    if (!active) {
      return { text: "No active Codex run to steer." };
    }
    const handled = await active.handle.queueMessage(prompt);
    return { text: handled ? "Sent steer message to Codex." : "Codex is not accepting steer input right now." };
  }

  private async handlePlanCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    args: string,
  ): Promise<ReplyPayload> {
    if (!conversation) {
      return { text: "This command needs a Telegram or Discord conversation." };
    }
    const parsed = parsePlanArgs(args);
    if (parsed.mode === "off") {
      const key = buildConversationKey(conversation);
      const active = this.activeRuns.get(key);
      this.api.logger.debug?.(
        `codex plan off requested ${this.formatConversationForLog(conversation)} active=${active?.mode ?? "none"} boundThread=${binding?.threadId ?? "<none>"}`,
      );
      if (active?.mode === "plan") {
        this.activeRuns.delete(key);
        await active.handle.interrupt().catch(() => undefined);
      }
      return { text: "Exited Codex plan mode. Future turns will use default coding mode." };
    }
    const prompt = parsed.prompt.trim();
    if (!prompt) {
      return { text: "Usage: /cas_plan <goal> or /cas_plan off" };
    }
    const workspaceDir = resolveWorkspaceDir({
      bindingWorkspaceDir: binding?.workspaceDir,
      configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
      serviceWorkspaceDir: this.serviceWorkspaceDir,
    });
    await this.startPlan({
      conversation,
      binding,
      workspaceDir,
      prompt,
      announceStart: false,
    });
    return buildPlainReply(
      "Starting Codex plan mode. I’ll relay the questions and final plan as they arrive.",
    );
  }

  private async handleReviewCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    args: string,
  ): Promise<ReplyPayload> {
    if (!conversation || !binding) {
      return { text: "Bind this conversation to a Codex thread before running review." };
    }
    const workspaceDir = binding.workspaceDir;
    await this.startReview({
      conversation,
      binding,
      workspaceDir,
      target: args.trim()
        ? { type: "custom", instructions: args.trim() }
        : { type: "uncommittedChanges" },
      announceStart: false,
    });
    return buildPlainReply(
      args.trim()
        ? "Starting Codex review with your custom focus. I’ll send the findings when the review finishes."
        : "Starting Codex review of the current changes. I’ll send the findings when the review finishes.",
    );
  }

  private async handleCompactCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
  ): Promise<ReplyPayload> {
    if (!conversation || !binding) {
      return { text: "Bind this conversation to a Codex thread before compacting it." };
    }
    void this.startCompact({
      conversation,
      binding,
    });
    return buildPlainReply(this.buildCompactStartText(binding.contextUsage));
  }

  private async startCompact(params: {
    conversation: ConversationTarget;
    binding: StoredBinding;
  }): Promise<void> {
    const { conversation, binding } = params;
    const typing = await this.startTypingLease(conversation);
    let startingUsage = binding.contextUsage;
    let latestUsage = startingUsage;
    let lastEmittedUsageText = binding.contextUsage ? formatContextUsageText(binding.contextUsage) : undefined;
    try {
      let keepaliveInterval: NodeJS.Timeout | undefined;
      const progressTimer = setTimeout(() => {
        void (async () => {
          const usageText =
            latestUsage ? formatContextUsageText(latestUsage) : undefined;
          if (usageText && usageText !== lastEmittedUsageText) {
            lastEmittedUsageText = usageText;
          }
          await this.sendText(
            conversation,
            usageText
              ? `Codex is still compacting.\nLatest context usage: ${usageText}`
              : "Codex is still compacting.",
          );
        })();
        keepaliveInterval = setInterval(() => {
          void this.sendText(conversation, "Codex is still compacting.");
        }, COMPACT_PROGRESS_INTERVAL_MS);
      }, COMPACT_PROGRESS_DELAY_MS);
      const result = await this.client.compactThread({
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
        onProgress: async (progress) => {
          if (progress.usage) {
            latestUsage = progress.usage;
            startingUsage ??= progress.usage;
          }
          if (progress.phase === "started") {
            await this.sendText(conversation, "Codex compaction started.");
          }
        },
      });
      clearTimeout(progressTimer);
      if (keepaliveInterval) {
        clearInterval(keepaliveInterval);
      }
      await this.sendText(
        conversation,
        [
          "Codex compaction completed.",
          startingUsage ? `Starting context usage: ${formatContextUsageText(startingUsage)}` : "",
          result.usage ? `Final context usage: ${formatContextUsageText(result.usage)}` : "",
          result.usage?.remainingPercent != null
            ? `Context remaining: ${result.usage.remainingPercent}%.`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      if (result.usage) {
        await this.store.upsertBinding({
          ...binding,
          contextUsage: result.usage,
          updatedAt: Date.now(),
        });
      }
      return;
    } catch (error) {
      await this.sendText(conversation, formatFailureText("compact", error));
    } finally {
      typing?.stop();
    }
  }

  private async handleSkillsCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    args: string,
  ): Promise<ReplyPayload> {
    const workspaceDir = resolveWorkspaceDir({
      bindingWorkspaceDir: binding?.workspaceDir,
      configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
      serviceWorkspaceDir: this.serviceWorkspaceDir,
    });
    const skills = await this.client.listSkills({
      sessionKey: binding?.sessionKey,
      workspaceDir,
    });
    const text = formatSkills({
      workspaceDir,
      skills,
      filter: args,
    });
    if (!conversation) {
      return { text };
    }
    const filtered = args.trim()
      ? skills.filter((skill) => {
          const haystack = [skill.name, skill.description, skill.cwd].filter(Boolean).join("\n");
          return haystack.toLowerCase().includes(args.trim().toLowerCase());
        })
      : skills;
    const buttons: PluginInteractiveButtons = [];
    for (const skill of filtered.slice(0, 8)) {
      const callback = await this.store.putCallback({
        kind: "run-prompt",
        conversation,
        prompt: `$${skill.name}`,
        workspaceDir: binding?.workspaceDir || workspaceDir,
      });
      buttons.push([
        {
          text: `$${skill.name}`,
          callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
        },
      ]);
    }
    if (conversation && isDiscordChannel(conversation.channel) && buttons.length > 0) {
      try {
        await this.sendReply(conversation, {
          text,
          buttons,
        });
        return { text: "Sent Codex skills to this Discord conversation." };
      } catch (error) {
        this.api.logger.warn(`codex discord skills send failed: ${String(error)}`);
        return { text };
      }
    }
    return buildReplyWithButtons(text, buttons.length > 0 ? buttons : undefined);
  }

  private async handleExperimentalCommand(binding: StoredBinding | null): Promise<ReplyPayload> {
    const features = await this.client.listExperimentalFeatures({
      sessionKey: binding?.sessionKey,
    });
    return { text: formatExperimentalFeatures(features) };
  }

  private async handleMcpCommand(binding: StoredBinding | null, args: string): Promise<ReplyPayload> {
    const servers = await this.client.listMcpServers({
      sessionKey: binding?.sessionKey,
    });
    return {
      text: formatMcpServers({
        servers,
        filter: args,
      }),
    };
  }

  private async handleFastCommand(binding: StoredBinding | null, args: string): Promise<ReplyPayload> {
    if (!binding) {
      return { text: "Bind this conversation to a Codex thread before toggling fast mode." };
    }
    const action = parseFastAction(args);
    if (typeof action === "object") {
      return { text: action.error };
    }
    const state = await this.client.readThreadState({
      sessionKey: binding.sessionKey,
      threadId: binding.threadId,
    });
    const currentTier = normalizeServiceTier(state.serviceTier);
    if (action === "status") {
      return { text: `Fast mode is ${formatFastModeValue(currentTier)}.` };
    }
    const nextTier =
      action === "toggle" ? (currentTier === "fast" || currentTier === "priority" ? null : "fast")
      : action === "on" ? "fast"
      : null;
    const updated = await this.client.setThreadServiceTier({
      sessionKey: binding.sessionKey,
      threadId: binding.threadId,
      serviceTier: nextTier,
    });
    return {
      text: `Fast mode set to ${formatFastModeValue(updated.serviceTier)}.`,
    };
  }

  private async handleModelCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    args: string,
  ): Promise<ReplyPayload> {
    if (!binding) {
      const models = await this.client.listModels({});
      return { text: formatModels(models) };
    }
    if (!args.trim()) {
      const [models, state] = await Promise.all([
        this.client.listModels({ sessionKey: binding.sessionKey }),
        this.client.readThreadState({
          sessionKey: binding.sessionKey,
          threadId: binding.threadId,
        }),
      ]);
      if (!conversation) {
        return { text: formatModels(models, state) };
      }
      const buttons: PluginInteractiveButtons = [];
      for (const model of models.slice(0, 8)) {
        const callback = await this.store.putCallback({
          kind: "set-model",
          conversation,
          model: model.id,
        });
        buttons.push([
          {
            text: `${model.id}${model.current || model.id === state.model ? " (current)" : ""}`,
            callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
          },
        ]);
      }
      if (isDiscordChannel(conversation.channel) && buttons.length > 0) {
        try {
          await this.sendReply(conversation, {
            text: formatModels(models, state),
            buttons,
          });
          return { text: "Sent Codex model choices to this Discord conversation." };
        } catch (error) {
          this.api.logger.warn(`codex discord model picker send failed: ${String(error)}`);
          return { text: formatModels(models, state) };
        }
      }
      return buildReplyWithButtons(formatModels(models, state), buttons);
    }
    const state = await this.client.setThreadModel({
      sessionKey: binding.sessionKey,
      threadId: binding.threadId,
      model: args.trim(),
      workspaceDir: binding.workspaceDir,
    });
    return { text: `Codex model set to ${state.model || args.trim()}.` };
  }

  private async handlePermissionsCommand(binding: StoredBinding | null): Promise<ReplyPayload> {
    if (!binding) {
      const [account, limits] = await Promise.all([
        this.client.readAccount({}),
        this.client.readRateLimits({}),
      ]);
      return { text: formatAccountSummary(account, limits) };
    }
    const [state, account, limits] = await Promise.all([
      this.client.readThreadState({
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
      }),
      this.client.readAccount({ sessionKey: binding.sessionKey }),
      this.client.readRateLimits({ sessionKey: binding.sessionKey }),
    ]);
    return {
      text:
        `${formatThreadState(state, binding)}\n\n${formatAccountSummary(account, limits)}`.trim(),
    };
  }

  private async handlePromptAlias(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    args: string,
    alias: string,
  ): Promise<ReplyPayload> {
    if (!conversation) {
      return { text: "This command needs a Telegram or Discord conversation." };
    }
    const workspaceDir = resolveWorkspaceDir({
      bindingWorkspaceDir: binding?.workspaceDir,
      configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
      serviceWorkspaceDir: this.serviceWorkspaceDir,
    });
    await this.startTurn({
      conversation,
      binding,
      workspaceDir,
      prompt: `${alias}${args.trim() ? ` ${args.trim()}` : ""}`,
      reason: "command",
    });
    return { text: `Sent ${alias} to Codex.` };
  }

  private async handleRenameCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    args: string,
  ): Promise<ReplyPayload> {
    if (!conversation || !binding) {
      return { text: "Bind this conversation to a Codex thread before renaming it." };
    }
    const parsed = parseRenameArgs(args);
    if (!parsed?.name) {
      const picker = await this.buildRenameStylePicker(conversation, binding, Boolean(parsed?.syncTopic));
      return buildReplyWithButtons(picker.text, picker.buttons);
    }
    await this.client.setThreadName({
      sessionKey: binding.sessionKey,
      threadId: binding.threadId,
      name: parsed.name,
    });
    if (parsed.syncTopic) {
      await this.renameConversationIfSupported(conversation, parsed.name);
    }
    await this.store.upsertBinding({
      ...binding,
      threadTitle: parsed.name,
      updatedAt: Date.now(),
    });
    return { text: `Renamed the Codex thread to "${parsed.name}".` };
  }

  private async buildRenameStylePicker(
    conversation: ConversationTarget,
    binding: StoredBinding,
    syncTopic: boolean,
  ): Promise<{ text: string; buttons: PluginInteractiveButtons }> {
    const threadState = await this.client
      .readThreadState({
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
      })
      .catch(() => undefined);
    const threadName = buildThreadOnlyName({
      title: threadState?.threadName || binding.threadTitle,
      projectKey: threadState?.cwd?.trim() || binding.workspaceDir,
      threadId: binding.threadId,
    });
    const threadProjectName = buildResumeTopicName({
      title: threadState?.threadName || binding.threadTitle,
      projectKey: threadState?.cwd?.trim() || binding.workspaceDir,
      threadId: binding.threadId,
    });
    const callbacks: Array<{ text: string; style: "thread-project" | "thread" }> = [];
    if (threadProjectName) {
      callbacks.push({
        text: threadProjectName,
        style: "thread-project",
      });
    }
    if (threadName && threadName !== threadProjectName) {
      callbacks.push({
        text: threadName,
        style: "thread",
      });
    }
    const buttons: PluginInteractiveButtons = [];
    for (const entry of callbacks) {
      const callback = await this.store.putCallback({
        kind: "rename-thread",
        conversation,
        style: entry.style,
        syncTopic,
      });
      buttons.push([
        {
          text: entry.text,
          callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
        },
      ]);
    }
    if (buttons.length === 0) {
      return { text: "Usage: /cas_rename [--sync] <new name>", buttons: [] };
    }
    return {
      text: syncTopic
        ? "Choose a name style for the Codex thread and this conversation."
        : "Choose a name style for the Codex thread.",
      buttons,
    };
  }

  private async applyRenameStyle(
    conversation: ConversationTarget,
    binding: StoredBinding,
    style: "thread-project" | "thread",
    syncTopic: boolean,
  ): Promise<string> {
    const threadState = await this.client
      .readThreadState({
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
      })
      .catch(() => undefined);
    const name =
      style === "thread-project"
        ? buildResumeTopicName({
            title: threadState?.threadName || binding.threadTitle,
            projectKey: threadState?.cwd?.trim() || binding.workspaceDir,
            threadId: binding.threadId,
          })
        : buildThreadOnlyName({
            title: threadState?.threadName || binding.threadTitle,
            projectKey: threadState?.cwd?.trim() || binding.workspaceDir,
            threadId: binding.threadId,
          });
    if (!name) {
      throw new Error("Unable to derive a Codex thread name.");
    }
    await this.client.setThreadName({
      sessionKey: binding.sessionKey,
      threadId: binding.threadId,
      name,
    });
    if (syncTopic) {
      await this.renameConversationIfSupported(conversation, name);
    }
    await this.store.upsertBinding({
      ...binding,
      threadTitle: name,
      updatedAt: Date.now(),
    });
    return name;
  }

  private async startTurn(params: {
    conversation: ConversationTarget;
    binding: StoredBinding | null;
    workspaceDir: string;
    prompt: string;
    reason: "command" | "inbound" | "plan";
    collaborationMode?: CollaborationMode;
  }): Promise<void> {
    const key = buildConversationKey(params.conversation);
    const existing = this.activeRuns.get(key);
    this.api.logger.debug?.(
      `codex turn request reason=${params.reason} ${this.formatConversationForLog(params.conversation)} workspace=${params.workspaceDir} existing=${existing ? existing.mode : "none"} prompt="${summarizeTextForLog(params.prompt)}"`,
    );
    if (existing) {
      if (existing.mode === "plan" && (params.collaborationMode?.mode ?? "default") !== "plan") {
        this.api.logger.debug?.(
          `codex turn request replacing active plan run ${this.formatConversationForLog(params.conversation)}`,
        );
        this.activeRuns.delete(key);
        await existing.handle.interrupt().catch(() => undefined);
      } else {
        try {
          const handled = await existing.handle.queueMessage(params.prompt);
          if (handled) {
            this.api.logger.debug?.(
              `codex turn request queued onto active run ${this.formatConversationForLog(params.conversation)} mode=${existing.mode}`,
            );
            return;
          }
          this.api.logger.warn(
            `codex turn request reached an active run but was not accepted; restarting ${this.formatConversationForLog(params.conversation)} mode=${existing.mode}`,
          );
        } catch (error) {
          this.api.logger.warn(
            `codex turn request active run enqueue failed; restarting ${this.formatConversationForLog(params.conversation)} mode=${existing.mode}: ${String(error)}`,
          );
        }
        this.activeRuns.delete(key);
        await existing.handle.interrupt().catch(() => undefined);
      }
    }
    const typing = await this.startTypingLease(params.conversation);
    this.api.logger.debug?.(
      `codex turn starting app-server run ${this.formatConversationForLog(params.conversation)} typing=${typing ? "yes" : "no"} session=${params.binding?.sessionKey ?? "<none>"} existingThread=${params.binding?.threadId ?? "<none>"} mode=${params.collaborationMode?.mode ?? "default"}`,
    );
    const run = this.client.startTurn({
      sessionKey: params.binding?.sessionKey,
      workspaceDir: params.workspaceDir,
      prompt: params.prompt,
      runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      existingThreadId: params.binding?.threadId,
      model: this.settings.defaultModel,
      collaborationMode: params.collaborationMode,
      onPendingInput: async (state) => {
        this.api.logger.debug?.(
          `codex turn pending input ${state ? "received" : "cleared"} ${this.formatConversationForLog(params.conversation)} questionnaire=${state?.questionnaire ? "yes" : "no"}`,
        );
        await this.handlePendingInputState(params.conversation, params.workspaceDir, state, run);
      },
      onFileEdits: async (text) => {
        await this.sendText(params.conversation, text);
      },
      onInterrupted: async () => {
        this.api.logger.debug?.(
          `codex turn interrupted ${this.formatConversationForLog(params.conversation)}`,
        );
        await this.sendText(params.conversation, "Codex stopped.");
      },
    });
    this.api.logger.debug?.(
      `codex turn run handle created ${this.formatConversationForLog(params.conversation)}`,
    );
    this.activeRuns.set(key, {
      conversation: params.conversation,
      workspaceDir: params.workspaceDir,
      mode: params.collaborationMode?.mode === "plan" ? "plan" : "default",
      handle: run,
    });
    void (run.result as Promise<import("./types.js").TurnResult>)
      .then(async (result) => {
        const threadId = result.threadId || run.getThreadId();
        if (threadId) {
          const state = await this.client
            .readThreadState({
              sessionKey: params.binding?.sessionKey,
              threadId,
            })
            .catch(() => null);
          const nextBinding = await this.bindConversation(params.conversation, {
            threadId,
            workspaceDir: state?.cwd || params.workspaceDir,
            threadTitle: state?.threadName,
          });
          if (state?.threadName && nextBinding.threadTitle !== state.threadName) {
            await this.store.upsertBinding({
              ...nextBinding,
              threadTitle: state.threadName,
              contextUsage: result.usage ?? nextBinding.contextUsage,
              updatedAt: Date.now(),
            });
          } else if (result.usage) {
            await this.store.upsertBinding({
              ...nextBinding,
              contextUsage: result.usage,
              updatedAt: Date.now(),
            });
          }
        }
        this.api.logger.debug?.(
          `codex turn completed ${this.formatConversationForLog(params.conversation)} thread=${threadId ?? "<none>"} aborted=${result.aborted ? "yes" : "no"} stoppedReason=${result.stoppedReason ?? "none"} terminalStatus=${result.terminalStatus ?? "none"} text=${result.text ? "yes" : "no"} plan=${result.planArtifact ? "yes" : "no"}`,
        );
        const completionText =
          result.terminalStatus === "failed"
            ? await this.describeTurnFailure({
                sessionKey: params.binding?.sessionKey,
                error: result.terminalError?.message ?? "turn failed",
                terminalError: result.terminalError,
              })
            : !result.aborted &&
                result.stoppedReason !== "approval" &&
                !result.text?.trim() &&
                !result.planArtifact?.markdown
              ? await this.describeEmptyTurnCompletion()
              : formatTurnCompletion(result);
        await this.sendText(params.conversation, completionText);
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.api.logger.warn(
          `codex turn failed ${this.formatConversationForLog(params.conversation)}: ${message}`,
        );
        await this.sendText(
          params.conversation,
          await this.describeTurnFailure({
            sessionKey: params.binding?.sessionKey,
            error,
          }),
        );
      })
      .finally(async () => {
        typing?.stop();
        this.activeRuns.delete(key);
        const pending = this.store.getPendingRequestByConversation(params.conversation);
        if (pending) {
          await this.store.removePendingRequest(pending.requestId);
        }
        this.api.logger.debug?.(
          `codex turn cleaned up ${this.formatConversationForLog(params.conversation)}`,
        );
      });
  }

  private async describeTurnFailure(params: {
    sessionKey?: string;
    error: unknown;
    terminalError?: TurnTerminalError;
  }): Promise<string> {
    const message =
      params.terminalError?.message?.trim() ||
      (params.error instanceof Error ? params.error.message : String(params.error));
    if (this.looksLikeExplicitCodexAuthFailure(params.terminalError, message)) {
      const account = await this.client
        .readAccount({
          sessionKey: params.sessionKey,
          refreshToken: true,
        })
        .catch(() => undefined);
      this.api.logger.warn?.(
        `codex auth failure from terminal turn error session=${params.sessionKey ?? "<none>"}: ${message}`,
      );
      return this.formatCodexAuthFailureMessage(account);
    }
    if (this.looksLikeCodexAuthFailure(message)) {
      const account = await this.client
        .readAccount({
          sessionKey: params.sessionKey,
          refreshToken: true,
        })
        .catch(() => undefined);
      this.api.logger.warn?.(
        `codex auth failure inferred from turn error session=${params.sessionKey ?? "<none>"}: ${message}`,
      );
      return this.formatCodexAuthFailureMessage(account);
    }
    return `Codex failed: ${message}`;
  }

  private async describeEmptyTurnCompletion(): Promise<string> {
    return "Codex completed without a text reply.";
  }

  private formatCodexAuthFailureMessage(account: AccountSummary | undefined): string {
    if (account?.type === "apiKey" && account.requiresOpenaiAuth !== true) {
      return "Codex authentication failed on this machine. Check the configured API key and try again.";
    }
    return "Codex authentication failed on this machine. Run `codex logout` and `codex login`, then try again.";
  }

  private looksLikeCodexAuthFailure(message: string): boolean {
    const normalized = message.trim().toLowerCase();
    return [
      "unauthorized",
      "401",
      "oauth",
      "invalid token",
      "invalid oauth",
      "invalid_grant",
      "refresh token expired",
      "requires openai auth",
      "requiresopenaiauth",
      "not signed in",
      "login required",
    ].some((pattern) => normalized.includes(pattern));
  }

  private looksLikeExplicitCodexAuthFailure(
    terminalError: TurnTerminalError | undefined,
    message: string,
  ): boolean {
    if (terminalError?.httpStatusCode === 401) {
      return true;
    }
    const codexErrorInfo = terminalError?.codexErrorInfo?.trim().toLowerCase() ?? "";
    if (codexErrorInfo.includes("unauthorized")) {
      return true;
    }
    return this.looksLikeCodexAuthFailure(message);
  }

  private async startPlan(params: {
    conversation: ConversationTarget;
    binding: StoredBinding | null;
    workspaceDir: string;
    prompt: string;
    announceStart?: boolean;
  }): Promise<void> {
    const key = buildConversationKey(params.conversation);
    const existing = this.activeRuns.get(key);
    if (existing) {
      await existing.handle.interrupt();
    }
    if (params.announceStart !== false) {
      await this.sendText(
        params.conversation,
        "Starting Codex plan mode. I’ll relay the questions and final plan as they arrive.",
      );
    }
    const typing = await this.startTypingLease(params.conversation);
    const threadState =
      params.binding?.threadId
        ? await this.client
            .readThreadState({
              sessionKey: params.binding.sessionKey,
              threadId: params.binding.threadId,
            })
            .catch(() => null)
        : null;
    let keepaliveSent = false;
    let progressTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      void (async () => {
        if (keepaliveSent) {
          return;
        }
        keepaliveSent = true;
        await this.sendText(params.conversation, "Codex is still planning...");
      })();
    }, PLAN_PROGRESS_DELAY_MS);
    const stopProgressTimer = () => {
      if (!progressTimer) {
        return;
      }
      clearTimeout(progressTimer);
      progressTimer = null;
    };
    const run = this.client.startTurn({
      sessionKey: params.binding?.sessionKey,
      workspaceDir: params.workspaceDir,
      prompt: params.prompt,
      runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      existingThreadId: params.binding?.threadId,
      model: threadState?.model || this.settings.defaultModel,
      collaborationMode: {
        mode: "plan",
        settings: {
          model: threadState?.model || this.settings.defaultModel,
          reasoningEffort: threadState?.reasoningEffort,
          developerInstructions: null,
        },
      },
      onPendingInput: async (state) => {
        if (state) {
          stopProgressTimer();
        }
        this.api.logger.debug(
          `codex plan pending input ${state ? `received (questionnaire=${state.questionnaire ? "yes" : "no"})` : "cleared"}`,
        );
        await this.handlePendingInputState(params.conversation, params.workspaceDir, state, run);
      },
      onInterrupted: async () => {
        await this.sendText(params.conversation, formatInterruptedText("plan"));
      },
    });
    this.activeRuns.set(key, {
      conversation: params.conversation,
      workspaceDir: params.workspaceDir,
      mode: "plan",
      handle: run,
    });
    void (run.result as Promise<import("./types.js").TurnResult>)
      .then(async (result) => {
        const threadId = result.threadId || run.getThreadId();
        if (threadId) {
          const state = await this.client
            .readThreadState({
              sessionKey: params.binding?.sessionKey,
              threadId,
            })
            .catch(() => null);
          const nextBinding = await this.bindConversation(params.conversation, {
            threadId,
            workspaceDir: state?.cwd || params.workspaceDir,
            threadTitle: state?.threadName,
          });
          await this.store.upsertBinding({
            ...nextBinding,
            contextUsage: result.usage ?? nextBinding.contextUsage,
            updatedAt: Date.now(),
          });
        }
        if (result.aborted) {
          await this.sendText(params.conversation, formatInterruptedText("plan"));
          return;
        }
        if (result.planArtifact) {
          const implement = await this.store.putCallback({
            kind: "run-prompt",
            conversation: params.conversation,
            workspaceDir: params.workspaceDir,
            prompt: "Implement the plan.",
            collaborationMode: {
              mode: "default",
              settings: {
                model: threadState?.model || this.settings.defaultModel,
                reasoningEffort: threadState?.reasoningEffort,
                developerInstructions: null,
              },
            },
          });
          const stay = await this.store.putCallback({
            kind: "reply-text",
            conversation: params.conversation,
            text: "Okay. Staying in plan mode.",
          });
          const delivery = await this.buildPlanDelivery(result.planArtifact);
          await this.sendText(params.conversation, delivery.summaryText);
          if (delivery.attachmentPath) {
            const attachmentSent = await this.sendReply(params.conversation, {
              mediaUrl: delivery.attachmentPath,
            }).catch((error) => {
              this.api.logger.warn(`codex plan attachment send failed: ${String(error)}`);
              return false;
            });
            if (!attachmentSent && delivery.attachmentFallbackText) {
              await this.sendText(params.conversation, delivery.attachmentFallbackText);
            }
          }
          await this.sendText(params.conversation, "Implement this plan?", {
            buttons: [
              [
                {
                  text: "Yes, implement this plan",
                  callback_data: `${INTERACTIVE_NAMESPACE}:${implement.token}`,
                },
              ],
              [
                {
                  text: "No, stay in Plan mode",
                  callback_data: `${INTERACTIVE_NAMESPACE}:${stay.token}`,
                },
              ],
            ],
          });
          return;
        }
        if (result.text?.trim()) {
          await this.sendText(params.conversation, result.text.trim());
        }
      })
      .catch(async (error) => {
        await this.sendText(params.conversation, formatFailureText("plan", error));
      })
      .finally(async () => {
        stopProgressTimer();
        typing?.stop();
        this.activeRuns.delete(key);
        const pending = this.store.getPendingRequestByConversation(params.conversation);
        if (pending) {
          await this.store.removePendingRequest(pending.requestId);
        }
      });
  }

  private async startReview(params: {
    conversation: ConversationTarget;
    binding: StoredBinding;
    workspaceDir: string;
    target: { type: "uncommittedChanges" } | { type: "custom"; instructions: string };
    announceStart?: boolean;
  }): Promise<void> {
    const key = buildConversationKey(params.conversation);
    const existing = this.activeRuns.get(key);
    if (existing) {
      await existing.handle.interrupt();
    }
    if (params.announceStart !== false) {
      await this.sendText(
        params.conversation,
        params.target.type === "custom"
          ? "Starting Codex review with your custom focus. I’ll send the findings when the review finishes."
          : "Starting Codex review of the current changes. I’ll send the findings when the review finishes.",
      );
    }
    const typing = await this.startTypingLease(params.conversation);
    let keepaliveSent = false;
    let progressTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      void (async () => {
        if (keepaliveSent) {
          return;
        }
        keepaliveSent = true;
        await this.sendText(params.conversation, "Codex is still reviewing...");
      })();
    }, REVIEW_PROGRESS_DELAY_MS);
    const stopProgressTimer = () => {
      if (!progressTimer) {
        return;
      }
      clearTimeout(progressTimer);
      progressTimer = null;
    };
    const run = this.client.startReview({
      sessionKey: params.binding.sessionKey,
      workspaceDir: params.workspaceDir,
      threadId: params.binding.threadId,
      runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      target: params.target,
      onPendingInput: async (state) => {
        if (state) {
          stopProgressTimer();
        }
        await this.handlePendingInputState(params.conversation, params.workspaceDir, state, run);
      },
      onInterrupted: async () => {
        await this.sendText(params.conversation, "Codex review stopped.");
      },
    });
    this.activeRuns.set(key, {
      conversation: params.conversation,
      workspaceDir: params.workspaceDir,
      mode: "review",
      handle: run,
    });
    void (run.result as Promise<import("./types.js").ReviewResult>)
      .then(async (result) => {
        if (result.aborted) {
          await this.sendText(params.conversation, formatInterruptedText("review"));
          return;
        }
        const parsed = parseCodexReviewOutput(result.reviewText);
        if (parsed.summary) {
          await this.sendText(params.conversation, parsed.summary);
        }
        if (parsed.findings.length === 0) {
          await this.sendText(params.conversation, "No review findings.");
          return;
        }
        for (const [index, finding] of parsed.findings.entries()) {
          await this.sendText(
            params.conversation,
            formatCodexReviewFindingMessage({
              finding,
              index,
            }),
          );
        }
        const buttons: PluginInteractiveButtons = [];
        for (const [index, finding] of parsed.findings.slice(0, 6).entries()) {
          const callback = await this.store.putCallback({
            kind: "run-prompt",
            conversation: params.conversation,
            workspaceDir: params.workspaceDir,
            prompt: [
              "Please implement this Codex review finding:",
              "",
              formatCodexReviewFindingMessage({ finding, index }),
            ].join("\n"),
          });
          buttons.push([
            {
              text: finding.priorityLabel ? `Implement ${finding.priorityLabel}` : `Implement #${index + 1}`,
              callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
            },
          ]);
        }
        const allFixes = await this.store.putCallback({
          kind: "run-prompt",
          conversation: params.conversation,
          workspaceDir: params.workspaceDir,
          prompt: [
            "Please implement fixes for all of these Codex review findings:",
            "",
            ...parsed.findings.map((finding, index) =>
              `${index + 1}. ${finding.priorityLabel ? `[${finding.priorityLabel}] ` : ""}${finding.title}${
                finding.location ? `\n   ${finding.location}` : ""
              }${finding.body?.trim() ? `\n   ${finding.body.trim().replace(/\n/g, "\n   ")}` : ""}`,
            ),
          ].join("\n"),
        });
        buttons.push([
          {
            text: "Implement All Fixes",
            callback_data: `${INTERACTIVE_NAMESPACE}:${allFixes.token}`,
          },
        ]);
        await this.sendText(
          params.conversation,
          "Choose a review finding to implement, or implement them all.",
          { buttons },
        );
      })
      .catch(async (error) => {
        await this.sendText(params.conversation, formatFailureText("review", error));
      })
      .finally(async () => {
        stopProgressTimer();
        typing?.stop();
        this.activeRuns.delete(key);
        const pending = this.store.getPendingRequestByConversation(params.conversation);
        if (pending) {
          await this.store.removePendingRequest(pending.requestId);
        }
      });
  }

  private async handlePendingInputState(
    conversation: ConversationTarget,
    workspaceDir: string,
    state: PendingInputState | null,
    run: ActiveCodexRun,
  ): Promise<void> {
    if (!state) {
      const existing = this.store.getPendingRequestByConversation(conversation);
      if (existing) {
        await this.store.removePendingRequest(existing.requestId);
      }
      return;
    }
    if (state.questionnaire) {
      const existing = this.store.getPendingRequestById(state.requestId);
      await this.store.upsertPendingRequest({
        requestId: state.requestId,
        conversation,
        threadId: run.getThreadId() ?? this.store.getBinding(conversation)?.threadId ?? "",
        workspaceDir,
        state,
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
      });
      await this.sendPendingQuestionnaire(conversation, state);
      return;
    }
    const callbacks = await Promise.all(
      (state.actions ?? []).map(async (_action, actionIndex) => {
        return await this.store.putCallback({
          kind: "pending-input",
          conversation,
          requestId: state.requestId,
          actionIndex,
          ttlMs: Math.max(1_000, state.expiresAt - Date.now()),
        });
      }),
    );
    const buttons = this.buildPendingButtons(state, callbacks);
    const existing = this.store.getPendingRequestById(state.requestId);
    await this.store.upsertPendingRequest({
      requestId: state.requestId,
      conversation,
      threadId: run.getThreadId() ?? this.store.getBinding(conversation)?.threadId ?? "",
      workspaceDir,
      state,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
    await this.sendText(conversation, state.promptText ?? "Codex needs input.", { buttons });
  }

  private buildQuestionnaireSubmissionPayload(pending: StoredPendingRequest): unknown {
    const questionnaire = pending.state.questionnaire;
    if (!questionnaire) {
      return {};
    }
    const response = buildPendingQuestionnaireResponse(questionnaire);
    const createdAt = pending.createdAt ?? pending.updatedAt;
    const elapsedMs = Math.max(0, Date.now() - createdAt);
    if (elapsedMs < DELAYED_QUESTIONNAIRE_NOTE_THRESHOLD_MS) {
      return response;
    }
    return addQuestionnaireResponseNote(
      response,
      `This answer was selected by the user in chat after ${formatElapsedDuration(elapsedMs)}; it was not auto-selected.`,
    );
  }

  private async sendPendingQuestionnaire(
    conversation: ConversationTarget,
    state: PendingInputState,
    opts?: {
      editMessage?: (text: string, buttons: PluginInteractiveButtons) => Promise<void>;
    },
  ): Promise<void> {
    const questionnaire = state.questionnaire;
    if (!questionnaire) {
      return;
    }
    const buttons = await this.buildPendingQuestionnaireButtons(conversation, state);
    const text = formatPendingQuestionnairePrompt(questionnaire);
    if (opts?.editMessage) {
      await opts.editMessage(text, buttons);
      return;
    }
    await this.sendText(conversation, text, { buttons });
  }

  private async buildPendingQuestionnaireButtons(
    conversation: ConversationTarget,
    state: PendingInputState,
  ): Promise<PluginInteractiveButtons> {
    const questionnaire = state.questionnaire;
    if (!questionnaire) {
      return [];
    }
    const question = questionnaire.questions[questionnaire.currentIndex];
    if (!question) {
      return [];
    }
    const rows: PluginInteractiveButtons = [];
    for (let optionIndex = 0; optionIndex < question.options.length; optionIndex += 1) {
      const option = question.options[optionIndex];
      if (!option) {
        continue;
      }
      const callback = await this.store.putCallback({
        kind: "pending-questionnaire",
        conversation,
        requestId: state.requestId,
        questionIndex: question.index,
        action: "select",
        optionIndex,
        ttlMs: Math.max(1_000, state.expiresAt - Date.now()),
      });
      rows.push([
        {
          text: `${option.key}. ${option.label}`,
          callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
        },
      ]);
    }
    const navRow: PluginInteractiveButtons[number] = [];
    if (questionnaire.currentIndex > 0) {
      const prev = await this.store.putCallback({
        kind: "pending-questionnaire",
        conversation,
        requestId: state.requestId,
        questionIndex: questionnaire.currentIndex,
        action: "prev",
        ttlMs: Math.max(1_000, state.expiresAt - Date.now()),
      });
      navRow.push({
        text: "Prev",
        callback_data: `${INTERACTIVE_NAMESPACE}:${prev.token}`,
      });
    }
    if (
      questionnaire.currentIndex < questionnaire.questions.length - 1 &&
      questionnaireCurrentQuestionHasAnswer(questionnaire)
    ) {
      const next = await this.store.putCallback({
        kind: "pending-questionnaire",
        conversation,
        requestId: state.requestId,
        questionIndex: questionnaire.currentIndex,
        action: "next",
        ttlMs: Math.max(1_000, state.expiresAt - Date.now()),
      });
      navRow.push({
        text: "Next",
        callback_data: `${INTERACTIVE_NAMESPACE}:${next.token}`,
      });
    }
    if (navRow.length > 0) {
      rows.push(navRow);
    }
    const freeform = await this.store.putCallback({
      kind: "pending-questionnaire",
      conversation,
      requestId: state.requestId,
      questionIndex: questionnaire.currentIndex,
      action: "freeform",
      ttlMs: Math.max(1_000, state.expiresAt - Date.now()),
    });
    rows.push([
      {
        text: "Use Free Form",
        callback_data: `${INTERACTIVE_NAMESPACE}:${freeform.token}`,
      },
    ]);
    return rows;
  }

  private buildPendingButtons(
    state: PendingInputState,
    callbacks: CallbackAction[],
  ): PluginInteractiveButtons | undefined {
    const actions = state.actions ?? [];
    if (actions.length === 0 || callbacks.length === 0) {
      return undefined;
    }
    const rows: PluginInteractiveButtons = [];
    for (let index = 0; index < actions.length; index += 2) {
      rows.push(
        actions.slice(index, index + 2).map((action, offset) => ({
          text: action.label,
          callback_data: `${INTERACTIVE_NAMESPACE}:${callbacks[index + offset]?.token ?? requestToken(state.requestId)}`,
        })),
      );
    }
    return rows;
  }

  private async handlePendingQuestionnaireFreeformAnswer(
    conversation: ConversationTarget,
    pending: StoredPendingRequest,
    run: ActiveCodexRun,
    text: string,
  ): Promise<boolean> {
    const questionnaire = pending.state.questionnaire;
    const answerText = text.trim();
    if (!questionnaire || !answerText) {
      return false;
    }
    questionnaire.answers[questionnaire.currentIndex] = {
      kind: "text",
      text: answerText,
    };
    questionnaire.awaitingFreeform = false;
    pending.updatedAt = Date.now();
    await this.store.upsertPendingRequest(pending);
    if (questionnaireIsComplete(questionnaire)) {
      const submitted = await run.submitPendingInputPayload(
        this.buildQuestionnaireSubmissionPayload(pending),
      );
      if (!submitted) {
        return false;
      }
      await this.store.removePendingRequest(pending.requestId);
      await this.sendText(conversation, "Recorded your answers and sent them to Codex.");
      return true;
    }
    questionnaire.currentIndex = Math.min(
      questionnaire.questions.length - 1,
      questionnaire.currentIndex + 1,
    );
    pending.updatedAt = Date.now();
    await this.store.upsertPendingRequest(pending);
    await this.sendPendingQuestionnaire(conversation, pending.state);
    return true;
  }

  private resolveThreadWorkspaceDir(
    parsed: ReturnType<typeof parseThreadSelectionArgs>,
    binding: StoredBinding | null,
    useAllProjectsDefault: boolean,
  ): string | undefined {
    if (parsed.cwd) {
      return parsed.cwd;
    }
    if (parsed.includeAll || useAllProjectsDefault) {
      return undefined;
    }
    return resolveWorkspaceDir({
      bindingWorkspaceDir: binding?.workspaceDir,
      configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
      serviceWorkspaceDir: this.serviceWorkspaceDir,
    });
  }

  private async listPickerThreads(
    binding: StoredBinding | null,
    params: {
      parsed: ReturnType<typeof parseThreadSelectionArgs>;
      projectName?: string;
      filterProjectsOnly?: boolean;
    },
  ) {
    const workspaceDir = this.resolveThreadWorkspaceDir(
      params.parsed,
      binding,
      params.filterProjectsOnly || Boolean(params.projectName),
    );
    const threads = await this.client.listThreads({
      sessionKey: binding?.sessionKey,
      workspaceDir,
      filter: params.filterProjectsOnly ? undefined : params.parsed.query || undefined,
    });
    return {
      workspaceDir,
      threads: filterThreadsByProjectName(threads, params.projectName),
    };
  }

  private async buildThreadPickerButtons(params: {
    conversation: ConversationTarget;
    syncTopic?: boolean;
    threads: Array<{ threadId: string; title?: string; projectKey?: string }>;
    showProjectName: boolean;
  }): Promise<PluginInteractiveButtons | undefined> {
    if (params.threads.length === 0) {
      return undefined;
    }
    const rows: PluginInteractiveButtons = [];
    for (const thread of params.threads) {
      const isWorktree = this.isWorktreePath(thread.projectKey);
      const hasChanges = await this.readThreadHasChanges(thread.projectKey);
      const callback = await this.store.putCallback({
        kind: "resume-thread",
        conversation: params.conversation,
        threadId: thread.threadId,
        workspaceDir: thread.projectKey?.trim() || this.settings.defaultWorkspaceDir || process.cwd(),
        syncTopic: params.syncTopic,
      });
      rows.push([
        {
          text: formatThreadButtonLabel({
            thread,
            includeProjectSuffix: params.showProjectName,
            isWorktree,
            hasChanges,
          }),
          callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
        },
      ]);
    }
    return rows;
  }

  private async appendThreadPickerControls(params: {
    conversation: ConversationTarget;
    buttons: PluginInteractiveButtons;
    parsed: ReturnType<typeof parseThreadSelectionArgs>;
    projectName?: string;
    page: number;
    totalPages: number;
  }): Promise<PluginInteractiveButtons> {
    if (params.totalPages > 1) {
      const navRow: PluginInteractiveButtons[number] = [];
      if (params.page > 0) {
        const prev = await this.store.putCallback({
          kind: "picker-view",
          conversation: params.conversation,
          view: {
            mode: "threads",
            includeAll: params.parsed.includeAll,
            syncTopic: params.parsed.syncTopic,
            workspaceDir: params.parsed.cwd,
            query: params.parsed.query || undefined,
            projectName: params.projectName,
            page: params.page - 1,
          },
        });
        navRow.push({
          text: "◀ Prev",
          callback_data: `${INTERACTIVE_NAMESPACE}:${prev.token}`,
        });
      }
      if (params.page + 1 < params.totalPages) {
        const next = await this.store.putCallback({
          kind: "picker-view",
          conversation: params.conversation,
          view: {
            mode: "threads",
            includeAll: params.parsed.includeAll,
            syncTopic: params.parsed.syncTopic,
            workspaceDir: params.parsed.cwd,
            query: params.parsed.query || undefined,
            projectName: params.projectName,
            page: params.page + 1,
          },
        });
        navRow.push({
          text: "Next ▶",
          callback_data: `${INTERACTIVE_NAMESPACE}:${next.token}`,
        });
      }
      if (navRow.length > 0) {
        params.buttons.push(navRow);
      }
    }

    const projects = await this.store.putCallback({
      kind: "picker-view",
      conversation: params.conversation,
      view: {
        mode: "projects",
        includeAll: true,
        syncTopic: params.parsed.syncTopic,
        workspaceDir: params.parsed.cwd,
        page: 0,
      },
    });
    const cancel = await this.store.putCallback({
      kind: "cancel-picker",
      conversation: params.conversation,
    });
    params.buttons.push([
      {
        text: params.projectName ? "Projects" : "Browse Projects",
        callback_data: `${INTERACTIVE_NAMESPACE}:${projects.token}`,
      },
      {
        text: "Cancel",
        callback_data: `${INTERACTIVE_NAMESPACE}:${cancel.token}`,
      },
    ]);
    return params.buttons;
  }

  private async renderThreadPicker(
    conversation: ConversationTarget,
    binding: StoredBinding | null,
    parsed: ReturnType<typeof parseThreadSelectionArgs>,
    page: number,
    projectName?: string,
  ): Promise<PickerRender> {
    let { workspaceDir, threads } = await this.listPickerThreads(binding, {
      parsed,
      projectName,
    });
    let fallbackToGlobal = false;
    if (threads.length === 0 && workspaceDir != null && !projectName) {
      const globalResult = await this.client.listThreads({
        sessionKey: binding?.sessionKey,
        workspaceDir: undefined,
        filter: parsed.query || undefined,
      });
      if (globalResult.length > 0) {
        threads = globalResult;
        fallbackToGlobal = true;
      }
    }
    const pageResult = paginateItems(threads, page);
    const distinctProjects = new Set(
      threads.map((thread) => getProjectName(thread.projectKey)).filter(Boolean),
    );
    const threadButtons =
      (await this.buildThreadPickerButtons({
      conversation,
      syncTopic: parsed.syncTopic,
      threads: pageResult.items,
      showProjectName: !projectName && (fallbackToGlobal || distinctProjects.size > 1),
      })) ?? [];
    return {
      text: formatThreadPickerIntro({
        page: pageResult.page,
        totalPages: pageResult.totalPages,
        totalItems: pageResult.totalItems,
        includeAll: workspaceDir == null || fallbackToGlobal,
        syncTopic: parsed.syncTopic,
        workspaceDir: fallbackToGlobal ? undefined : workspaceDir,
        projectName,
        fallbackToGlobal,
      }),
      buttons: await this.appendThreadPickerControls({
            conversation,
            buttons: threadButtons,
            parsed,
            projectName,
            page: pageResult.page,
            totalPages: pageResult.totalPages,
          }),
    };
  }

  private async renderProjectPicker(
    conversation: ConversationTarget,
    binding: StoredBinding | null,
    parsed: ReturnType<typeof parseThreadSelectionArgs>,
    page: number,
  ): Promise<PickerRender> {
    const { workspaceDir, threads } = await this.listPickerThreads(binding, {
      parsed,
      filterProjectsOnly: true,
    });
    const projects = paginateItems(listProjects(threads, parsed.query), page);
    const buttons: PluginInteractiveButtons = [];
    for (const project of projects.items) {
      const callback = await this.store.putCallback({
        kind: "picker-view",
        conversation,
        view: {
          mode: "threads",
          includeAll: true,
          syncTopic: parsed.syncTopic,
          workspaceDir: parsed.cwd,
          projectName: project.name,
          page: 0,
        },
      });
      buttons.push([
        {
          text: `${project.name} (${project.threadCount})`,
          callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
        },
      ]);
    }

    if (projects.totalPages > 1) {
      const navRow: PluginInteractiveButtons[number] = [];
      if (projects.page > 0) {
        const prev = await this.store.putCallback({
          kind: "picker-view",
          conversation,
          view: {
            mode: "projects",
            includeAll: true,
            syncTopic: parsed.syncTopic,
            workspaceDir: parsed.cwd,
            query: parsed.query || undefined,
            page: projects.page - 1,
          },
        });
        navRow.push({
          text: "◀ Prev",
          callback_data: `${INTERACTIVE_NAMESPACE}:${prev.token}`,
        });
      }
      if (projects.page + 1 < projects.totalPages) {
        const next = await this.store.putCallback({
          kind: "picker-view",
          conversation,
          view: {
            mode: "projects",
            includeAll: true,
            syncTopic: parsed.syncTopic,
            workspaceDir: parsed.cwd,
            query: parsed.query || undefined,
            page: projects.page + 1,
          },
        });
        navRow.push({
          text: "Next ▶",
          callback_data: `${INTERACTIVE_NAMESPACE}:${next.token}`,
        });
      }
      if (navRow.length > 0) {
        buttons.push(navRow);
      }
    }

    const recent = await this.store.putCallback({
      kind: "picker-view",
      conversation,
      view: {
        mode: "threads",
        includeAll: true,
        syncTopic: parsed.syncTopic,
        workspaceDir: parsed.cwd,
        page: 0,
      },
    });
    const cancel = await this.store.putCallback({
      kind: "cancel-picker",
      conversation,
    });
    buttons.push([
      {
        text: "Recent Sessions",
        callback_data: `${INTERACTIVE_NAMESPACE}:${recent.token}`,
      },
      {
        text: "Cancel",
        callback_data: `${INTERACTIVE_NAMESPACE}:${cancel.token}`,
      },
    ]);

    return {
      text: formatProjectPickerIntro({
        page: projects.page,
        totalPages: projects.totalPages,
        totalItems: projects.totalItems,
        workspaceDir,
      }),
      buttons,
    };
  }

  private async sendDiscordPicker(
    conversation: ConversationTarget,
    picker: PickerRender,
  ): Promise<void> {
    this.api.logger.debug(
      `codex discord picker send conversation=${conversation.conversationId} rows=${picker.buttons?.length ?? 0}`,
    );
    await this.api.runtime.channel.discord.sendComponentMessage(
      conversation.conversationId,
      this.buildDiscordPickerSpec(picker),
      {
        accountId: conversation.accountId,
      },
    );
  }

  private buildDiscordPickerSpec(picker: PickerRender): DiscordComponentMessageSpec {
    return {
      text: picker.text,
      blocks: (picker.buttons ?? []).map((row) => ({
        type: "actions" as const,
        buttons: row.map((button) => ({
          label: truncateDiscordLabel(button.text),
          style: "primary" as const,
          callbackData: button.callback_data,
        })),
      })),
    };
  }

  private buildDiscordPickerMessage(picker: PickerRender) {
    return buildDiscordComponentMessage({
      spec: this.buildDiscordPickerSpec(picker),
    });
  }

  private async dispatchCallbackAction(
    callback: CallbackAction,
    responders: PickerResponders,
  ): Promise<void> {
    if (callback.kind === "resume-thread") {
      if (responders.conversation.channel !== "discord") {
        await responders.clear().catch(() => undefined);
      }
      const threadState = await this.client
        .readThreadState({
          sessionKey: buildPluginSessionKey(callback.threadId),
          threadId: callback.threadId,
        })
        .catch(() => undefined);
      const bindResult = await this.requestConversationBinding(
        callback.conversation,
        {
          threadId: callback.threadId,
          workspaceDir: threadState?.cwd?.trim() || callback.workspaceDir,
          threadTitle: threadState?.threadName,
          syncTopic: callback.syncTopic,
          notifyBound: true,
        },
        responders.requestConversationBinding,
      );
      if (bindResult.status === "pending") {
        // Interactive bind requests already send the approval prompt with the
        // channel-specific buttons/components from responders.requestConversationBinding.
        // Sending another plain-text reply here duplicates the same prompt.
        return;
      }
      if (bindResult.status === "error") {
        await responders.reply(bindResult.message);
        return;
      }
      await this.store.removeCallback(callback.token);
      if (callback.syncTopic) {
        const syncedName = buildResumeTopicName({
          title: threadState?.threadName,
          projectKey: threadState?.cwd?.trim() || callback.workspaceDir,
          threadId: callback.threadId,
        });
        if (syncedName) {
          await this.renameConversationIfSupported(responders.conversation, syncedName);
        }
      }
      await this.sendBoundConversationSummary(callback.conversation);
      return;
    }
    if (callback.kind === "pending-input") {
      await responders.clear().catch(() => undefined);
      const pending = this.store.getPendingRequestById(callback.requestId);
      if (!pending) {
        await this.store.removeCallback(callback.token);
        await responders.reply("That Codex request is no longer available. Please retry.");
        return;
      }
      const active = this.activeRuns.get(buildConversationKey(callback.conversation));
      if (!active) {
        await responders.reply("No active Codex run is waiting for input.");
        return;
      }
      const submitted = await active.handle.submitPendingInput(callback.actionIndex);
      if (!submitted) {
        await responders.reply("That Codex action is no longer available.");
        return;
      }
      await this.store.removeCallback(callback.token);
      if (callback.conversation.channel !== "discord") {
        await responders.reply("Sent to Codex.");
      }
      return;
    }
    if (callback.kind === "pending-questionnaire") {
      const pending = this.store.getPendingRequestById(callback.requestId);
      if (!pending || !pending.state.questionnaire) {
        await this.store.removeCallback(callback.token);
        await responders.reply("That Codex questionnaire is no longer available. Please retry.");
        return;
      }
      const active = this.activeRuns.get(buildConversationKey(callback.conversation));
      if (!active) {
        await responders.reply("No active Codex run is waiting for input.");
        return;
      }
      const questionnaire = pending.state.questionnaire;
      if (callback.action === "freeform") {
        questionnaire.currentIndex = Math.max(
          0,
          Math.min(callback.questionIndex, questionnaire.questions.length - 1),
        );
        questionnaire.awaitingFreeform = true;
        pending.updatedAt = Date.now();
        await this.store.upsertPendingRequest(pending);
        await responders.reply(
          `Send a free-form answer for question ${questionnaire.currentIndex + 1} of ${questionnaire.questions.length} and I’ll record it.`,
        );
        await this.sendPendingQuestionnaire(callback.conversation, pending.state, {
          editMessage: async (text, buttons) => {
            await responders.editPicker({ text, buttons });
          },
        });
        return;
      }
      if (callback.action === "prev") {
        questionnaire.currentIndex = Math.max(0, callback.questionIndex - 1);
        questionnaire.awaitingFreeform = false;
        pending.updatedAt = Date.now();
        await this.store.upsertPendingRequest(pending);
        await this.sendPendingQuestionnaire(callback.conversation, pending.state, {
          editMessage: async (text, buttons) => {
            await responders.editPicker({ text, buttons });
          },
        });
        return;
      }
      if (callback.action === "next") {
        const currentAnswer = questionnaire.answers[callback.questionIndex];
        if (!currentAnswer) {
          await responders.reply("Answer this question first, or choose Free Form.");
          return;
        }
        questionnaire.currentIndex = Math.min(
          questionnaire.questions.length - 1,
          callback.questionIndex + 1,
        );
        questionnaire.awaitingFreeform = false;
        pending.updatedAt = Date.now();
        await this.store.upsertPendingRequest(pending);
        await this.sendPendingQuestionnaire(callback.conversation, pending.state, {
          editMessage: async (text, buttons) => {
            await responders.editPicker({ text, buttons });
          },
        });
        return;
      }
      const question = questionnaire.questions[callback.questionIndex];
      const option = question?.options[callback.optionIndex ?? -1];
      if (!question || !option) {
        await responders.reply("That Codex option is no longer available.");
        return;
      }
      questionnaire.answers[callback.questionIndex] = {
        kind: "option",
        optionKey: option.key,
        optionLabel: option.label,
      };
      questionnaire.awaitingFreeform = false;
      questionnaire.currentIndex = Math.min(
        questionnaire.questions.length - 1,
        callback.questionIndex + 1,
      );
      pending.updatedAt = Date.now();
      await this.store.upsertPendingRequest(pending);
      if (questionnaireIsComplete(questionnaire)) {
        const submitted = await active.handle.submitPendingInputPayload(
          this.buildQuestionnaireSubmissionPayload(pending),
        );
        if (!submitted) {
          await responders.reply("That Codex questionnaire is no longer accepting answers.");
          return;
        }
        await responders.clear().catch(() => undefined);
        await this.store.removePendingRequest(pending.requestId);
        if (callback.conversation.channel !== "discord") {
          await responders.reply("Recorded your answers and sent them to Codex.");
        }
        return;
      }
      await this.sendPendingQuestionnaire(callback.conversation, pending.state, {
        editMessage: async (text, buttons) => {
          await responders.editPicker({ text, buttons });
        },
      });
      return;
    }
    if (callback.kind === "run-prompt") {
      await responders.clear().catch(() => undefined);
      const binding = this.store.getBinding(callback.conversation);
      const conversation = {
        ...callback.conversation,
        threadId: responders.conversation.threadId,
      };
      const workspaceDir = callback.workspaceDir?.trim() || binding?.workspaceDir || resolveWorkspaceDir({
        bindingWorkspaceDir: binding?.workspaceDir,
        configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
        serviceWorkspaceDir: this.serviceWorkspaceDir,
      });
      await this.store.removeCallback(callback.token);
      const active = this.activeRuns.get(buildConversationKey(conversation));
      const ackText = this.buildRunPromptAckText(callback.prompt);
      if (active) {
        if (active.mode === "plan" && (callback.collaborationMode?.mode ?? "default") !== "plan") {
          this.activeRuns.delete(buildConversationKey(conversation));
          await active.handle.interrupt().catch(() => undefined);
        } else {
          const handled = await active.handle.queueMessage(callback.prompt);
          if (handled) {
            await responders.reply(ackText);
            return;
          }
        }
      }
      await this.startTurn({
        conversation,
        binding,
        workspaceDir,
        prompt: callback.prompt,
        reason: "command",
        collaborationMode: callback.collaborationMode,
      });
      await responders.reply(ackText);
      return;
    }
    if (callback.kind === "set-model") {
      await responders.clear().catch(() => undefined);
      const binding = this.store.getBinding(callback.conversation);
      await this.store.removeCallback(callback.token);
      if (!binding) {
        await responders.reply("No Codex binding for this conversation.");
        return;
      }
      const state = await this.client.setThreadModel({
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
        model: callback.model,
        workspaceDir: binding.workspaceDir,
      });
      await responders.reply(`Codex model set to ${state.model || callback.model}.`);
      return;
    }
    if (callback.kind === "reply-text") {
      await responders.clear().catch(() => undefined);
      await this.store.removeCallback(callback.token);
      await responders.reply(callback.text);
      return;
    }
    if (callback.kind === "rename-thread") {
      await responders.clear().catch(() => undefined);
      const binding = this.store.getBinding(callback.conversation);
      await this.store.removeCallback(callback.token);
      if (!binding) {
        await responders.reply("Bind this conversation to a Codex thread before renaming it.");
        return;
      }
      try {
        const name = await this.applyRenameStyle(
          responders.conversation,
          binding,
          callback.style,
          callback.syncTopic,
        );
        await responders.reply(`Renamed the Codex thread to "${name}".`);
      } catch (error) {
        await responders.reply(
          error instanceof Error ? error.message : "Unable to derive a Codex thread name.",
        );
      }
      return;
    }
    if (callback.kind === "cancel-picker") {
      await this.store.removeCallback(callback.token);
      await responders.editPicker({ text: "Picker dismissed.", buttons: [] });
      return;
    }
    const binding = this.store.getBinding(callback.conversation);
    await this.store.removeCallback(callback.token);
    const parsed = {
      includeAll: callback.view.includeAll,
      listProjects: callback.view.mode === "projects",
      syncTopic: callback.view.syncTopic ?? false,
      cwd: callback.view.workspaceDir,
      query: callback.view.query ?? "",
    };
    const picker =
      callback.view.mode === "projects"
        ? await this.renderProjectPicker(responders.conversation, binding, parsed, callback.view.page)
        : await this.renderThreadPicker(
            responders.conversation,
            binding,
            parsed,
            callback.view.page,
            callback.view.projectName,
          );
    await responders.editPicker(picker);
  }

  private async resolveSingleThread(
    sessionKey: string | undefined,
    workspaceDir: string | undefined,
    filter: string,
  ): Promise<
    | { kind: "none" }
    | { kind: "unique"; thread: { threadId: string; title?: string; projectKey?: string } }
    | { kind: "ambiguous"; threads: Array<{ threadId: string; title?: string; projectKey?: string }> }
  > {
    const trimmed = filter.trim();
    const threads = await this.client.listThreads({
      sessionKey,
      workspaceDir,
      filter: trimmed,
    });
    return selectThreadFromMatches(threads, trimmed);
  }

  private async bindConversation(
    conversation: ConversationTarget,
    params: {
      threadId: string;
      workspaceDir: string;
      threadTitle?: string;
    },
  ): Promise<StoredBinding> {
    const sessionKey = buildPluginSessionKey(params.threadId);
    const existing = this.store.getBinding(conversation);
    const record: StoredBinding = {
      conversation: {
        channel: conversation.channel,
        accountId: conversation.accountId,
        conversationId: conversation.conversationId,
        parentConversationId: conversation.parentConversationId,
      },
      sessionKey,
      threadId: params.threadId,
      workspaceDir: params.workspaceDir,
      threadTitle: params.threadTitle,
      pinnedBindingMessage: existing?.pinnedBindingMessage,
      contextUsage: existing?.contextUsage,
      updatedAt: Date.now(),
    };
    await this.store.upsertBinding(record);
    return record;
  }

  private async hydrateApprovedBinding(
    conversation: ConversationTarget,
  ): Promise<HydratedBindingResult | null> {
    const existing = this.store.getBinding(conversation);
    if (existing) {
      return { binding: existing };
    }
    const pending = this.store.getPendingBind(conversation);
    if (!pending) {
      return null;
    }
    const binding = await this.bindConversation(conversation, {
      threadId: pending.threadId,
      workspaceDir: pending.workspaceDir,
      threadTitle: pending.threadTitle,
    });
    return { binding, pendingBind: pending };
  }

  private async requestConversationBinding(
    conversation: ConversationTarget,
    params: {
      threadId: string;
      workspaceDir: string;
      threadTitle?: string;
      syncTopic?: boolean;
      notifyBound?: boolean;
    },
    requestBinding?: (
      params?: { summary?: string },
    ) => Promise<
      | { status: "bound" }
      | { status: "pending"; reply: ReplyPayload }
      | { status: "error"; message: string }
    >,
  ): Promise<
    | { status: "bound"; binding: StoredBinding }
    | { status: "pending"; reply: ReplyPayload }
    | { status: "error"; message: string }
  > {
    if (!requestBinding) {
      return {
        status: "error",
        message: "This action can only bind from a live command or interactive context.",
      };
    }
    if (params.workspaceDir && this.isWorktreePath(params.workspaceDir) && !existsSync(params.workspaceDir)) {
      return {
        status: "error",
        message: `Cannot resume: workspace path no longer exists on disk.\n\`${params.workspaceDir}\`\n\nThe worktree may have been removed. Check your local paths or start a new session.`,
      };
    }
    const approval = await requestBinding({
      summary: `Bind this conversation to Codex thread ${params.threadTitle?.trim() || params.threadId}.`,
    });
    if (approval.status !== "bound") {
      if (approval.status === "pending") {
        await this.store.upsertPendingBind({
          conversation: {
            channel: conversation.channel,
            accountId: conversation.accountId,
          conversationId: conversation.conversationId,
          parentConversationId: conversation.parentConversationId,
        },
          threadId: params.threadId,
          workspaceDir: params.workspaceDir,
          threadTitle: params.threadTitle,
          syncTopic: params.syncTopic,
          notifyBound: params.notifyBound,
          updatedAt: Date.now(),
        });
      }
      return approval;
    }
    const binding = await this.bindConversation(conversation, params);
    return { status: "bound", binding };
  }

  private trimReplayText(value?: string, maxLength = 1200): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.length <= maxLength) {
      return trimmed;
    }
    return `${trimmed.slice(0, maxLength - 3).trimEnd()}...`;
  }

  private isWorktreePath(projectKey?: string): boolean {
    const trimmed = projectKey?.trim();
    return Boolean(trimmed && /[/\\]worktrees[/\\][^/\\]+[/\\][^/\\]+/.test(trimmed));
  }

  private readThreadHasChanges(projectKey?: string): Promise<boolean | undefined> {
    const cwd = projectKey?.trim();
    if (!cwd) {
      return Promise.resolve(undefined);
    }
    let cached = this.threadChangesCache.get(cwd);
    if (!cached) {
      cached = execFileAsync("git", ["-C", cwd, "status", "--porcelain"], {
        timeout: 5_000,
      })
        .then((result) => result.stdout.trim().length > 0)
        .catch(() => undefined);
      this.threadChangesCache.set(cwd, cached);
    }
    return cached;
  }

  private async buildBoundConversationMessages(
    conversation: ConversationTarget | ConversationRef,
  ): Promise<string[]> {
    const binding = this.store.getBinding({
      channel: conversation.channel,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
      parentConversationId: conversation.parentConversationId,
    });
    if (!binding) {
      return ["No Codex binding for this conversation."];
    }

    const [state, replay] = await Promise.all([
      this.client.readThreadState({
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
      }),
      this.client.readThreadContext({
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
      }).catch(() => ({ lastUserMessage: undefined, lastAssistantMessage: undefined })),
    ]);

    const nextBinding =
      (state.threadName && state.threadName !== binding.threadTitle) ||
      (state.cwd?.trim() && state.cwd.trim() !== binding.workspaceDir)
        ? {
            ...binding,
            threadTitle: state.threadName?.trim() || binding.threadTitle,
            workspaceDir: state.cwd?.trim() || binding.workspaceDir,
            contextUsage: binding.contextUsage,
            updatedAt: Date.now(),
          }
        : binding;

    if (nextBinding !== binding) {
      await this.store.upsertBinding(nextBinding);
    }

    const messages = [
      formatBoundThreadSummary({
      binding: nextBinding,
      state,
      }),
    ];

    const lastUser = this.trimReplayText(replay.lastUserMessage);
    if (lastUser) {
      messages.push("Last User Request in Thread:");
      messages.push(lastUser);
    }

    const lastAssistant = this.trimReplayText(replay.lastAssistantMessage);
    if (lastAssistant) {
      messages.push("Last Agent Reply in Thread:");
      messages.push(lastAssistant);
    }

    return messages;
  }

  private async sendBoundConversationSummary(
    conversation: ConversationTarget | ConversationRef,
  ): Promise<void> {
    const messages = await this.buildBoundConversationMessages(conversation);
    const target: ConversationTarget = {
      channel: conversation.channel,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
      parentConversationId: conversation.parentConversationId,
      threadId: "threadId" in conversation ? conversation.threadId : undefined,
    };
    const [firstMessage, ...followUps] = messages;
    if (firstMessage) {
      const delivered = await this.sendTextWithDeliveryRef(target, firstMessage);
      await this.pinBindingMessage(target, delivered);
    }
    for (const message of followUps) {
      await this.sendText(target, message);
    }
  }

  private async buildStatusText(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    bindingActive: boolean,
  ): Promise<string> {
    const activeRun =
      bindingActive && conversation
        ? this.activeRuns.get(buildConversationKey(conversation))
        : undefined;
    const workspaceDir = resolveWorkspaceDir({
      bindingWorkspaceDir: binding?.workspaceDir,
      configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
      serviceWorkspaceDir: this.serviceWorkspaceDir,
    });
    const [threadState, account, limits, projectFolder] = await Promise.all([
      binding
        ? this.client.readThreadState({
            sessionKey: binding.sessionKey,
            threadId: binding.threadId,
          }).catch(() => undefined)
        : Promise.resolve(undefined),
      this.client.readAccount({
        sessionKey: binding?.sessionKey,
      }).catch(() => null),
      this.client.readRateLimits({
        sessionKey: binding?.sessionKey,
      }).catch(() => []),
      this.resolveProjectFolder(binding?.workspaceDir || workspaceDir),
    ]);
    this.api.logger.debug?.(
      `codex status snapshot bindingActive=${bindingActive ? "yes" : "no"} activeRun=${activeRun?.mode ?? "none"} boundThread=${binding?.threadId ?? "<none>"} threadModel=${threadState?.model?.trim() || "<none>"} threadCwd=${threadState?.cwd?.trim() || "<none>"}`,
    );

    return formatCodexStatusText({
      pluginVersion: PLUGIN_VERSION,
      threadState,
      account,
      rateLimits: limits,
      bindingActive,
      projectFolder,
      worktreeFolder: threadState?.cwd?.trim() || binding?.workspaceDir || workspaceDir,
      contextUsage: binding?.contextUsage,
      planMode: bindingActive ? activeRun?.mode === "plan" : undefined,
    });
  }

  private buildCompactStartText(usage?: StoredBinding["contextUsage"]): string {
    const lines = ["Starting Codex thread compaction."];
    const initialUsageText = usage ? formatContextUsageText(usage) : undefined;
    if (initialUsageText) {
      lines.push(`Starting context usage: ${initialUsageText}`);
    }
    lines.push("I’ll report progress here as compaction events arrive.");
    return lines.join("\n");
  }

  private async buildPlanDelivery(
    plan: NonNullable<import("./types.js").TurnResult["planArtifact"]>,
  ): Promise<PlanDelivery> {
    const inlineText = formatCodexPlanInlineText(plan);
    if (inlineText.length <= PLAN_INLINE_TEXT_LIMIT) {
      return {
        summaryText: inlineText,
      };
    }
    const tempDir = path.join(this.api.runtime.state.resolveStateDir(), "tmp");
    await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
    const attachmentPath = path.join(
      tempDir,
      `codex-plan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.md`,
    );
    await fs.writeFile(attachmentPath, `${plan.markdown.trim()}\n`, "utf8");
    return {
      summaryText: formatCodexPlanAttachmentSummary(plan),
      attachmentPath,
      attachmentFallbackText: formatCodexPlanAttachmentFallback(plan),
    };
  }

  private async sendReply(
    conversation: ConversationTarget,
    payload: {
      text?: string;
      buttons?: PluginInteractiveButtons;
      mediaUrl?: string;
    },
  ): Promise<boolean> {
    const text = payload.text?.trim() ?? "";
    const hasMedia = typeof payload.mediaUrl === "string" && payload.mediaUrl.trim().length > 0;
    if (!text && !hasMedia) {
      return false;
    }
    this.api.logger.debug?.(
      `codex outbound send start ${this.formatConversationForLog(conversation)} textChars=${text.length} media=${hasMedia ? "yes" : "no"} buttons=${payload.buttons?.length ?? 0} preview="${summarizeTextForLog(text, 80)}"`,
    );
    if (isTelegramChannel(conversation.channel)) {
      const mediaLocalRoots = this.resolveReplyMediaLocalRoots(payload.mediaUrl);
      const limit = this.api.runtime.channel.text.resolveTextChunkLimit(
        undefined,
        "telegram",
        conversation.accountId,
        { fallbackLimit: 4000 },
      );
      const chunks = text
        ? this.api.runtime.channel.text.chunkText(text, limit).filter(Boolean)
        : [];
      if (hasMedia) {
        await this.api.runtime.channel.telegram.sendMessageTelegram(
          conversation.parentConversationId ?? conversation.conversationId,
          chunks[0] ?? text,
          {
            accountId: conversation.accountId,
            messageThreadId: conversation.threadId,
            mediaUrl: payload.mediaUrl,
            mediaLocalRoots,
            buttons: chunks.length <= 1 ? payload.buttons : undefined,
          },
        );
        for (let index = 1; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          if (!chunk) {
            continue;
          }
          await this.api.runtime.channel.telegram.sendMessageTelegram(
            conversation.parentConversationId ?? conversation.conversationId,
            chunk,
            {
              accountId: conversation.accountId,
              messageThreadId: conversation.threadId,
              buttons: index === chunks.length - 1 ? payload.buttons : undefined,
            },
          );
        }
        this.api.logger.debug?.(
          `codex outbound send complete ${this.formatConversationForLog(conversation)} channel=telegram chunks=${Math.max(chunks.length, 1)} media=${hasMedia ? "yes" : "no"}`,
        );
        return true;
      }
      const textChunks = chunks.length > 0 ? chunks : [text];
      for (let index = 0; index < textChunks.length; index += 1) {
        const chunk = textChunks[index];
        if (!chunk) {
          continue;
        }
        await this.api.runtime.channel.telegram.sendMessageTelegram(
          conversation.parentConversationId ?? conversation.conversationId,
          chunk,
          {
            accountId: conversation.accountId,
            messageThreadId: conversation.threadId,
            buttons: index === textChunks.length - 1 ? payload.buttons : undefined,
          },
        );
      }
      this.api.logger.debug?.(
        `codex outbound send complete ${this.formatConversationForLog(conversation)} channel=telegram chunks=${textChunks.length} media=no`,
      );
      return true;
    }
    if (isDiscordChannel(conversation.channel)) {
      const mediaLocalRoots = this.resolveReplyMediaLocalRoots(payload.mediaUrl);
      const limit = this.api.runtime.channel.text.resolveTextChunkLimit(
        undefined,
        "discord",
        conversation.accountId,
        { fallbackLimit: 2000 },
      );
      const chunks = text
        ? this.api.runtime.channel.text.chunkText(text, limit).filter(Boolean)
        : [];
      if (payload.buttons && payload.buttons.length > 0) {
        this.api.logger.debug(
          `codex discord reply send conversation=${conversation.conversationId} rows=${payload.buttons.length}`,
        );
        const attachmentChunk = hasMedia ? (chunks.shift() ?? text) : undefined;
        if (hasMedia) {
          await this.api.runtime.channel.discord.sendMessageDiscord(
            conversation.conversationId,
            attachmentChunk ?? "",
            {
              accountId: conversation.accountId,
              mediaUrl: payload.mediaUrl,
              mediaLocalRoots,
            },
          );
        }
        const finalChunk = chunks.pop() ?? (hasMedia ? "" : text);
        for (const chunk of chunks) {
          await this.api.runtime.channel.discord.sendMessageDiscord(conversation.conversationId, chunk, {
            accountId: conversation.accountId,
          });
        }
        await this.api.runtime.channel.discord.sendComponentMessage(
          conversation.conversationId,
          {
            text: finalChunk,
            blocks: payload.buttons.map((row) => ({
              type: "actions" as const,
              buttons: row.map((button) => ({
                label: truncateDiscordLabel(button.text),
                style: "primary" as const,
                callbackData: button.callback_data,
              })),
            })),
          },
          {
            accountId: conversation.accountId,
          },
        );
        this.api.logger.debug?.(
          `codex outbound send complete ${this.formatConversationForLog(conversation)} channel=discord chunks=${chunks.length + 1 + (hasMedia ? 1 : 0)} media=${hasMedia ? "yes" : "no"} buttons=${payload.buttons.length}`,
        );
        return true;
      }
      const textChunks = chunks.length > 0 ? chunks : [text];
      if (hasMedia) {
        const firstChunk = textChunks.shift() ?? "";
        await this.api.runtime.channel.discord.sendMessageDiscord(
          conversation.conversationId,
          firstChunk,
          {
            accountId: conversation.accountId,
            mediaUrl: payload.mediaUrl,
            mediaLocalRoots,
          },
        );
      }
      for (const chunk of textChunks) {
        if (!chunk) {
          continue;
        }
        await this.api.runtime.channel.discord.sendMessageDiscord(conversation.conversationId, chunk, {
          accountId: conversation.accountId,
        });
      }
      this.api.logger.debug?.(
        `codex outbound send complete ${this.formatConversationForLog(conversation)} channel=discord chunks=${textChunks.length + (hasMedia ? 1 : 0)} media=${hasMedia ? "yes" : "no"}`,
      );
      return hasMedia || textChunks.length > 0;
    }
    return false;
  }

  private resolveReplyMediaLocalRoots(mediaUrl?: string): readonly string[] | undefined {
    const rawValue = mediaUrl?.trim();
    if (!rawValue) {
      return undefined;
    }
    const localPath = rawValue.startsWith("file://") ? fileURLToPath(rawValue) : rawValue;
    if (!path.isAbsolute(localPath)) {
      return undefined;
    }
    const roots = new Set<string>([this.api.runtime.state.resolveStateDir(), path.dirname(localPath)]);
    return [...roots];
  }

  private buildRunPromptAckText(prompt: string): string {
    const trimmed = prompt.trim();
    if (trimmed === "Implement the plan.") {
      return "Sent the plan to Codex.";
    }
    return trimmed.length > 160 ? "Sent the prompt to Codex." : `Sent ${trimmed} to Codex.`;
  }

  private async resolveProjectFolder(worktreeFolder?: string): Promise<string | undefined> {
    const cwd = worktreeFolder?.trim();
    if (!cwd) {
      return undefined;
    }
    try {
      const result = await execFileAsync(
        "git",
        ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { timeout: 5_000 },
      );
      const commonDir = result.stdout.trim();
      if (!commonDir) {
        return cwd;
      }
      return path.dirname(commonDir);
    } catch {
      return cwd;
    }
  }

  private async unbindConversation(conversation: ConversationTarget): Promise<void> {
    const binding = this.store.getBinding(conversation);
    if (binding?.pinnedBindingMessage) {
      await this.unpinStoredBindingMessage(binding);
    }
    await this.store.removeBinding(conversation);
  }

  private async reconcileBindings(): Promise<void> {
    return;
  }

  private async startTypingLease(conversation: ConversationTarget): Promise<{
    stop: () => void;
  } | null> {
    if (isTelegramChannel(conversation.channel)) {
      return await this.api.runtime.channel.telegram.typing.start({
        to: conversation.parentConversationId ?? conversation.conversationId,
        accountId: conversation.accountId,
        messageThreadId: conversation.threadId,
      });
    }
    if (isDiscordChannel(conversation.channel)) {
      if (conversation.conversationId.startsWith("user:")) {
        return null;
      }
      const channelId =
        denormalizeDiscordConversationId(conversation.conversationId) ?? conversation.conversationId;
      return await this.api.runtime.channel.discord.typing.start({
        channelId,
        accountId: conversation.accountId,
      });
    }
    return null;
  }

  private async sendText(
    conversation: ConversationTarget,
    text: string,
    opts?: { buttons?: PluginInteractiveButtons },
  ): Promise<void> {
    await this.sendReply(conversation, {
      text,
      buttons: opts?.buttons,
    });
  }

  private async sendTextWithDeliveryRef(
    conversation: ConversationTarget,
    text: string,
  ): Promise<DeliveredMessageRef | null> {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }
    if (isTelegramChannel(conversation.channel)) {
      const limit = this.api.runtime.channel.text.resolveTextChunkLimit(
        undefined,
        "telegram",
        conversation.accountId,
        { fallbackLimit: 4000 },
      );
      const chunks = this.api.runtime.channel.text.chunkText(trimmed, limit).filter(Boolean);
      const textChunks = chunks.length > 0 ? chunks : [trimmed];
      let firstDelivered: DeliveredMessageRef | null = null;
      for (const chunk of textChunks) {
        const result = await this.api.runtime.channel.telegram.sendMessageTelegram(
          conversation.parentConversationId ?? conversation.conversationId,
          chunk,
          {
            accountId: conversation.accountId,
            messageThreadId: conversation.threadId,
          },
        );
        if (!firstDelivered) {
          firstDelivered = {
            provider: "telegram",
            messageId: result.messageId,
            chatId: result.chatId,
          };
        }
      }
      return firstDelivered;
    }
    if (isDiscordChannel(conversation.channel)) {
      const limit = this.api.runtime.channel.text.resolveTextChunkLimit(
        undefined,
        "discord",
        conversation.accountId,
        { fallbackLimit: 2000 },
      );
      const chunks = this.api.runtime.channel.text.chunkText(trimmed, limit).filter(Boolean);
      const textChunks = chunks.length > 0 ? chunks : [trimmed];
      let firstDelivered: DeliveredMessageRef | null = null;
      for (const chunk of textChunks) {
        const result = await this.api.runtime.channel.discord.sendMessageDiscord(
          conversation.conversationId,
          chunk,
          {
            accountId: conversation.accountId,
          },
        );
        if (!firstDelivered) {
          firstDelivered = {
            provider: "discord",
            messageId: result.messageId,
            channelId: result.channelId,
          };
        }
      }
      return firstDelivered;
    }
    await this.sendText(conversation, trimmed);
    return null;
  }

  private async pinBindingMessage(
    conversation: ConversationTarget,
    delivered: DeliveredMessageRef | null,
  ): Promise<void> {
    if (!delivered) {
      return;
    }
    const binding = this.store.getBinding(conversation);
    if (!binding) {
      return;
    }
    if (binding.pinnedBindingMessage) {
      await this.unpinStoredBindingMessage(binding).catch(() => undefined);
    }
    try {
      if (delivered.provider === "telegram") {
        const token = await this.resolveTelegramBotToken(conversation.accountId);
        if (!token) {
          this.api.logger.debug?.(
            `codex telegram pin skipped ${this.formatConversationForLog(conversation)} reason=no-token`,
          );
          return;
        }
        await this.callTelegramPinApi("pinChatMessage", token, {
          chat_id: delivered.chatId,
          message_id: Number(delivered.messageId),
          disable_notification: true,
        });
      } else {
        const token = await this.resolveDiscordBotToken(conversation.accountId);
        if (!token) {
          this.api.logger.debug?.(
            `codex discord pin skipped ${this.formatConversationForLog(conversation)} reason=no-token`,
          );
          return;
        }
        await this.callDiscordPinApi("pin", token, delivered.channelId, delivered.messageId);
      }
      await this.store.upsertBinding({
        ...binding,
        pinnedBindingMessage: delivered,
        updatedAt: Date.now(),
      });
    } catch (error) {
      this.api.logger.warn(`codex binding message pin failed: ${String(error)}`);
    }
  }

  private async unpinStoredBindingMessage(binding: StoredBinding): Promise<void> {
    const pinned = binding.pinnedBindingMessage;
    if (!pinned) {
      return;
    }
    try {
      if (pinned.provider === "telegram") {
        const token = await this.resolveTelegramBotToken(binding.conversation.accountId);
        if (!token) {
          this.api.logger.debug?.(
            `codex telegram unpin skipped conversation=${binding.conversation.conversationId} reason=no-token`,
          );
          return;
        }
        await this.callTelegramPinApi("unpinChatMessage", token, {
          chat_id: pinned.chatId,
          message_id: Number(pinned.messageId),
        });
      } else {
        const token = await this.resolveDiscordBotToken(binding.conversation.accountId);
        if (!token) {
          this.api.logger.debug?.(
            `codex discord unpin skipped conversation=${binding.conversation.conversationId} reason=no-token`,
          );
          return;
        }
        await this.callDiscordPinApi("unpin", token, pinned.channelId, pinned.messageId);
      }
    } catch (error) {
      this.api.logger.warn(`codex binding message unpin failed: ${String(error)}`);
    }
  }

  private async resolveTelegramBotToken(accountId?: string): Promise<string | undefined> {
    const resolution = this.api.runtime.channel.telegram.resolveTelegramToken?.(
      this.lastRuntimeConfig,
      { accountId },
    );
    const token = resolution?.token?.trim();
    return token || undefined;
  }

  private async resolveDiscordBotToken(accountId?: string): Promise<string | undefined> {
    const cfg = this.lastRuntimeConfig;
    if (!cfg) {
      return undefined;
    }
    const account = resolveDiscordAccount({
      cfg: cfg as Parameters<typeof resolveDiscordAccount>[0]["cfg"],
      accountId,
    });
    const token = account.token?.trim();
    return token || undefined;
  }

  private async callDiscordPinApi(
    action: "pin" | "unpin",
    token: string,
    channelId: string,
    messageId: string,
  ): Promise<void> {
    const response = await fetch(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/pins/${encodeURIComponent(messageId)}`,
      {
        method: action === "pin" ? "PUT" : "DELETE",
        headers: {
          Authorization: `Bot ${token}`,
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        `Discord ${action} failed status=${response.status} body=${await response.text()}`,
      );
    }
  }

  private async callTelegramPinApi(
    method: "pinChatMessage" | "unpinChatMessage",
    token: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `Telegram ${method} failed status=${response.status} body=${await response.text()}`,
      );
    }
  }

  private async renameConversationIfSupported(
    conversation: ConversationTarget,
    name: string,
  ): Promise<void> {
    if (isTelegramChannel(conversation.channel) && conversation.threadId != null) {
      await this.api.runtime.channel.telegram.conversationActions.renameTopic(
        conversation.parentConversationId ?? conversation.conversationId,
        conversation.threadId,
        name,
        {
          accountId: conversation.accountId,
        },
      ).catch((error) => {
        this.api.logger.warn(`codex telegram topic rename failed: ${String(error)}`);
      });
      return;
    }
    if (isDiscordChannel(conversation.channel)) {
      await this.api.runtime.channel.discord.conversationActions.editChannel(
        conversation.conversationId,
        {
          name,
        },
        {
          accountId: conversation.accountId,
        },
      ).catch((error) => {
        this.api.logger.warn(`codex discord channel rename failed: ${String(error)}`);
      });
    }
  }
}
