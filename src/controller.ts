import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  PluginCommandContext,
  PluginInteractiveButtons,
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveTelegramHandlerContext,
  ReplyPayload,
  ConversationRef,
} from "openclaw/plugin-sdk";
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
import {
  buildPendingQuestionnaireResponse,
  formatPendingQuestionnairePrompt,
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
  type StoredPendingRequest,
} from "./types.js";

type ActiveRunRecord = {
  conversation: ConversationTarget;
  workspaceDir: string;
  handle: ActiveCodexRun;
};

const execFileAsync = promisify(execFile);

type PickerRender = {
  text: string;
  buttons: PluginInteractiveButtons | undefined;
};

type PickerResponders = {
  conversation: ConversationTarget;
  clear: () => Promise<void>;
  reply: (text: string) => Promise<void>;
  editPicker: (picker: PickerRender) => Promise<void>;
};

type FollowUpSummary = {
  initialReply: ReplyPayload;
  followUps: string[];
};

type PlanDelivery = {
  summaryText: string;
  attachmentPath?: string;
  attachmentFallbackText?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  if (trimmed.startsWith("discord:")) {
    return trimmed.slice("discord:".length);
  }
  return trimmed;
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
    const conversationId = normalizeDiscordConversationId(ctx.to ?? ctx.from);
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
}): ConversationTarget | null {
  if (!event.accountId || !event.conversationId) {
    return null;
  }
  return {
    channel: event.channel.trim().toLowerCase(),
    accountId: event.accountId,
    conversationId: event.conversationId,
    parentConversationId: event.parentConversationId,
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
  return { error: "Usage: /codex_fast [on|off|status]" };
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

function parseRenameArgs(args: string): { syncTopic: boolean; name: string } | null {
  const tokens = args
    .replace(/(^|\s)[\u2010-\u2015\u2212](?=\S)/g, "$1--")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
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
  return projectName ? `${threadName} (${projectName})` : threadName;
}

function truncateDiscordLabel(text: string, maxChars = 80): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

export class CodexPluginController {
  private readonly settings;
  private readonly client;
  private readonly activeRuns = new Map<string, ActiveRunRecord>();
  private readonly threadChangesCache = new Map<string, Promise<boolean | undefined>>();
  private readonly store;
  private serviceWorkspaceDir?: string;
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
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    await this.store.load();
    await this.reconcileBindings();
    this.started = true;
  }

  async handleInboundClaim(event: {
    content: string;
    channel: string;
    accountId?: string;
    conversationId?: string;
    parentConversationId?: string;
    threadId?: string | number;
  }): Promise<{ handled: boolean }> {
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
      const handled = await active.handle.queueMessage(event.content);
      return { handled };
    }
    const binding = this.store.getBinding(conversation);
    if (!binding) {
      return { handled: false };
    }
    await this.startTurn({
      conversation,
      binding,
      workspaceDir: binding.workspaceDir,
      prompt: event.content,
      reason: "inbound",
    });
    return { handled: true };
  }

  async handleTelegramInteractive(ctx: PluginInteractiveTelegramHandlerContext): Promise<void> {
    await this.start();
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
    });
  }

  async handleDiscordInteractive(ctx: PluginInteractiveDiscordHandlerContext): Promise<void> {
    await this.start();
    const callback = this.store.getCallback(ctx.interaction.payload);
    if (!callback) {
      await ctx.respond.reply({ text: "That Codex action expired. Please retry the command.", ephemeral: true });
      return;
    }
    await this.dispatchCallbackAction(callback, {
      conversation: {
        channel: "discord",
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
        parentConversationId: ctx.parentConversationId,
      },
      clear: async () => {
        await ctx.respond.clearComponents().catch(() => undefined);
      },
      reply: async (text) => {
        await ctx.respond.reply({ text, ephemeral: true });
      },
      editPicker: async (picker) => {
        await ctx.respond.editMessage({
          text: picker.text,
          components: this.toDiscordComponents(picker.buttons),
        });
      },
    });
  }

  async handleCommand(commandName: string, ctx: PluginCommandContext): Promise<ReplyPayload> {
    await this.start();
    const conversation = toConversationTargetFromCommand(ctx);
    const binding = conversation ? this.store.getBinding(conversation) : null;
    const args = ctx.args?.trim() ?? "";

    switch (commandName) {
      case "codex_resume":
        return await this.handleJoinCommand(conversation, binding, args, ctx.channel);
      case "codex_detach":
        if (!conversation) {
          return { text: "This command needs a Telegram or Discord conversation." };
        }
        await this.unbindConversation(conversation);
        return { text: "Detached this conversation from Codex." };
      case "codex_status":
        return await this.handleStatusCommand(binding);
      case "codex_stop":
        return await this.handleStopCommand(conversation);
      case "codex_steer":
        return await this.handleSteerCommand(conversation, args);
      case "codex_plan":
        return await this.handlePlanCommand(conversation, binding, args);
      case "codex_review":
        return await this.handleReviewCommand(conversation, binding, args);
      case "codex_compact":
        return await this.handleCompactCommand(conversation, binding);
      case "codex_skills":
        return await this.handleSkillsCommand(conversation, binding, args);
      case "codex_experimental":
        return await this.handleExperimentalCommand(binding);
      case "codex_mcp":
        return await this.handleMcpCommand(binding, args);
      case "codex_fast":
        return await this.handleFastCommand(binding, args);
      case "codex_model":
        return await this.handleModelCommand(conversation, binding, args);
      case "codex_permissions":
        return await this.handlePermissionsCommand(binding);
      case "codex_init":
        return await this.handlePromptAlias(conversation, binding, args, "/init");
      case "codex_diff":
        return await this.handlePromptAlias(conversation, binding, args, "/diff");
      case "codex_rename":
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
  ): Promise<ReplyPayload> {
    if (!conversation) {
      return { text: "This command needs a Telegram or Discord conversation." };
    }
    const parsed = parseThreadSelectionArgs(args);
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
    await this.bindConversation(conversation, {
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
    });
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
    const summary = await this.buildBoundConversationSummaryReply(conversation);
    this.queueFollowUpTexts(conversation, summary.followUps);
    return summary.initialReply;
  }

  private async handleStatusCommand(binding: StoredBinding | null): Promise<ReplyPayload> {
    return {
      text: await this.buildStatusText(binding),
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
      return { text: "Usage: /codex_steer <message>" };
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
    const prompt = args.trim();
    if (!prompt) {
      return { text: "Usage: /codex_plan <goal>" };
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
      return { text: "Usage: /codex_rename [--sync] <new name>" };
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

  private async startTurn(params: {
    conversation: ConversationTarget;
    binding: StoredBinding | null;
    workspaceDir: string;
    prompt: string;
    reason: "command" | "inbound" | "plan";
  }): Promise<void> {
    const key = buildConversationKey(params.conversation);
    const existing = this.activeRuns.get(key);
    if (existing) {
      await existing.handle.queueMessage(params.prompt);
      return;
    }
    const typing = await this.startTypingLease(params.conversation);
    const run = this.client.startTurn({
      sessionKey: params.binding?.sessionKey,
      workspaceDir: params.workspaceDir,
      prompt: params.prompt,
      runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      existingThreadId: params.binding?.threadId,
      model: this.settings.defaultModel,
      onPendingInput: async (state) => {
        await this.handlePendingInputState(params.conversation, params.workspaceDir, state, run);
      },
      onInterrupted: async () => {
        await this.sendText(params.conversation, "Codex stopped.");
      },
    });
    this.activeRuns.set(key, {
      conversation: params.conversation,
      workspaceDir: params.workspaceDir,
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
        await this.sendText(params.conversation, formatTurnCompletion(result));
      })
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error);
        await this.sendText(params.conversation, `Codex failed: ${message}`);
      })
      .finally(async () => {
        typing?.stop();
        this.activeRuns.delete(key);
        const pending = this.store.getPendingRequestByConversation(params.conversation);
        if (pending) {
          await this.store.removePendingRequest(pending.requestId);
        }
      });
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
    const progressTimer = setTimeout(() => {
      void (async () => {
        if (keepaliveSent) {
          return;
        }
        keepaliveSent = true;
        await this.sendText(params.conversation, "Codex is still planning...");
      })();
    }, PLAN_PROGRESS_DELAY_MS);
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
            prompt: `Please implement this plan:\n\n${result.planArtifact.markdown.trim()}`,
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
        clearTimeout(progressTimer);
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
    const progressTimer = setTimeout(() => {
      void (async () => {
        if (keepaliveSent) {
          return;
        }
        keepaliveSent = true;
        await this.sendText(params.conversation, "Codex is still reviewing...");
      })();
    }, REVIEW_PROGRESS_DELAY_MS);
    const run = this.client.startReview({
      sessionKey: params.binding.sessionKey,
      workspaceDir: params.workspaceDir,
      threadId: params.binding.threadId,
      runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      target: params.target,
      onPendingInput: async (state) => {
        await this.handlePendingInputState(params.conversation, params.workspaceDir, state, run);
      },
      onInterrupted: async () => {
        await this.sendText(params.conversation, "Codex review stopped.");
      },
    });
    this.activeRuns.set(key, {
      conversation: params.conversation,
      workspaceDir: params.workspaceDir,
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
        clearTimeout(progressTimer);
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
      await this.store.upsertPendingRequest({
        requestId: state.requestId,
        conversation,
        threadId: run.getThreadId() ?? this.store.getBinding(conversation)?.threadId ?? "",
        workspaceDir,
        state,
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
    await this.store.upsertPendingRequest({
      requestId: state.requestId,
      conversation,
      threadId: run.getThreadId() ?? this.store.getBinding(conversation)?.threadId ?? "",
      workspaceDir,
      state,
      updatedAt: Date.now(),
    });
    await this.sendText(conversation, state.promptText ?? "Codex needs input.", { buttons });
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
    if (questionnaire.currentIndex < questionnaire.questions.length - 1) {
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
        buildPendingQuestionnaireResponse(questionnaire),
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
    params.buttons.push([
      {
        text: params.projectName ? "Projects" : "Browse Projects",
        callback_data: `${INTERACTIVE_NAMESPACE}:${projects.token}`,
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
    const { workspaceDir, threads } = await this.listPickerThreads(binding, {
      parsed,
      projectName,
    });
    const pageResult = paginateItems(threads, page);
    const distinctProjects = new Set(
      threads.map((thread) => getProjectName(thread.projectKey)).filter(Boolean),
    );
    const threadButtons =
      (await this.buildThreadPickerButtons({
      conversation,
      syncTopic: parsed.syncTopic,
      threads: pageResult.items,
      showProjectName: !projectName && distinctProjects.size > 1,
      })) ?? [];
    return {
      text: formatThreadPickerIntro({
        page: pageResult.page,
        totalPages: pageResult.totalPages,
        totalItems: pageResult.totalItems,
        includeAll: workspaceDir == null,
        syncTopic: parsed.syncTopic,
        workspaceDir,
        projectName,
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
    buttons.push([
      {
        text: "Recent Sessions",
        callback_data: `${INTERACTIVE_NAMESPACE}:${recent.token}`,
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

  private toDiscordComponents(buttons: PluginInteractiveButtons | undefined): unknown[] | undefined {
    if (!buttons || buttons.length === 0) {
      return undefined;
    }
    return buttons.map((row) => ({
      type: 1,
      components: row.map((button) => ({
        type: 2,
        style: 1,
        label: truncateDiscordLabel(button.text),
        custom_id: button.callback_data,
      })),
    }));
  }

  private async sendDiscordPicker(
    conversation: ConversationTarget,
    picker: PickerRender,
  ): Promise<void> {
    await this.api.runtime.channel.discord.sendComponentMessage(
      conversation.conversationId,
      {
        text: picker.text,
        blocks: (picker.buttons ?? []).map((row) => ({
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
  }

  private async dispatchCallbackAction(
    callback: CallbackAction,
    responders: PickerResponders,
  ): Promise<void> {
    if (callback.kind === "resume-thread") {
      await responders.clear().catch(() => undefined);
      const threadState = await this.client
        .readThreadState({
          sessionKey: buildPluginSessionKey(callback.threadId),
          threadId: callback.threadId,
        })
        .catch(() => undefined);
      await this.bindConversation(callback.conversation, {
        threadId: callback.threadId,
        workspaceDir: threadState?.cwd?.trim() || callback.workspaceDir,
        threadTitle: threadState?.threadName,
      });
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
      if (!pending || pending.state.expiresAt <= Date.now()) {
        await this.store.removeCallback(callback.token);
        await responders.reply("That Codex request expired. Please retry.");
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
      await responders.reply("Sent to Codex.");
      return;
    }
    if (callback.kind === "pending-questionnaire") {
      const pending = this.store.getPendingRequestById(callback.requestId);
      if (!pending || pending.state.expiresAt <= Date.now() || !pending.state.questionnaire) {
        await this.store.removeCallback(callback.token);
        await responders.reply("That Codex questionnaire expired. Please retry.");
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
          buildPendingQuestionnaireResponse(questionnaire),
        );
        if (!submitted) {
          await responders.reply("That Codex questionnaire is no longer accepting answers.");
          return;
        }
        await responders.clear().catch(() => undefined);
        await this.store.removePendingRequest(pending.requestId);
        await responders.reply("Recorded your answers and sent them to Codex.");
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
      if (active) {
        const handled = await active.handle.queueMessage(callback.prompt);
        if (handled) {
          await responders.reply(`Sent ${callback.prompt} to Codex.`);
          return;
        }
      }
      await this.startTurn({
        conversation,
        binding,
        workspaceDir,
        prompt: callback.prompt,
        reason: "command",
      });
      await responders.reply(`Sent ${callback.prompt} to Codex.`);
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
      contextUsage: this.store.getBinding(conversation)?.contextUsage,
      updatedAt: Date.now(),
    };
    const existing = this.api.runtime.channel.bindings.resolveByConversation(record.conversation);
    if (!existing) {
      try {
        await this.api.runtime.channel.bindings.bind({
          targetSessionKey: sessionKey,
          targetKind: "session",
          conversation: record.conversation,
          placement: "current",
          metadata: {
            pluginId: PLUGIN_ID,
            threadId: params.threadId,
            workspaceDir: params.workspaceDir,
          },
        });
      } catch (error) {
        this.api.logger.warn(`codex binding bridge bind failed: ${String(error)}`);
      }
    }
    await this.store.upsertBinding(record);
    return record;
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
    for (const message of messages) {
      await this.sendText(target, message);
    }
  }

  private async buildBoundConversationSummaryReply(
    conversation: ConversationTarget | ConversationRef,
  ): Promise<FollowUpSummary> {
    const messages = await this.buildBoundConversationMessages(conversation);
    const [firstMessage, ...followUps] = messages;
    return {
      initialReply: buildPlainReply(firstMessage ?? "Codex thread bound."),
      followUps,
    };
  }

  private queueFollowUpTexts(conversation: ConversationTarget, texts: string[]): void {
    if (texts.length === 0) {
      return;
    }
    setTimeout(() => {
      void (async () => {
        for (const text of texts) {
          await this.sendText(conversation, text);
        }
      })().catch((error) => {
        this.api.logger.warn(`codex follow-up send failed: ${String(error)}`);
      });
    }, 0);
  }

  private async buildStatusText(binding: StoredBinding | null): Promise<string> {
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

    return formatCodexStatusText({
      threadState,
      account,
      rateLimits: limits,
      bindingActive: Boolean(binding),
      projectFolder,
      worktreeFolder: threadState?.cwd?.trim() || binding?.workspaceDir || workspaceDir,
      contextUsage: binding?.contextUsage,
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
    if (isTelegramChannel(conversation.channel)) {
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
      return true;
    }
    if (isDiscordChannel(conversation.channel)) {
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
        const finalChunk = chunks.pop() ?? text;
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
        return true;
      }
      const textChunks = chunks.length > 0 ? chunks : [text];
      for (const chunk of textChunks) {
        if (!chunk) {
          continue;
        }
        await this.api.runtime.channel.discord.sendMessageDiscord(conversation.conversationId, chunk, {
          accountId: conversation.accountId,
        });
      }
      return true;
    }
    return false;
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
    if (binding) {
      await this.api.runtime.channel.bindings
        .unbind({
          targetSessionKey: binding.sessionKey,
          reason: "plugin-detach",
        })
        .catch(() => undefined);
    }
    await this.store.removeBinding(conversation);
  }

  private async reconcileBindings(): Promise<void> {
    for (const binding of this.store.listBindings()) {
      try {
        await this.client.readThreadState({
          sessionKey: binding.sessionKey,
          threadId: binding.threadId,
        });
      } catch (error) {
        if (isMissingThreadError(error)) {
          await this.store.removeBinding(binding.conversation);
          continue;
        }
      }
      const existing = this.api.runtime.channel.bindings.resolveByConversation(binding.conversation);
      if (existing?.targetSessionKey === binding.sessionKey) {
        continue;
      }
      try {
        await this.api.runtime.channel.bindings.bind({
          targetSessionKey: binding.sessionKey,
          targetKind: "session",
          conversation: binding.conversation,
          placement: "current",
          metadata: {
            pluginId: PLUGIN_ID,
            threadId: binding.threadId,
            workspaceDir: binding.workspaceDir,
          },
        });
      } catch (error) {
        this.api.logger.warn(`codex binding reconcile failed: ${String(error)}`);
      }
    }
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
      return await this.api.runtime.channel.discord.typing.start({
        channelId: conversation.conversationId,
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
