import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
  PluginConversationBindingResolvedEvent,
  OpenClawPluginApi,
  OpenClawPluginService,
  PluginCommandContext,
  PluginInboundMedia,
  PluginInteractiveButtons,
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveTelegramHandlerContext,
  ReplyPayload,
  ConversationRef,
} from "openclaw/plugin-sdk";
import { resolvePluginSettings, resolveWorkspaceDir } from "./config.js";
import { CodexAppServerModeClient, type ActiveCodexRun, isMissingThreadError } from "./client.js";
import { getThreadDisplayTitle } from "./thread-display.js";
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
  formatSkillHelpText,
  formatSkillsPickerText,
  filterSkillsByQuery,
  formatMcpServers,
  formatModels,
  parseCodexReviewOutput,
  formatProjectPickerIntro,
  formatReviewCompletion,
  formatSkills,
  formatThreadButtonLabel,
  formatThreadPickerIntro,
  formatTurnCompletion,
} from "./format.js";
import {
  formatReasoningEffortLabel,
  getSupportedReasoningEfforts,
  modelSupportsFast,
  normalizeReasoningEffort,
  REASONING_EFFORT_OPTIONS,
} from "./model-capabilities.js";
import { formatCommandUsage, renderCommandHelpText } from "./help.js";
import type {
  AccountSummary,
  CollaborationMode,
  CodexTurnInputItem,
  ConversationPreferences,
  InteractiveMessageRef,
  PermissionsMode,
  ThreadState,
  TurnTerminalError,
} from "./types.js";
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
  expandHomeDir,
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
import {
  loadOpenClawCompatModule,
  resolveOpenClawEntrypointPath,
  resolveCompatFallbackPath,
} from "./openclaw-sdk-compat.js";

type DiscordSdkModule = typeof import("openclaw/plugin-sdk/discord");
type TelegramAccountSdkModule = typeof import("openclaw/plugin-sdk/telegram-account");
type DiscordComponentMessageSpec = import("openclaw/plugin-sdk/discord").DiscordComponentMessageSpec;
type DiscordComponentBuildResult = ReturnType<DiscordSdkModule["buildDiscordComponentMessage"]>;
type DiscordExtensionApiModule = {
  resolveDiscordAccount?: (params: { cfg: unknown; accountId?: string }) => {
    token?: string;
  };
};
type DiscordRuntimeApiModule = {
  editDiscordComponentMessage?: (
    to: string,
    messageId: string,
    spec: DiscordComponentMessageSpec,
    opts?: {
      cfg?: unknown;
      accountId?: string;
    },
  ) => Promise<{ messageId: string; channelId: string }>;
  registerBuiltDiscordComponentMessage?: (params: {
    buildResult: DiscordComponentBuildResult;
    messageId: string;
  }) => void;
  sendDiscordComponentMessage?: (
    to: string,
    spec: DiscordComponentMessageSpec,
    opts?: {
      cfg?: unknown;
      accountId?: string;
      mediaUrl?: string;
      mediaLocalRoots?: readonly string[];
    },
  ) => Promise<{ messageId: string; channelId: string }>;
  sendMessageDiscord?: (
    to: string,
    text: string,
    opts?: {
      cfg?: unknown;
      accountId?: string;
      mediaUrl?: string;
      mediaLocalRoots?: readonly string[];
    },
  ) => Promise<{ messageId: string; channelId: string }>;
  sendTypingDiscord?: (
    channelId: string,
    opts?: {
      cfg?: unknown;
      accountId?: string;
    },
  ) => Promise<unknown>;
  editChannelDiscord?: (
    payload: { channelId: string; name?: string },
    opts?: {
      cfg?: unknown;
      accountId?: string;
    },
  ) => Promise<unknown>;
};

type ActiveRunRecord = {
  conversation: ConversationTarget;
  workspaceDir: string;
  mode: "default" | "plan" | "review";
  profile: PermissionsMode;
  handle: ActiveCodexRun;
};

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const TEXT_ATTACHMENT_FILE_EXTENSIONS = new Set([
  ".json",
  ".log",
  ".markdown",
  ".md",
  ".txt",
  ".yaml",
  ".yml",
]);
const TEXT_ATTACHMENT_MIME_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/x-yaml",
  "application/yaml",
  "text/json",
  "text/markdown",
  "text/plain",
  "text/x-markdown",
  "text/yaml",
]);
const MAX_TEXT_ATTACHMENT_BYTES = 64 * 1024;

type TelegramOutboundAdapter = {
  sendText?: (ctx: {
    cfg: unknown;
    to: string;
    text: string;
    accountId?: string;
    threadId?: string | number;
  }) => Promise<{ messageId: string; chatId?: string }>;
  sendMedia?: (ctx: {
    cfg: unknown;
    to: string;
    text: string;
    mediaUrl: string;
    accountId?: string;
    threadId?: string | number;
    mediaLocalRoots?: readonly string[];
  }) => Promise<{ messageId: string; chatId?: string }>;
  sendPayload?: (ctx: {
    cfg: unknown;
    to: string;
    payload: ReplyPayload;
    accountId?: string;
    threadId?: string | number;
    mediaLocalRoots?: readonly string[];
  }) => Promise<{ messageId: string; chatId?: string }>;
};

type DiscordOutboundAdapter = {
  sendText?: (ctx: {
    cfg: unknown;
    to: string;
    text: string;
    accountId?: string;
    threadId?: string | number;
  }) => Promise<{ messageId: string; channelId?: string }>;
  sendMedia?: (ctx: {
    cfg: unknown;
    to: string;
    text: string;
    mediaUrl: string;
    accountId?: string;
    threadId?: string | number;
    mediaLocalRoots?: readonly string[];
  }) => Promise<{ messageId: string; channelId?: string }>;
  sendPayload?: (ctx: {
    cfg: unknown;
    to: string;
    payload: ReplyPayload;
    accountId?: string;
    threadId?: string | number;
    mediaLocalRoots?: readonly string[];
  }) => Promise<{ messageId: string; channelId?: string }>;
};
const MAX_TEXT_ATTACHMENT_CHARS = 16_000;
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

function getSkillsPickerPageSize(channel: string): number {
  return channel === "discord" ? 6 : 8;
}

function dedupeSkillsByName(skills: import("./types.js").SkillSummary[]): import("./types.js").SkillSummary[] {
  const seen = new Set<string>();
  const deduped = [];
  for (const skill of skills) {
    const key = skill.name.trim().toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(skill);
  }
  return deduped;
}

type PickerRender = {
  text: string;
  buttons: PluginInteractiveButtons | undefined;
};

type StatusCardRender = {
  text: string;
  buttons?: PluginInteractiveButtons;
};

type DesiredThreadConfiguration = {
  effectiveState: ThreadState | undefined;
  model?: string;
  reasoningEffort?: ReturnType<typeof normalizeReasoningEffort>;
  serviceTier: string | null;
  approvalPolicy?: string;
  sandbox?: string;
};

type PickerResponders = {
  conversation: ConversationTarget;
  sourceMessage?: InteractiveMessageRef;
  acknowledge?: () => Promise<void>;
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
  detachConversationBinding?: () => Promise<{ removed: boolean }>;
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

type DeliveredMessageRef = InteractiveMessageRef;

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

const IMAGE_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".heic",
  ".heif",
  ".avif",
]);

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

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function normalizeInboundMediaPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("file://")) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return undefined;
    }
  }
  return trimmed;
}

function isImageMimeType(value: string | undefined): boolean {
  return Boolean(value?.trim().toLowerCase().startsWith("image/"));
}

function normalizeMimeType(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.split(";", 1)[0]?.trim() || undefined;
}

function isImagePathLike(value: string | undefined): boolean {
  const normalized = normalizeInboundMediaPath(value);
  if (!normalized) {
    return false;
  }
  return IMAGE_FILE_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function isTextAttachmentMimeType(value: string | undefined): boolean {
  const normalized = normalizeMimeType(value);
  return Boolean(
    normalized &&
      (normalized.startsWith("text/") || TEXT_ATTACHMENT_MIME_TYPES.has(normalized)),
  );
}

function isTextAttachmentPathLike(value: string | undefined): boolean {
  const normalized = normalizeInboundMediaPath(value);
  if (!normalized || isUrlLike(normalized)) {
    return false;
  }
  return TEXT_ATTACHMENT_FILE_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function isUrlLike(value: string | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed && /^(https?:|data:|file:)/i.test(trimmed));
}

function extractInboundMetadataMedia(metadata?: Record<string, unknown>): PluginInboundMedia[] {
  if (!metadata) {
    return [];
  }
  const mediaPaths = asStringArray(metadata.mediaPaths).concat(asStringArray(metadata.mediaPath));
  const mediaTypes = asStringArray(metadata.mediaTypes).concat(asStringArray(metadata.mediaType));
  const count = Math.max(mediaPaths.length, mediaTypes.length);
  const results: PluginInboundMedia[] = [];
  for (let index = 0; index < count; index += 1) {
    const mediaPath = mediaPaths[index];
    const mimeType = mediaTypes[index] ?? mediaTypes[0];
    if (!mediaPath && !mimeType) {
      continue;
    }
    const normalizedPath = normalizeInboundMediaPath(mediaPath);
    results.push({
      kind:
        isImageMimeType(mimeType) || isImagePathLike(normalizedPath)
          ? "image"
          : "document",
      ...(isUrlLike(normalizedPath)
        ? { url: normalizedPath }
        : normalizedPath
          ? { path: normalizedPath }
          : {}),
      ...(mimeType ? { mimeType } : {}),
      source: "metadata",
    });
  }
  return results;
}

function toCodexImageInputItem(media: PluginInboundMedia): CodexTurnInputItem | null {
  if (
    media.kind !== "image" &&
    !isImageMimeType(media.mimeType) &&
    !isImagePathLike(media.path) &&
    !isImagePathLike(media.url)
  ) {
    return null;
  }
  const normalizedPath = normalizeInboundMediaPath(media.path ?? media.url);
  if (normalizedPath && path.isAbsolute(normalizedPath)) {
    return { type: "localImage", path: normalizedPath };
  }
  const urlCandidate = media.url?.trim() || normalizedPath;
  if (urlCandidate && isUrlLike(urlCandidate)) {
    return { type: "image", url: urlCandidate };
  }
  return null;
}

async function toCodexTextAttachmentInputItem(
  media: PluginInboundMedia,
): Promise<CodexTurnInputItem | null> {
  if (
    media.kind === "image" ||
    !(
      isTextAttachmentMimeType(media.mimeType) ||
      isTextAttachmentPathLike(media.path) ||
      isTextAttachmentPathLike(media.url)
    )
  ) {
    return null;
  }
  const normalizedPath = normalizeInboundMediaPath(media.path ?? media.url);
  if (!normalizedPath || !path.isAbsolute(normalizedPath)) {
    return null;
  }
  const stats = await fs.stat(normalizedPath).catch(() => undefined);
  if (!stats?.isFile()) {
    return null;
  }
  const bytesToRead = Math.min(stats.size, MAX_TEXT_ATTACHMENT_BYTES);
  const handle = await fs.open(normalizedPath, "r").catch(() => undefined);
  if (!handle) {
    return null;
  }
  let rawContent = "";
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    rawContent = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
  const normalizedContent = rawContent.replace(/\r\n/g, "\n");
  const truncatedByBytes = stats.size > MAX_TEXT_ATTACHMENT_BYTES;
  const truncatedByChars = normalizedContent.length > MAX_TEXT_ATTACHMENT_CHARS;
  const content =
    truncatedByChars
      ? normalizedContent.slice(0, MAX_TEXT_ATTACHMENT_CHARS)
      : normalizedContent;
  const displayName =
    media.fileName?.trim() || path.basename(normalizedPath) || "attached-file.txt";
  const mimeType = normalizeMimeType(media.mimeType);
  const lines = [`Attached file: ${displayName}`];
  if (mimeType) {
    lines.push(`Content-Type: ${mimeType}`);
  }
  lines.push("", content.trim().length > 0 ? content : "[File is empty]");
  if (truncatedByBytes || truncatedByChars) {
    lines.push("", "[Truncated]");
  }
  return { type: "text", text: lines.join("\n") };
}

async function buildInboundTurnInput(event: {
  content: string;
  media?: PluginInboundMedia[];
  metadata?: Record<string, unknown>;
}): Promise<CodexTurnInputItem[]> {
  const items: CodexTurnInputItem[] = [];
  if (event.content.trim()) {
    items.push({ type: "text", text: event.content });
  }
  const seen = new Set<string>();
  for (const media of [...(event.media ?? []), ...extractInboundMetadataMedia(event.metadata)]) {
    const item = toCodexImageInputItem(media) ?? (await toCodexTextAttachmentInputItem(media));
    if (!item) {
      continue;
    }
    const key =
      item.type === "localImage"
        ? `${item.type}:${item.path}`
        : item.type === "image"
          ? `${item.type}:${item.url}`
          : `${item.type}:${item.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    items.push(item);
  }
  return items;
}

function isQueueCompatibleTurnInput(
  prompt: string,
  input: readonly CodexTurnInputItem[] | undefined,
): boolean {
  if (!input?.length) {
    return true;
  }
  return input.length === 1 && input[0]?.type === "text" && input[0].text === prompt;
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

function buildTelegramReplyMarkup(buttons?: PluginInteractiveButtons): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | undefined {
  if (!buttons || buttons.length === 0) {
    return undefined;
  }
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((button) => ({
        text: button.text,
        callback_data: button.callback_data,
      })),
    ),
  };
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
  return { error: formatCommandUsage("cas_fast") };
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

function normalizePreferenceServiceTier(value: string | undefined | null): string | null {
  const normalized = normalizeServiceTier(value);
  if (!normalized || normalized === "auto" || normalized === "flex") {
    return null;
  }
  return normalized;
}

function requestServiceTierFromPreference(value: string | undefined | null): string | null {
  const normalized = normalizePreferenceServiceTier(value);
  if (!normalized || normalized === "default") {
    return null;
  }
  return normalized;
}

function preferredServiceTierFromRequest(value: string | null): string {
  return normalizePreferenceServiceTier(value) ?? "default";
}

function getPermissionsForMode(profile: PermissionsMode): {
  approvalPolicy: string;
  sandbox: string;
} {
  return profile === "full-access"
    ? { approvalPolicy: "never", sandbox: "danger-full-access" }
    : { approvalPolicy: "on-request", sandbox: "workspace-write" };
}

function normalizePermissionsMode(value?: string | null): PermissionsMode {
  return value === "full-access" ? "full-access" : "default";
}

function getBindingPermissionsMode(binding: StoredBinding | null): PermissionsMode {
  return normalizePermissionsMode(binding?.permissionsMode);
}

function getBindingPendingPermissionsMode(binding: StoredBinding | null): PermissionsMode | null {
  const pending = binding?.pendingPermissionsMode;
  return pending ? normalizePermissionsMode(pending) : null;
}

function applyBindingPreferencesToThreadState(
  threadState: ThreadState | undefined,
  binding: StoredBinding | null,
): ThreadState | undefined {
  if (!threadState && !binding) {
    return undefined;
  }
  const preferredModel = binding?.preferences?.preferredModel?.trim();
  const preferredServiceTier = normalizePreferenceServiceTier(
    binding?.preferences?.preferredServiceTier,
  );
  const preferredReasoningEffort = normalizeReasoningEffort(
    binding?.preferences?.preferredReasoningEffort,
  );
  const permissions = getPermissionsForMode(getBindingPermissionsMode(binding));
  const baseState = threadState ?? {
    threadId: binding?.threadId ?? "",
  };
  const nextState: ThreadState = {
    ...baseState,
    model: preferredModel || baseState.model,
    serviceTier: preferredServiceTier ?? baseState.serviceTier,
    approvalPolicy: permissions.approvalPolicy || baseState.approvalPolicy,
    sandbox: permissions.sandbox || baseState.sandbox,
    reasoningEffort: preferredReasoningEffort || baseState.reasoningEffort,
  };
  const normalizedModel = nextState.model?.trim();
  if (
    normalizedModel &&
    !modelSupportsFast(normalizedModel) &&
    normalizeServiceTier(nextState.serviceTier) === "fast"
  ) {
    nextState.serviceTier = "default";
  }
  return nextState;
}

function buildDesiredThreadConfiguration(
  threadState: ThreadState | undefined,
  binding: StoredBinding | null,
  modelFallback?: string,
): DesiredThreadConfiguration {
  const effectiveState = applyBindingPreferencesToThreadState(threadState, binding) ?? threadState;
  const model = effectiveState?.model?.trim() || modelFallback;
  return {
    effectiveState,
    model,
    reasoningEffort: normalizeReasoningEffort(effectiveState?.reasoningEffort),
    serviceTier: modelSupportsFast(model)
      ? requestServiceTierFromPreference(effectiveState?.serviceTier)
      : null,
    approvalPolicy: effectiveState?.approvalPolicy?.trim(),
    sandbox: effectiveState?.sandbox?.trim(),
  };
}

function formatThreadStateForLog(
  threadState: import("./types.js").ThreadState | undefined,
): string {
  if (!threadState) {
    return "model=<none> tier=<none> approval=<none> sandbox=<none>";
  }
  return [
    `model=${threadState.model?.trim() || "<none>"}`,
    `reasoning=${threadState.reasoningEffort?.trim() || "<none>"}`,
    `tier=${threadState.serviceTier?.trim() || "<none>"}`,
    `approval=${threadState.approvalPolicy?.trim() || "<none>"}`,
    `sandbox=${threadState.sandbox?.trim() || "<none>"}`,
  ].join(" ");
}

function formatBindingPreferencesForLog(binding: StoredBinding | null): string {
  return [
    `prefModel=${binding?.preferences?.preferredModel?.trim() || "<none>"}`,
    `prefReasoning=${binding?.preferences?.preferredReasoningEffort?.trim() || "<none>"}`,
    `prefTier=${binding?.preferences?.preferredServiceTier?.trim() || "<none>"}`,
    `permissionsMode=${binding?.permissionsMode?.trim() || "<none>"}`,
    `pendingPermissions=${binding?.pendingPermissionsMode?.trim() || "<none>"}`,
  ].join(" ");
}

function buildPermissionsUnavailableNote(): string {
  return "Permissions note: Full Access is unavailable in the current Codex Desktop session, so this thread remains in Default mode.";
}

function buildPendingPermissionsMigrationNote(profile: PermissionsMode): string {
  return `Permissions note: ${profile === "full-access" ? "Full Access" : "Default"} will apply after the current Codex turn ends.`;
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

type CommandPreferenceOverrides = {
  requestedModel?: string;
  requestedFast?: boolean;
  requestedYolo?: boolean;
};

function parseStatusArgs(args: string): CommandPreferenceOverrides & { error?: string } {
  const tokens = normalizeOptionDashes(args)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  let requestedModel: string | undefined;
  let requestedFast: boolean | undefined;
  let requestedYolo: boolean | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--fast") {
      requestedFast = true;
      continue;
    }
    if (token === "--no-fast") {
      requestedFast = false;
      continue;
    }
    if (token === "--yolo") {
      requestedYolo = true;
      continue;
    }
    if (token === "--no-yolo") {
      requestedYolo = false;
      continue;
    }
    if (token === "--model") {
      const next = tokens[index + 1]?.trim();
      if (next) {
        requestedModel = next;
        index += 1;
        continue;
      }
      return {
        error: formatCommandUsage("cas_status"),
      };
    }
    return {
      error: formatCommandUsage("cas_status"),
    };
  }
  return {
    requestedModel,
    requestedFast,
    requestedYolo,
  };
}

function hasCommandPreferenceOverrides(overrides: CommandPreferenceOverrides): boolean {
  return (
    typeof overrides.requestedFast === "boolean" ||
    typeof overrides.requestedYolo === "boolean" ||
    Boolean(overrides.requestedModel?.trim())
  );
}

function mergeConversationPreferences(
  existing: ConversationPreferences | undefined,
  updates: Partial<ConversationPreferences>,
): ConversationPreferences | undefined {
  if (Object.keys(updates).length === 0) {
    return existing;
  }
  return {
    ...(existing ?? {
      preferredServiceTier: null,
      updatedAt: Date.now(),
    }),
    ...updates,
    updatedAt: Date.now(),
  };
}

function normalizePreferencesForModel(
  preferences: ConversationPreferences | undefined,
  model: string | undefined,
): ConversationPreferences | undefined {
  if (!preferences) {
    return preferences;
  }
  if (!modelSupportsFast(model) && normalizePreferenceServiceTier(preferences.preferredServiceTier) === "fast") {
    return {
      ...preferences,
      preferredServiceTier: "default",
      updatedAt: Date.now(),
    };
  }
  return preferences;
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

function formatThreadSelectionFlags(parsed: ReturnType<typeof parseThreadSelectionArgs>): string {
  return [
    parsed.includeAll ? "--all" : "",
    parsed.listProjects ? "--projects" : "",
    parsed.startNew ? "--new" : "",
    parsed.syncTopic ? "--sync" : "",
    typeof parsed.requestedFast === "boolean" ? (parsed.requestedFast ? "--fast" : "--no-fast") : "",
    typeof parsed.requestedYolo === "boolean" ? (parsed.requestedYolo ? "--yolo" : "--no-yolo") : "",
    parsed.requestedModel ? `--model ${parsed.requestedModel}` : "",
    parsed.cwd ? `--cwd ${parsed.cwd}` : "",
  ]
    .filter(Boolean)
    .join(" ");
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

type WorkspaceChoice = {
  workspaceDir: string;
  threadCount: number;
  latestUpdatedAt?: number;
};

function listWorkspaceChoices(
  threads: Array<{ projectKey?: string; createdAt?: number; updatedAt?: number }>,
  projectName?: string,
): WorkspaceChoice[] {
  const normalizedProjectName = projectName?.trim().toLowerCase();
  const grouped = new Map<string, WorkspaceChoice>();

  for (const thread of threads) {
    const workspaceDir = thread.projectKey?.trim();
    const threadProjectName = getProjectName(workspaceDir);
    if (!workspaceDir || !threadProjectName) {
      continue;
    }
    if (normalizedProjectName && threadProjectName.toLowerCase() !== normalizedProjectName) {
      continue;
    }
    const existing = grouped.get(workspaceDir);
    const updatedAt = thread.updatedAt ?? thread.createdAt;
    if (!existing) {
      grouped.set(workspaceDir, {
        workspaceDir,
        threadCount: 1,
        latestUpdatedAt: updatedAt,
      });
      continue;
    }
    existing.threadCount += 1;
    existing.latestUpdatedAt = Math.max(existing.latestUpdatedAt ?? 0, updatedAt ?? 0) || undefined;
  }

  return [...grouped.values()]
    .sort((left, right) => {
      const updatedDelta = (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0);
      if (updatedDelta !== 0) {
        return updatedDelta;
      }
      return left.workspaceDir.localeCompare(right.workspaceDir);
    });
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
    this.client = new CodexAppServerModeClient(this.settings, this.api.logger);
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
      permissionsMode: normalizePermissionsMode(pending.permissionsMode),
      preferences: pending.preferences,
    });
    await this.store.removePendingBind(conversation);
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
      await this.sendBoundConversationNotifications(conversation);
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
    media?: PluginInboundMedia[];
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
      const input = await buildInboundTurnInput(event);
      const requiresStructuredInput = !isQueueCompatibleTurnInput(event.content, input);
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
          if (requiresStructuredInput) {
            this.api.logger.debug?.(
              `codex inbound claim restarting active run for structured input conversation=${conversation.conversationId}`,
            );
          } else {
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
        input,
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
    const runtimeConfig = (ctx as { config?: unknown }).config;
    if (runtimeConfig !== undefined) {
      this.lastRuntimeConfig = runtimeConfig;
    }
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
      sourceMessage:
        ctx.callback.messageId != null && ctx.callback.chatId?.trim()
          ? {
              provider: "telegram",
              messageId: String(ctx.callback.messageId),
              chatId: ctx.callback.chatId,
            }
          : undefined,
      acknowledge: async () => {},
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
      detachConversationBinding: bindingApi.detachConversationBinding,
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
        sourceMessage: ctx.interaction.messageId?.trim()
          ? {
              provider: "discord",
              messageId: ctx.interaction.messageId.trim(),
              channelId: conversation.conversationId,
            }
          : undefined,
        acknowledge: async () => {
          if (interactionSettled) {
            return;
          }
          await ctx.respond
            .acknowledge()
            .then(() => {
              interactionSettled = true;
            })
            .catch(() => undefined);
        },
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
            await this.editDiscordComponentMessage(
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
          const builtPicker = await this.tryBuildDiscordPickerMessage(picker);
          try {
            if (!builtPicker) {
              throw new Error("Discord picker rebuild unavailable.");
            }
            await ctx.respond.editMessage({
              components: builtPicker.components,
            });
            interactionSettled = true;
            if (messageId) {
              await this.registerBuiltDiscordComponentMessage({
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
              await this.editDiscordComponentMessage(
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
              await this.editDiscordComponentMessage(
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
        detachConversationBinding: bindingApi.detachConversationBinding,
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
    const normalizedArgs = normalizeOptionDashes(args).trim();
    if (normalizedArgs === "help" || normalizedArgs === "--help") {
      return this.renderCommandHelp(commandName);
    }
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
          args,
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
        return await this.handlePermissionsCommand(
          conversation,
          binding,
          Boolean(currentBinding || binding),
        );
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

  private renderCommandHelp(commandName: string): ReplyPayload {
    return { text: renderCommandHelpText(commandName) };
  }

  private async handleStartNewThreadSelection(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    parsed: ReturnType<typeof parseThreadSelectionArgs>,
    channel: string,
    requestConversationBinding?: PickerResponders["requestConversationBinding"],
  ): Promise<ReplyPayload> {
    if (!conversation) {
      return { text: "This command needs a Telegram or Discord conversation." };
    }
    if (parsed.listProjects || !parsed.query) {
      const picker = await this.renderProjectPicker(conversation, binding, parsed, 0, "start-new-thread");
      if (isDiscordChannel(channel) && picker.buttons) {
        try {
          await this.sendDiscordPicker(conversation, picker);
          return { text: "Sent a Codex project picker to this Discord conversation." };
        } catch (error) {
          this.api.logger.warn(`codex discord picker send failed: ${String(error)}`);
          return { text: picker.text };
        }
      }
      return buildReplyWithButtons(picker.text, picker.buttons);
    }

    const workspaceDir = await this.resolveNewThreadWorkspaceDir(binding, parsed);
    if (!workspaceDir) {
      const picker = await this.renderProjectPicker(conversation, binding, parsed, 0, "start-new-thread");
      if (isDiscordChannel(channel) && picker.buttons) {
        try {
          await this.sendDiscordPicker(conversation, picker);
          return {
            text: `Multiple Codex projects matched "${parsed.query}". Sent a picker to this Discord conversation.`,
          };
        } catch (error) {
          this.api.logger.warn(`codex discord picker send failed: ${String(error)}`);
          return { text: picker.text };
        }
      }
      return buildReplyWithButtons(picker.text, picker.buttons);
    }

    const result = await this.startNewThreadAndBindConversation(
      conversation,
      binding,
      workspaceDir,
      parsed.syncTopic,
      {
        requestedModel: parsed.requestedModel,
        requestedFast: parsed.requestedFast,
        requestedYolo: parsed.requestedYolo,
      },
      requestConversationBinding,
    );
    if (result.status === "pending") {
      return result.reply;
    }
    if (result.status === "error") {
      return { text: result.message };
    }
    return {};
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
    if (parsed.error) {
      return { text: parsed.error };
    }
    if (parsed.requestedYolo && !this.hasFullAccessProfile()) {
      return { text: "Full Access is unavailable in the current Codex Desktop session." };
    }
    if (parsed.requestedFast && parsed.requestedModel && !modelSupportsFast(parsed.requestedModel)) {
      return {
        text: `Fast mode is unavailable for ${parsed.requestedModel}. Use a GPT-5.4+ model to enable it.`,
      };
    }
    const overrides: CommandPreferenceOverrides = {
      requestedModel: parsed.requestedModel,
      requestedFast: parsed.requestedFast,
      requestedYolo: parsed.requestedYolo,
    };
    if (parsed.startNew) {
      return await this.handleStartNewThreadSelection(
        conversation,
        binding,
        parsed,
        channel,
        bindingApi.requestConversationBinding,
      );
    }
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
      await this.sendBoundConversationNotifications(conversation);
      return {};
    }
    if (pendingBind && !binding && !parsed.listProjects && !parsed.query) {
      const syncTopic = parsed.syncTopic || Boolean(pendingBind.syncTopic);
      const targetPermissionsMode = this.resolveRequestedPermissionsMode(
        normalizePermissionsMode(pendingBind.permissionsMode),
        parsed.requestedYolo,
      );
      const preferences = this.buildBindingPreferencesWithOverrides(
        pendingBind.preferences,
        overrides,
        parsed.requestedModel,
      );
      const bindResult = await this.requestConversationBinding(
        conversation,
        {
          threadId: pendingBind.threadId,
          workspaceDir: pendingBind.workspaceDir,
          permissionsMode: targetPermissionsMode,
          threadTitle: pendingBind.threadTitle,
          syncTopic,
          preferences,
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
      await this.sendBoundConversationNotifications(conversation);
      return {};
    }
    if (parsed.listProjects || !parsed.query) {
      const passthroughArgs = formatThreadSelectionFlags(parsed);
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
    const targetPermissionsMode = this.resolveRequestedPermissionsMode(
      this.getPermissionsMode(binding),
      parsed.requestedYolo,
    );
    const preferences = this.buildBindingPreferencesWithOverrides(
      binding?.preferences,
      overrides,
      parsed.requestedModel,
    );
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
      permissionsMode: targetPermissionsMode,
      threadTitle: getThreadDisplayTitle(selection.thread),
      syncTopic: parsed.syncTopic,
      preferences,
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
        title: getThreadDisplayTitle(selection.thread),
        projectKey: selection.thread.projectKey,
        threadId: selection.thread.threadId,
      });
      if (syncedName) {
        await this.renameConversationIfSupported(conversation, syncedName);
      }
    }
    await this.sendBoundConversationNotifications(conversation);
    return {};
  }

  private async handleStatusCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    args: string,
    bindingActive: boolean,
  ): Promise<ReplyPayload> {
    const parsed = parseStatusArgs(args);
    if (parsed.error) {
      return { text: parsed.error };
    }
    const overrides: CommandPreferenceOverrides = {
      requestedModel: parsed.requestedModel,
      requestedFast: parsed.requestedFast,
      requestedYolo: parsed.requestedYolo,
    };
    let note: string | undefined;
    if (hasCommandPreferenceOverrides(overrides)) {
      if (!binding || !conversation) {
        return { text: "Bind this conversation to Codex before changing status settings." };
      }
      const { state: currentThreadState, effectiveState } = await this.readEffectiveThreadState(binding);
      const effectiveModel =
        parsed.requestedModel?.trim() ||
        (await this.resolveCurrentModelHint(binding, effectiveState));
      if (parsed.requestedFast && !modelSupportsFast(effectiveModel)) {
        return {
          text: `Fast mode is unavailable for ${effectiveModel ?? "the current model"}. Use a GPT-5.4+ model to enable it.`,
        };
      }
      const currentPermissionsMode = this.getPermissionsMode(binding);
      const targetPermissionsMode = this.resolveRequestedPermissionsMode(
        currentPermissionsMode,
        parsed.requestedYolo,
      );
      if (targetPermissionsMode === "full-access" && !this.hasFullAccessProfile()) {
        note = buildPermissionsUnavailableNote();
        const card = await this.buildStatusCard(conversation, binding, bindingActive);
        const text = `${card.text}\n\n${note}`;
        if (!card.buttons || !conversation) {
          return { text };
        }
        return await this.sendStatusCardCommandReply(conversation, text, card.buttons);
      }
      const nextPreferences = this.buildBindingPreferencesWithOverrides(
        binding.preferences,
        overrides,
        effectiveModel,
      );
      const updatedBindingBase: StoredBinding = {
        ...binding,
        preferences: nextPreferences,
        updatedAt: Date.now(),
      };
      const active = this.activeRuns.get(buildConversationKey(conversation));
      binding =
        targetPermissionsMode !== currentPermissionsMode
          ? active
            ? await this.persistBindingPermissionsMode(
                updatedBindingBase,
                currentPermissionsMode,
                targetPermissionsMode,
              )
            : currentThreadState
              ? await this.migrateBindingPermissionsMode(updatedBindingBase, targetPermissionsMode)
              : await this.persistBindingPermissionsMode(updatedBindingBase, targetPermissionsMode)
          : (await this.store.upsertBinding(updatedBindingBase), updatedBindingBase);
      await this.reconcileThreadConfiguration(binding, {
        applyPermissions:
          Boolean(currentThreadState) && !(active && targetPermissionsMode !== currentPermissionsMode),
        modelFallback: effectiveModel,
        context: "apply status overrides",
      });
      if (active && targetPermissionsMode !== currentPermissionsMode) {
        note = buildPendingPermissionsMigrationNote(targetPermissionsMode);
      }
    }
    const card = await this.buildStatusCard(conversation, binding, bindingActive);
    const text = note ? `${card.text}\n\n${note}` : card.text;
    if (!card.buttons || !conversation) {
      return { text };
    }
    return await this.sendStatusCardCommandReply(conversation, text, card.buttons);
  }

  private hasFullAccessProfile(): boolean {
    return this.client.hasProfile("full-access");
  }

  private getPermissionsMode(binding: StoredBinding | null | undefined): PermissionsMode {
    return getBindingPermissionsMode(binding ?? null);
  }

  private async waitForActiveRunToClear(
    conversation: ConversationTarget,
    timeoutMs = 3_000,
  ): Promise<boolean> {
    const key = buildConversationKey(conversation);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.activeRuns.has(key)) {
        return true;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    return !this.activeRuns.has(key);
  }

  private async readEffectiveThreadState(binding: StoredBinding): Promise<{
    state: ThreadState | undefined;
    effectiveState: ThreadState | undefined;
  }> {
    const profile = this.getPermissionsMode(binding);
    const state = await this.client.readThreadState({
      profile,
      sessionKey: binding.sessionKey,
      threadId: binding.threadId,
    }).catch(() => undefined);
    const desired = buildDesiredThreadConfiguration(state, binding);
    return {
      state,
      effectiveState: desired.effectiveState,
    };
  }

  private async resolveCurrentModelHint(
    binding: StoredBinding,
    effectiveState: ThreadState | undefined,
  ): Promise<string | undefined> {
    const explicitModel =
      effectiveState?.model?.trim() || binding.preferences?.preferredModel?.trim() || undefined;
    if (explicitModel) {
      return explicitModel;
    }
    const configuredDefault = this.settings.defaultModel?.trim() || undefined;
    try {
      const models = await this.client.listModels({
        profile: this.getPermissionsMode(binding),
        sessionKey: binding.sessionKey,
      });
      return models.find((model) => model.current)?.id?.trim() || configuredDefault;
    } catch {
      return configuredDefault;
    }
  }

  private resolveRequestedPermissionsMode(
    currentProfile: PermissionsMode,
    requestedYolo: boolean | undefined,
  ): PermissionsMode {
    if (requestedYolo === undefined) {
      return currentProfile;
    }
    return requestedYolo ? "full-access" : "default";
  }

  private buildPreferenceUpdatesFromOverrides(
    overrides: CommandPreferenceOverrides,
  ): Partial<ConversationPreferences> {
    const updates: Partial<ConversationPreferences> = {};
    if (overrides.requestedModel?.trim()) {
      updates.preferredModel = overrides.requestedModel.trim();
    }
    if (typeof overrides.requestedFast === "boolean") {
      updates.preferredServiceTier = overrides.requestedFast ? "fast" : "default";
    }
    return updates;
  }

  private buildBindingPreferencesWithOverrides(
    existing: ConversationPreferences | undefined,
    overrides: CommandPreferenceOverrides,
    modelHint?: string,
  ): ConversationPreferences | undefined {
    return normalizePreferencesForModel(
      mergeConversationPreferences(existing, this.buildPreferenceUpdatesFromOverrides(overrides)),
      overrides.requestedModel?.trim() || modelHint,
    );
  }

  private async reconcileThreadConfiguration(
    binding: StoredBinding,
    opts?: {
      threadState?: ThreadState;
      applyPermissions?: boolean;
      modelFallback?: string;
      context?: string;
    },
  ): Promise<ThreadState | undefined> {
    const profile = this.getPermissionsMode(binding);
    let state =
      opts?.threadState ??
      (await this.client.readThreadState({
        profile,
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
      }).catch(() => undefined));
    let desired = buildDesiredThreadConfiguration(state, binding, opts?.modelFallback);
    if (desired.model && desired.model !== state?.model?.trim()) {
      try {
        state = await this.client.setThreadModel({
          profile,
          sessionKey: binding.sessionKey,
          threadId: binding.threadId,
          model: desired.model,
        });
        desired = buildDesiredThreadConfiguration(state, binding, opts?.modelFallback);
      } catch (error) {
        this.api.logger.warn(
          `codex failed to ${opts?.context ?? "reconcile thread settings"} model: ${String(error)}`,
        );
      }
    }
    const currentServiceTier = normalizePreferenceServiceTier(state?.serviceTier);
    const desiredServiceTier = normalizePreferenceServiceTier(desired.effectiveState?.serviceTier);
    if (desiredServiceTier !== currentServiceTier) {
      try {
        state = await this.client.setThreadServiceTier({
          profile,
          sessionKey: binding.sessionKey,
          threadId: binding.threadId,
          serviceTier: desired.serviceTier,
        });
        desired = buildDesiredThreadConfiguration(state, binding, opts?.modelFallback);
      } catch (error) {
        this.api.logger.warn(
          `codex failed to ${opts?.context ?? "reconcile thread settings"} fast mode: ${String(error)}`,
        );
      }
    }
    if (
      opts?.applyPermissions !== false &&
      desired.approvalPolicy &&
      desired.sandbox &&
      (
        desired.approvalPolicy !== state?.approvalPolicy?.trim() ||
        desired.sandbox !== state?.sandbox?.trim()
      )
    ) {
      try {
        state = await this.client.setThreadPermissions({
          profile,
          sessionKey: binding.sessionKey,
          threadId: binding.threadId,
          approvalPolicy: desired.approvalPolicy,
          sandbox: desired.sandbox,
        });
      } catch (error) {
        this.api.logger.warn(
          `codex failed to ${opts?.context ?? "reconcile thread settings"} permissions: ${String(error)}`,
        );
      }
    }
    return state;
  }

  private async buildStatusControlButtons(
    conversation: ConversationTarget,
    binding: StoredBinding,
  ): Promise<PluginInteractiveButtons> {
    const { effectiveState } = await this.readEffectiveThreadState(binding);
    const currentModel = await this.resolveCurrentModelHint(binding, effectiveState);
    const currentReasoning = normalizeReasoningEffort(
      effectiveState?.reasoningEffort ?? binding.preferences?.preferredReasoningEffort,
    );
    const [showModelPicker, showReasoningPicker, togglePermissions, compactThread, stopRun, refreshStatus, detachThread, showSkills, showMcp] = await Promise.all([
      this.store.putCallback({
        kind: "show-model-picker",
        conversation,
      }),
      this.store.putCallback({
        kind: "show-reasoning-picker",
        conversation,
      }),
      this.store.putCallback({
        kind: "toggle-permissions",
        conversation,
      }),
      this.store.putCallback({
        kind: "compact-thread",
        conversation,
      }),
      this.store.putCallback({
        kind: "stop-run",
        conversation,
      }),
      this.store.putCallback({
        kind: "refresh-status",
        conversation,
      }),
      this.store.putCallback({
        kind: "detach-thread",
        conversation,
      }),
      this.store.putCallback({
        kind: "show-skills",
        conversation,
      }),
      this.store.putCallback({
        kind: "show-mcp",
        conversation,
      }),
    ]);
    const topRow: Array<{ text: string; callback_data: string }> = [
      {
        text: "Select Model",
        callback_data: `${INTERACTIVE_NAMESPACE}:${showModelPicker.token}`,
      },
    ];
    if (currentModel) {
      topRow.push({
        text: `Reasoning: ${formatReasoningEffortLabel(currentReasoning)}`,
        callback_data: `${INTERACTIVE_NAMESPACE}:${showReasoningPicker.token}`,
      });
    }
    const buttons: PluginInteractiveButtons = [topRow];
    if (modelSupportsFast(currentModel)) {
      const toggleFast = await this.store.putCallback({
        kind: "toggle-fast",
        conversation,
      });
      buttons.push([
        {
          text: "Fast: toggle",
          callback_data: `${INTERACTIVE_NAMESPACE}:${toggleFast.token}`,
        },
        {
          text: "Permissions: toggle",
          callback_data: `${INTERACTIVE_NAMESPACE}:${togglePermissions.token}`,
        },
      ]);
    } else {
      buttons.push([
        {
          text: "Permissions: toggle",
          callback_data: `${INTERACTIVE_NAMESPACE}:${togglePermissions.token}`,
        },
      ]);
    }
    buttons.push([
      {
        text: "Compact",
        callback_data: `${INTERACTIVE_NAMESPACE}:${compactThread.token}`,
      },
      {
        text: "Stop",
        callback_data: `${INTERACTIVE_NAMESPACE}:${stopRun.token}`,
      },
    ]);
    buttons.push([
      {
        text: "Refresh",
        callback_data: `${INTERACTIVE_NAMESPACE}:${refreshStatus.token}`,
      },
      {
        text: "Detach",
        callback_data: `${INTERACTIVE_NAMESPACE}:${detachThread.token}`,
      },
    ]);
    buttons.push([
      {
        text: "Skills",
        callback_data: `${INTERACTIVE_NAMESPACE}:${showSkills.token}`,
      },
      {
        text: "MCPs",
        callback_data: `${INTERACTIVE_NAMESPACE}:${showMcp.token}`,
      },
    ]);
    return buttons;
  }

  private async sendReplyPayloadToConversation(
    conversation: ConversationTarget,
    payload: ReplyPayload,
  ): Promise<void> {
    const buttons = extractReplyButtons(payload);
    const sent = await this.sendReply(conversation, {
      text: payload.text,
      buttons,
    });
    if (!sent && payload.text?.trim()) {
      await this.sendText(conversation, payload.text);
    }
  }

  private async sendPickerToConversation(
    conversation: ConversationTarget,
    picker: PickerRender,
  ): Promise<void> {
    await this.sendText(conversation, picker.text, { buttons: picker.buttons });
  }

  private async updateStatusCardMessage(
    conversation: ConversationTarget,
    message: InteractiveMessageRef,
    statusCard: StatusCardRender,
  ): Promise<boolean> {
    try {
      if (message.provider === "telegram") {
        const token = await this.resolveTelegramBotToken(conversation.accountId);
        if (!token) {
          return false;
        }
        await this.callTelegramEditMessageApi(token, {
          chat_id: message.chatId,
          message_id: Number(message.messageId),
          text: statusCard.text,
          reply_markup: buildTelegramReplyMarkup(statusCard.buttons) ?? { inline_keyboard: [] },
        });
        return true;
      }
      const builtPicker = await this.buildDiscordPickerMessage({
        text: statusCard.text,
        buttons: statusCard.buttons,
      }).catch(() => undefined);
      await this.editDiscordComponentMessage(
        message.channelId,
        message.messageId,
        this.buildDiscordPickerSpec({
          text: statusCard.text,
          buttons: statusCard.buttons,
        }),
        {
          accountId: conversation.accountId,
        },
      );
      if (builtPicker) {
        await this.registerBuiltDiscordComponentMessage({
          buildResult: builtPicker,
          messageId: message.messageId,
        });
      }
      return true;
    } catch (error) {
      this.api.logger.warn(
        `codex status card update failed ${this.formatConversationForLog(conversation)} provider=${message.provider}: ${String(error)}`,
      );
      return false;
    }
  }

  private async buildModelPicker(
    conversation: ConversationTarget,
    binding: StoredBinding,
    opts?: {
      returnToStatus?: boolean;
      statusMessage?: InteractiveMessageRef;
    },
  ): Promise<PickerRender> {
    const profile = this.getPermissionsMode(binding);
    const [models, threadState] = await Promise.all([
      this.client.listModels({ profile, sessionKey: binding.sessionKey }),
      this.readEffectiveThreadState(binding),
    ]);
    const { state, effectiveState } = threadState;
    this.api.logger.debug?.(
      `codex model picker conversation=${this.formatConversationForLog(conversation)} raw=${formatThreadStateForLog(state)} effective=${formatThreadStateForLog(effectiveState)} ${formatBindingPreferencesForLog(binding)}`,
    );
    const buttons: PluginInteractiveButtons = [];
    for (const model of models.slice(0, 8)) {
      const callback = await this.store.putCallback({
        kind: "set-model",
        conversation,
        model: model.id,
        returnToStatus: opts?.returnToStatus,
        statusMessage: opts?.statusMessage,
      });
      buttons.push([
        {
          text:
            `${model.id}${
              model.id === effectiveState?.model || (!effectiveState?.model && model.current)
                ? " (current)"
                : ""
            }`,
          callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
        },
      ]);
    }
    if (opts?.returnToStatus) {
      const cancel = await this.store.putCallback({
        kind: "refresh-status",
        conversation,
      });
      buttons.push([
        {
          text: "Cancel",
          callback_data: `${INTERACTIVE_NAMESPACE}:${cancel.token}`,
        },
      ]);
    }
    return {
      text: formatModels(models, effectiveState),
      buttons,
    };
  }

  private async buildReasoningPicker(
    conversation: ConversationTarget,
    binding: StoredBinding,
    opts?: {
      returnToStatus?: boolean;
    },
  ): Promise<PickerRender> {
    const { state, effectiveState } = await this.readEffectiveThreadState(binding);
    const model = await this.resolveCurrentModelHint(binding, effectiveState);
    if (!model) {
      return {
        text:
          "Select a model first. Reasoning choices will also become available after Codex materializes the thread.",
        buttons: [],
      };
    }
    const supported = getSupportedReasoningEfforts(model);
    const currentReasoning = normalizeReasoningEffort(
      effectiveState?.reasoningEffort ?? binding.preferences?.preferredReasoningEffort,
    );
    const buttons: PluginInteractiveButtons = [];
    for (const option of REASONING_EFFORT_OPTIONS) {
      if (!supported.includes(option.value)) {
        continue;
      }
      const callback = await this.store.putCallback({
        kind: "set-reasoning",
        conversation,
        reasoningEffort: option.value,
        returnToStatus: opts?.returnToStatus,
      });
      buttons.push([
        {
          text: `${option.label}${currentReasoning === option.value ? " (current)" : ""}`,
          callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
        },
      ]);
    }
    const cancel = await this.store.putCallback({
      kind: "refresh-status",
      conversation,
    });
    buttons.push([
      {
        text: "Cancel",
        callback_data: `${INTERACTIVE_NAMESPACE}:${cancel.token}`,
      },
    ]);
    const currentText = currentReasoning ? formatReasoningEffortLabel(currentReasoning) : "Default";
    const pendingNote =
      !state
        ? "This thread is not materialized yet. Your choice will be saved as the default for the first turn."
        : "";
    return {
      text:
        supported.length === 0
          ? `Reasoning selection is unavailable for ${model}.`
          : [
              pendingNote,
              `Current reasoning: ${currentText}`,
              model ? `Model: ${model}` : "",
              "Available reasoning levels:",
              ...REASONING_EFFORT_OPTIONS
                .filter((option) => supported.includes(option.value))
                .map((option) => `- ${option.label}${currentReasoning === option.value ? " (current)" : ""}`),
            ]
              .filter(Boolean)
              .join("\n"),
      buttons,
    };
  }

  private async buildStatusCard(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    bindingActive: boolean,
  ): Promise<StatusCardRender> {
    const text = await this.buildStatusText(conversation, binding, bindingActive);
    if (!conversation || !binding || !bindingActive) {
      return { text };
    }
    return {
      text,
      buttons: await this.buildStatusControlButtons(conversation, binding),
    };
  }

  private async buildSkillsPicker(
    conversation: ConversationTarget,
    binding: StoredBinding | null,
    opts: {
      page: number;
      clickMode: "run" | "help";
      filter?: string;
    },
  ): Promise<PickerRender> {
    const workspaceDir = resolveWorkspaceDir({
      bindingWorkspaceDir: binding?.workspaceDir,
      configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
      serviceWorkspaceDir: this.serviceWorkspaceDir,
    });
    const skills = dedupeSkillsByName(await this.client.listSkills({
      profile: this.getPermissionsMode(binding),
      sessionKey: binding?.sessionKey,
      workspaceDir,
    }));
    const filtered = filterSkillsByQuery(skills, opts.filter);
    const paged = paginateItems(filtered, opts.page, getSkillsPickerPageSize(conversation.channel));
    const buttons: PluginInteractiveButtons = [];

    for (let index = 0; index < paged.items.length; index += 2) {
      const pair = paged.items.slice(index, index + 2);
      const row = await Promise.all(
        pair.map(async (skill) => {
          const callback =
            opts.clickMode === "run"
              ? await this.store.putCallback({
                  kind: "run-skill",
                  conversation,
                  skillName: skill.name,
                  workspaceDir: binding?.workspaceDir || workspaceDir,
                })
              : await this.store.putCallback({
                  kind: "show-skill-help",
                  conversation,
                  skillName: skill.name,
                  description: skill.description,
                  cwd: skill.cwd,
                  enabled: skill.enabled,
                });
          return {
            text: `$${skill.name}`,
            callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
          };
        }),
      );
      buttons.push(row);
    }

    if (paged.totalPages > 1) {
      const [prevView, nextView] = await Promise.all([
        this.store.putCallback({
          kind: "picker-view",
          conversation,
          view: {
            mode: "skills",
            page: Math.max(0, paged.page - 1),
            filter: opts.filter,
            clickMode: opts.clickMode,
          },
        }),
        this.store.putCallback({
          kind: "picker-view",
          conversation,
          view: {
            mode: "skills",
            page: Math.min(paged.totalPages - 1, paged.page + 1),
            filter: opts.filter,
            clickMode: opts.clickMode,
          },
        }),
      ]);
      buttons.push([
        {
          text: "Prev",
          callback_data: `${INTERACTIVE_NAMESPACE}:${prevView.token}`,
        },
        {
          text: "Next",
          callback_data: `${INTERACTIVE_NAMESPACE}:${nextView.token}`,
        },
      ]);
    }

    const [toggleMode, cancel] = await Promise.all([
      this.store.putCallback({
        kind: "picker-view",
        conversation,
        view: {
          mode: "skills",
          page: paged.page,
          filter: opts.filter,
          clickMode: opts.clickMode === "run" ? "help" : "run",
        },
      }),
      this.store.putCallback({
        kind: "cancel-picker",
        conversation,
      }),
    ]);
    buttons.push([
      {
        text: "Mode: toggle",
        callback_data: `${INTERACTIVE_NAMESPACE}:${toggleMode.token}`,
      },
      {
        text: "Cancel",
        callback_data: `${INTERACTIVE_NAMESPACE}:${cancel.token}`,
      },
    ]);

    return {
      text: formatSkillsPickerText({
        workspaceDir,
        skills: filtered,
        page: paged.page,
        totalPages: paged.totalPages,
        mode: opts.clickMode,
        filter: opts.filter,
      }),
      buttons,
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
      return { text: formatCommandUsage("cas_steer") };
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
      return { text: formatCommandUsage("cas_plan") };
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
    const profile = this.getPermissionsMode(binding);
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
        profile,
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
    const skills = dedupeSkillsByName(await this.client.listSkills({
      profile: this.getPermissionsMode(binding),
      sessionKey: binding?.sessionKey,
      workspaceDir,
    }));
    if (!conversation) {
      return {
        text: formatSkills({
          workspaceDir,
          skills,
          filter: args,
        }),
      };
    }
    const picker = await this.buildSkillsPicker(conversation, binding, {
      filter: args,
      page: 0,
      clickMode: "run",
    });
    if (conversation && isDiscordChannel(conversation.channel) && picker.buttons) {
      try {
        await this.sendReply(conversation, {
          text: picker.text,
          buttons: picker.buttons,
        });
        return { text: "Sent Codex skills to this Discord conversation." };
      } catch (error) {
        this.api.logger.warn(`codex discord skills send failed: ${String(error)}`);
        return { text: picker.text };
      }
    }
    return buildReplyWithButtons(picker.text, picker.buttons);
  }

  private async handleExperimentalCommand(binding: StoredBinding | null): Promise<ReplyPayload> {
    const features = await this.client.listExperimentalFeatures({
      profile: this.getPermissionsMode(binding),
      sessionKey: binding?.sessionKey,
    });
    return { text: formatExperimentalFeatures(features) };
  }

  private async handleMcpCommand(binding: StoredBinding | null, args: string): Promise<ReplyPayload> {
    const servers = await this.client.listMcpServers({
      profile: this.getPermissionsMode(binding),
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
    const profile = this.getPermissionsMode(binding);
    const { state: threadState, effectiveState } = await this.readEffectiveThreadState(binding);
    const currentModel =
      effectiveState?.model?.trim() || binding.preferences?.preferredModel?.trim() || undefined;
    if (!modelSupportsFast(currentModel)) {
      return {
        text: `Fast mode is unavailable for ${currentModel ?? "the current model"}. Use a GPT-5.4+ model to enable it.`,
      };
    }
    const currentTier = normalizeServiceTier(threadState?.serviceTier);
    if (action === "status") {
      return { text: `Fast mode is ${formatFastModeValue(currentTier)}.` };
    }
    const nextTier =
      action === "toggle" ? (currentTier === "fast" ? null : "fast")
      : action === "on" ? "fast"
      : null;
    const updatedState = await this.client.setThreadServiceTier({
      profile,
      sessionKey: binding.sessionKey,
      threadId: binding.threadId,
      serviceTier: nextTier,
    });
    const updatedBinding: StoredBinding = {
      ...binding,
      preferences: {
        ...(binding.preferences ?? {
          preferredServiceTier: null,
          updatedAt: Date.now(),
        }),
        preferredServiceTier: preferredServiceTierFromRequest(nextTier),
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    };
    await this.store.upsertBinding(updatedBinding);
    return {
      text: `Fast mode set to ${formatFastModeValue(updatedState.serviceTier)}.`,
    };
  }

  private async handleModelCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    args: string,
  ): Promise<ReplyPayload> {
    const trimmedArgs = args.trim();
    const profile = this.getPermissionsMode(binding);
    if (!binding) {
      const models = await this.client.listModels({ profile });
      return { text: formatModels(models) };
    }
    if (!trimmedArgs) {
      if (!conversation) {
        const [models, { effectiveState }] = await Promise.all([
          this.client.listModels({ profile, sessionKey: binding.sessionKey }),
          this.readEffectiveThreadState(binding),
        ]);
        return { text: formatModels(models, effectiveState) };
      }
      const picker = await this.buildModelPicker(conversation, binding);
      if (isDiscordChannel(conversation.channel) && picker.buttons) {
        try {
          await this.sendReply(conversation, {
            text: picker.text,
            buttons: picker.buttons,
          });
          return { text: "Sent Codex model choices to this Discord conversation." };
        } catch (error) {
          this.api.logger.warn(`codex discord model picker send failed: ${String(error)}`);
          return { text: picker.text };
        }
      }
      return buildReplyWithButtons(picker.text, picker.buttons);
    }
    const state = await this.client.setThreadModel({
      profile,
      sessionKey: binding.sessionKey,
      threadId: binding.threadId,
      model: trimmedArgs,
    });
    const nextPreferredServiceTier = modelSupportsFast(trimmedArgs)
      ? binding.preferences?.preferredServiceTier ?? null
      : "default";
    const nextState =
      !modelSupportsFast(trimmedArgs) && normalizeServiceTier(state.serviceTier) === "fast"
        ? await this.client
            .setThreadServiceTier({
              profile,
              sessionKey: binding.sessionKey,
              threadId: binding.threadId,
              serviceTier: null,
            })
            .catch(() => ({ ...state, serviceTier: "default" }))
        : state;
    const updatedBinding: StoredBinding = {
      ...binding,
      preferences: {
        ...(binding.preferences ?? {
          preferredServiceTier: null,
          updatedAt: Date.now(),
        }),
        preferredModel: trimmedArgs,
        preferredServiceTier: nextPreferredServiceTier,
        updatedAt: Date.now(),
      },
      updatedAt: Date.now(),
    };
    await this.store.upsertBinding(updatedBinding);
    return { text: `Codex model set to ${nextState.model || trimmedArgs}.` };
  }

  private async handlePermissionsCommand(
    conversation: ConversationTarget | null,
    binding: StoredBinding | null,
    bindingActive: boolean,
  ): Promise<ReplyPayload> {
    return await this.handleStatusCommand(conversation, binding, "", bindingActive);
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
    const profile = this.getPermissionsMode(binding);
    const parsed = parseRenameArgs(args);
    if (!parsed?.name) {
      const picker = await this.buildRenameStylePicker(conversation, binding, Boolean(parsed?.syncTopic));
      return buildReplyWithButtons(picker.text, picker.buttons);
    }
    await this.client.setThreadName({
      profile,
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
    const profile = this.getPermissionsMode(binding);
    const threadState = await this.client
      .readThreadState({
        profile,
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
      return { text: formatCommandUsage("cas_rename"), buttons: [] };
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
    const profile = this.getPermissionsMode(binding);
    const threadState = await this.client
      .readThreadState({
        profile,
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
      profile,
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
    input?: readonly CodexTurnInputItem[];
    reason: "command" | "inbound" | "plan";
    collaborationMode?: CollaborationMode;
  }): Promise<void> {
    const key = buildConversationKey(params.conversation);
    const profile = this.getPermissionsMode(params.binding);
    const existing = this.activeRuns.get(key);
    this.api.logger.debug?.(
      `codex turn request reason=${params.reason} ${this.formatConversationForLog(params.conversation)} workspace=${params.workspaceDir} existing=${existing ? existing.mode : "none"} profile=${profile} prompt="${summarizeTextForLog(params.prompt)}"`,
    );
    if (existing) {
      if (existing.mode === "plan" && (params.collaborationMode?.mode ?? "default") !== "plan") {
        this.api.logger.debug?.(
          `codex turn request replacing active plan run ${this.formatConversationForLog(params.conversation)}`,
        );
        this.activeRuns.delete(key);
        await existing.handle.interrupt().catch(() => undefined);
      } else if (!isQueueCompatibleTurnInput(params.prompt, params.input)) {
        this.api.logger.debug?.(
          `codex turn request restarting active run for structured input ${this.formatConversationForLog(params.conversation)} mode=${existing.mode}`,
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
      `codex turn starting app-server run ${this.formatConversationForLog(params.conversation)} typing=${typing ? "yes" : "no"} session=${params.binding?.sessionKey ?? "<none>"} existingThread=${params.binding?.threadId ?? "<none>"} profile=${profile} mode=${params.collaborationMode?.mode ?? "default"}`,
    );
    const desired = buildDesiredThreadConfiguration(
      undefined,
      params.binding,
      this.settings.defaultModel,
    );
    const run = this.client.startTurn({
      profile,
      sessionKey: params.binding?.sessionKey,
      workspaceDir: params.workspaceDir,
      prompt: params.prompt,
      input: params.input,
      runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      existingThreadId: params.binding?.threadId,
      model: desired.model,
      reasoningEffort: desired.reasoningEffort,
      serviceTier: desired.serviceTier ?? undefined,
      approvalPolicy: desired.approvalPolicy,
      sandbox: desired.sandbox,
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
      profile,
      handle: run,
    });
    void (run.result as Promise<import("./types.js").TurnResult>)
      .then(async (result) => {
        const threadId = result.threadId || run.getThreadId();
        if (threadId) {
          const state = await this.client
            .readThreadState({
              profile,
              sessionKey: params.binding?.sessionKey,
              threadId,
            })
            .catch(() => null);
          const nextBinding = await this.bindConversation(params.conversation, {
            threadId,
            workspaceDir: state?.cwd || params.workspaceDir,
            threadTitle: state?.threadName,
            permissionsMode: profile,
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
            profile,
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
            profile,
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
        await this.applyPendingBindingPermissionsModeMigration(params.conversation);
        this.api.logger.debug?.(
          `codex turn cleaned up ${this.formatConversationForLog(params.conversation)}`,
        );
      });
  }

  private async describeTurnFailure(params: {
    sessionKey?: string;
    profile?: PermissionsMode;
    error: unknown;
    terminalError?: TurnTerminalError;
  }): Promise<string> {
    const message =
      params.terminalError?.message?.trim() ||
      (params.error instanceof Error ? params.error.message : String(params.error));
    if (this.looksLikeExplicitCodexAuthFailure(params.terminalError, message)) {
      const account = await this.client
        .readAccount({
          profile: params.profile,
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
          profile: params.profile,
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
    const profile = this.getPermissionsMode(params.binding);
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
              profile,
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
    const desired = buildDesiredThreadConfiguration(
      threadState ?? undefined,
      params.binding,
      this.settings.defaultModel,
    );
    const effectiveThreadState = desired.effectiveState;
    const run = this.client.startTurn({
      profile,
      sessionKey: params.binding?.sessionKey,
      workspaceDir: params.workspaceDir,
      prompt: params.prompt,
      runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      existingThreadId: params.binding?.threadId,
      model: desired.model,
      reasoningEffort: desired.reasoningEffort,
      serviceTier: desired.serviceTier ?? undefined,
      approvalPolicy: desired.approvalPolicy,
      sandbox: desired.sandbox,
      collaborationMode: {
        mode: "plan",
        settings: {
          model: desired.model || this.settings.defaultModel,
          reasoningEffort: desired.reasoningEffort,
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
      profile,
      handle: run,
    });
    void (run.result as Promise<import("./types.js").TurnResult>)
      .then(async (result) => {
        const threadId = result.threadId || run.getThreadId();
        if (threadId) {
          const state = await this.client
            .readThreadState({
              profile,
              sessionKey: params.binding?.sessionKey,
              threadId,
            })
            .catch(() => null);
          const nextBinding = await this.bindConversation(params.conversation, {
            threadId,
            workspaceDir: state?.cwd || params.workspaceDir,
            threadTitle: state?.threadName,
            permissionsMode: profile,
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
                model: desired.model || this.settings.defaultModel,
                reasoningEffort: desired.reasoningEffort,
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
        await this.applyPendingBindingPermissionsModeMigration(params.conversation);
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
    const profile = this.getPermissionsMode(params.binding);
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
    const threadState = await this.client
      .readThreadState({
        profile,
        sessionKey: params.binding.sessionKey,
        threadId: params.binding.threadId,
      })
      .catch(() => undefined);
    const desired = buildDesiredThreadConfiguration(
      threadState ?? undefined,
      params.binding,
      this.settings.defaultModel,
    );
    const run = this.client.startReview({
      profile,
      sessionKey: params.binding.sessionKey,
      workspaceDir: params.workspaceDir,
      threadId: params.binding.threadId,
      runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      model: desired.model,
      reasoningEffort: desired.reasoningEffort,
      serviceTier: desired.serviceTier,
      approvalPolicy: desired.approvalPolicy,
      sandbox: desired.sandbox,
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
      profile,
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
        await this.applyPendingBindingPermissionsModeMigration(params.conversation);
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

  private async resolveNewThreadWorkspaceDir(
    binding: StoredBinding | null,
    parsed: ReturnType<typeof parseThreadSelectionArgs>,
  ): Promise<string | null> {
    if (parsed.cwd) {
      return parsed.cwd;
    }
    const query = parsed.query.trim();
    if (!query) {
      return null;
    }
    if (
      query.startsWith("~") ||
      query.startsWith(".") ||
      query.includes("/") ||
      query.includes("\\")
    ) {
      if (query.startsWith("~")) {
        return expandHomeDir(query);
      }
      return path.resolve(query);
    }
    const { threads } = await this.listPickerThreads(binding, {
      parsed: {
        ...parsed,
        query: "",
      },
      filterProjectsOnly: true,
    });
    const normalizedThreads = await this.normalizeNewThreadProjectThreads(threads);
    const exactProjectName = listProjects(normalizedThreads).filter(
      (project) => project.name.trim().toLowerCase() === query.toLowerCase(),
    );
    if (exactProjectName.length === 1) {
      const workspaces = listWorkspaceChoices(normalizedThreads, exactProjectName[0]?.name);
      return workspaces.length === 1 ? workspaces[0]?.workspaceDir ?? null : null;
    }
    const candidates = listProjects(normalizedThreads, query);
    if (candidates.length !== 1) {
      return null;
    }
    const workspaces = listWorkspaceChoices(normalizedThreads, candidates[0]?.name);
    return workspaces.length === 1 ? workspaces[0]?.workspaceDir ?? null : null;
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
    const profile = this.getPermissionsMode(binding);
    const threads = await this.client.listThreads({
      profile,
      sessionKey: binding?.sessionKey,
      workspaceDir,
      filter: params.filterProjectsOnly ? undefined : params.parsed.query || undefined,
    });
    return {
      workspaceDir,
      threads: filterThreadsByProjectName(threads, params.projectName),
    };
  }

  private async normalizeNewThreadProjectThreads<
    T extends { projectKey?: string; createdAt?: number; updatedAt?: number },
  >(threads: T[]): Promise<T[]> {
    const projectFolderByWorkspace = new Map<string, Promise<string | undefined>>();
    const getResolvedProjectFolder = (workspaceDir: string): Promise<string | undefined> => {
      let projectFolder = projectFolderByWorkspace.get(workspaceDir);
      if (!projectFolder) {
        projectFolder = this.resolveProjectFolder(workspaceDir);
        projectFolderByWorkspace.set(workspaceDir, projectFolder);
      }
      return projectFolder;
    };
    const liveProjectRootsByName = new Map<string, Set<string>>();

    for (const thread of threads) {
      const workspaceDir = thread.projectKey?.trim();
      const projectName = getProjectName(workspaceDir)?.trim().toLowerCase();
      if (!workspaceDir || !projectName || !existsSync(workspaceDir)) {
        continue;
      }
      const resolvedProjectRoot = this.isWorktreePath(workspaceDir)
        ? ((await getResolvedProjectFolder(workspaceDir))?.trim() || workspaceDir)
        : workspaceDir;
      const projectRoots = liveProjectRootsByName.get(projectName) ?? new Set<string>();
      projectRoots.add(resolvedProjectRoot);
      liveProjectRootsByName.set(projectName, projectRoots);
    }

    const normalizedThreads: T[] = [];
    for (const thread of threads) {
      const workspaceDir = thread.projectKey?.trim();
      if (!workspaceDir || !this.isWorktreePath(workspaceDir)) {
        normalizedThreads.push(thread);
        continue;
      }
      if (existsSync(workspaceDir)) {
        normalizedThreads.push({
          ...thread,
          projectKey: (await getResolvedProjectFolder(workspaceDir))?.trim() || workspaceDir,
        });
        continue;
      }
      const projectName = getProjectName(workspaceDir)?.trim().toLowerCase();
      const liveProjectRoots = projectName ? liveProjectRootsByName.get(projectName) : undefined;
      if (liveProjectRoots?.size === 1) {
        normalizedThreads.push({
          ...thread,
          projectKey: [...liveProjectRoots][0],
        });
      }
    }
    return normalizedThreads;
  }

  private async buildThreadPickerButtons(params: {
    conversation: ConversationTarget;
    parsed: ReturnType<typeof parseThreadSelectionArgs>;
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
        threadTitle: getThreadDisplayTitle(thread),
        workspaceDir: thread.projectKey?.trim() || this.settings.defaultWorkspaceDir || process.cwd(),
        syncTopic: params.parsed.syncTopic,
        requestedModel: params.parsed.requestedModel,
        requestedFast: params.parsed.requestedFast,
        requestedYolo: params.parsed.requestedYolo,
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
            requestedModel: params.parsed.requestedModel,
            requestedFast: params.parsed.requestedFast,
            requestedYolo: params.parsed.requestedYolo,
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
            requestedModel: params.parsed.requestedModel,
            requestedFast: params.parsed.requestedFast,
            requestedYolo: params.parsed.requestedYolo,
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
        action: "resume-thread",
        includeAll: true,
        syncTopic: params.parsed.syncTopic,
        workspaceDir: params.parsed.cwd,
        requestedModel: params.parsed.requestedModel,
        requestedFast: params.parsed.requestedFast,
        requestedYolo: params.parsed.requestedYolo,
        page: 0,
      },
    });
    const newThread = !params.parsed.startNew
      ? await this.store.putCallback({
          kind: "picker-view",
          conversation: params.conversation,
          view: {
            mode: "projects",
            action: "start-new-thread",
            includeAll: true,
            syncTopic: params.parsed.syncTopic,
            workspaceDir: params.parsed.cwd,
            query: params.parsed.query || undefined,
            requestedModel: params.parsed.requestedModel,
            requestedFast: params.parsed.requestedFast,
            requestedYolo: params.parsed.requestedYolo,
            page: 0,
          },
        })
      : null;
    const cancel = await this.store.putCallback({
      kind: "cancel-picker",
      conversation: params.conversation,
    });
    params.buttons.push(
      [
        {
          text: "Projects",
          callback_data: `${INTERACTIVE_NAMESPACE}:${projects.token}`,
        },
        ...(newThread
          ? [{
              text: "New",
              callback_data: `${INTERACTIVE_NAMESPACE}:${newThread.token}`,
            }]
          : []),
        {
          text: "Cancel",
          callback_data: `${INTERACTIVE_NAMESPACE}:${cancel.token}`,
        },
      ],
    );
    return params.buttons;
  }

  private async renderThreadPicker(
    conversation: ConversationTarget,
    binding: StoredBinding | null,
    parsed: ReturnType<typeof parseThreadSelectionArgs>,
    page: number,
    projectName?: string,
  ): Promise<PickerRender> {
    const profile = this.getPermissionsMode(binding);
    let { workspaceDir, threads } = await this.listPickerThreads(binding, {
      parsed,
      projectName,
    });
    let fallbackToGlobal = false;
    if (threads.length === 0 && workspaceDir != null && !projectName) {
      const globalResult = await this.client.listThreads({
        profile,
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
      parsed,
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
    action: "resume-thread" | "start-new-thread" = "resume-thread",
  ): Promise<PickerRender> {
    const { workspaceDir, threads } = await this.listPickerThreads(binding, {
      parsed,
      filterProjectsOnly: true,
    });
    const normalizedThreads =
      action === "start-new-thread" ? await this.normalizeNewThreadProjectThreads(threads) : threads;
    const buttons: PluginInteractiveButtons = [];
    const projectOptions = paginateItems(listProjects(normalizedThreads, parsed.query), page);
    for (const option of projectOptions.items) {
      const callback =
        action === "start-new-thread"
          ? (() => {
              const workspaces = listWorkspaceChoices(normalizedThreads, option.name);
              if (workspaces.length === 1) {
                return this.store.putCallback({
                  kind: "start-new-thread",
                  conversation,
                  workspaceDir: workspaces[0]?.workspaceDir ?? option.name,
                  syncTopic: parsed.syncTopic,
                  requestedModel: parsed.requestedModel,
                  requestedFast: parsed.requestedFast,
                  requestedYolo: parsed.requestedYolo,
                });
              }
              return this.store.putCallback({
                kind: "picker-view",
                conversation,
                view: {
                  mode: "workspaces",
                  action: "start-new-thread",
                  includeAll: true,
                  syncTopic: parsed.syncTopic,
                  workspaceDir: parsed.cwd,
                  projectName: option.name,
                  requestedModel: parsed.requestedModel,
                  requestedFast: parsed.requestedFast,
                  requestedYolo: parsed.requestedYolo,
                  page: 0,
                },
              });
            })()
          : this.store.putCallback({
              kind: "picker-view",
              conversation,
              view: {
                mode: "threads",
                includeAll: true,
                syncTopic: parsed.syncTopic,
                workspaceDir: parsed.cwd,
                projectName: option.name,
                requestedModel: parsed.requestedModel,
                requestedFast: parsed.requestedFast,
                requestedYolo: parsed.requestedYolo,
                page: 0,
              },
            });
      buttons.push([
        {
          text: `${option.name} (${option.threadCount})`,
          callback_data: `${INTERACTIVE_NAMESPACE}:${(await callback).token}`,
        },
      ]);
    }
    if (projectOptions.totalPages > 1) {
      const navRow: PluginInteractiveButtons[number] = [];
      if (projectOptions.page > 0) {
        const prev = await this.store.putCallback({
          kind: "picker-view",
          conversation,
          view: {
            mode: "projects",
            action,
            includeAll: true,
            syncTopic: parsed.syncTopic,
            workspaceDir: parsed.cwd,
            query: parsed.query || undefined,
            requestedModel: parsed.requestedModel,
            requestedFast: parsed.requestedFast,
            requestedYolo: parsed.requestedYolo,
            page: projectOptions.page - 1,
          },
        });
        navRow.push({
          text: "◀ Prev",
          callback_data: `${INTERACTIVE_NAMESPACE}:${prev.token}`,
        });
      }
      if (projectOptions.page + 1 < projectOptions.totalPages) {
        const next = await this.store.putCallback({
          kind: "picker-view",
          conversation,
          view: {
            mode: "projects",
            action,
            includeAll: true,
            syncTopic: parsed.syncTopic,
            workspaceDir: parsed.cwd,
            query: parsed.query || undefined,
            requestedModel: parsed.requestedModel,
            requestedFast: parsed.requestedFast,
            requestedYolo: parsed.requestedYolo,
            page: projectOptions.page + 1,
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

    const recentThreads = await this.store.putCallback({
      kind: "picker-view",
      conversation,
      view: {
        mode: "threads",
        includeAll: true,
        syncTopic: parsed.syncTopic,
        workspaceDir: parsed.cwd,
        requestedModel: parsed.requestedModel,
        requestedFast: parsed.requestedFast,
        requestedYolo: parsed.requestedYolo,
        page: 0,
      },
    });
    const cancel = await this.store.putCallback({
      kind: "cancel-picker",
      conversation,
    });
    buttons.push([
      {
        text: "Recent Threads",
        callback_data: `${INTERACTIVE_NAMESPACE}:${recentThreads.token}`,
      },
      {
        text: "Cancel",
        callback_data: `${INTERACTIVE_NAMESPACE}:${cancel.token}`,
      },
    ]);

    return {
      text: formatProjectPickerIntro({
        page: projectOptions.page,
        totalPages: projectOptions.totalPages,
        totalItems: projectOptions.totalItems,
        workspaceDir,
        action,
      }),
      buttons,
    };
  }

  private async renderNewThreadWorkspacePicker(
    conversation: ConversationTarget,
    binding: StoredBinding | null,
    parsed: ReturnType<typeof parseThreadSelectionArgs>,
    page: number,
    projectName: string,
  ): Promise<PickerRender> {
    const { threads } = await this.listPickerThreads(binding, {
      parsed,
      projectName,
      filterProjectsOnly: true,
    });
    const normalizedThreads = await this.normalizeNewThreadProjectThreads(threads);
    const workspaceOptions = paginateItems(listWorkspaceChoices(normalizedThreads, projectName), page);
    const buttons: PluginInteractiveButtons = [];
    for (const option of workspaceOptions.items) {
      const callback = await this.store.putCallback({
        kind: "start-new-thread",
        conversation,
        workspaceDir: option.workspaceDir,
        syncTopic: parsed.syncTopic,
        requestedModel: parsed.requestedModel,
        requestedFast: parsed.requestedFast,
        requestedYolo: parsed.requestedYolo,
      });
      buttons.push([
        {
          text: `${option.workspaceDir} (${option.threadCount})`,
          callback_data: `${INTERACTIVE_NAMESPACE}:${callback.token}`,
        },
      ]);
    }
    if (workspaceOptions.totalPages > 1) {
      const navRow: PluginInteractiveButtons[number] = [];
      if (workspaceOptions.page > 0) {
        const prev = await this.store.putCallback({
          kind: "picker-view",
          conversation,
          view: {
            mode: "workspaces",
            action: "start-new-thread",
            includeAll: true,
            syncTopic: parsed.syncTopic,
            workspaceDir: parsed.cwd,
            projectName,
            requestedModel: parsed.requestedModel,
            requestedFast: parsed.requestedFast,
            requestedYolo: parsed.requestedYolo,
            page: workspaceOptions.page - 1,
          },
        });
        navRow.push({
          text: "◀ Prev",
          callback_data: `${INTERACTIVE_NAMESPACE}:${prev.token}`,
        });
      }
      if (workspaceOptions.page + 1 < workspaceOptions.totalPages) {
        const next = await this.store.putCallback({
          kind: "picker-view",
          conversation,
          view: {
            mode: "workspaces",
            action: "start-new-thread",
            includeAll: true,
            syncTopic: parsed.syncTopic,
            workspaceDir: parsed.cwd,
            projectName,
            requestedModel: parsed.requestedModel,
            requestedFast: parsed.requestedFast,
            requestedYolo: parsed.requestedYolo,
            page: workspaceOptions.page + 1,
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

    const projects = await this.store.putCallback({
      kind: "picker-view",
      conversation,
      view: {
        mode: "projects",
        action: "start-new-thread",
        includeAll: true,
        syncTopic: parsed.syncTopic,
        workspaceDir: parsed.cwd,
        requestedModel: parsed.requestedModel,
        requestedFast: parsed.requestedFast,
        requestedYolo: parsed.requestedYolo,
        page: 0,
      },
    });
    const recentThreads = await this.store.putCallback({
      kind: "picker-view",
      conversation,
      view: {
        mode: "threads",
        includeAll: true,
        syncTopic: parsed.syncTopic,
        workspaceDir: parsed.cwd,
        requestedModel: parsed.requestedModel,
        requestedFast: parsed.requestedFast,
        requestedYolo: parsed.requestedYolo,
        page: 0,
      },
    });
    const cancel = await this.store.putCallback({
      kind: "cancel-picker",
      conversation,
    });
    buttons.push([
      {
        text: "Projects",
        callback_data: `${INTERACTIVE_NAMESPACE}:${projects.token}`,
      },
      {
        text: "Recent Threads",
        callback_data: `${INTERACTIVE_NAMESPACE}:${recentThreads.token}`,
      },
    ]);
    buttons.push([
      {
        text: "Cancel",
        callback_data: `${INTERACTIVE_NAMESPACE}:${cancel.token}`,
      },
    ]);

    return {
      text: [
        `Multiple workspaces matched ${projectName}. Page ${workspaceOptions.page + 1}/${workspaceOptions.totalPages}.`,
        "Tap a workspace to start a fresh Codex thread there.",
        workspaceOptions.totalItems === 0 ? "No matching workspaces found." : "",
      ].filter(Boolean).join("\n"),
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
    const outbound = await this.loadDiscordOutboundAdapter();
    if (outbound?.sendPayload) {
      await outbound.sendPayload({
        cfg: this.getOpenClawConfig(),
        to: conversation.conversationId,
        accountId: conversation.accountId,
        threadId: conversation.threadId,
        payload: {
          text: picker.text,
          channelData: {
            discord: {
              components: this.buildDiscordPickerSpec(picker),
            },
          },
        },
      });
      return;
    }
    const legacySend = (this.api.runtime.channel as {
      discord?: {
        sendComponentMessage?: (
          to: string,
          spec: DiscordComponentMessageSpec,
          opts?: { accountId?: string },
        ) => Promise<unknown>;
      };
    }).discord?.sendComponentMessage;
    if (typeof legacySend === "function") {
      await legacySend(
        conversation.conversationId,
        this.buildDiscordPickerSpec(picker),
        {
          accountId: conversation.accountId,
        },
      );
      return;
    }
    const runtimeApi = await this.loadDiscordRuntimeApi();
    if (typeof runtimeApi?.sendDiscordComponentMessage === "function") {
      await runtimeApi.sendDiscordComponentMessage(
        conversation.conversationId,
        this.buildDiscordPickerSpec(picker),
        {
          cfg: this.getOpenClawConfig(),
          accountId: conversation.accountId,
        },
      );
      return;
    }
    throw new Error("Discord component messaging is unavailable.");
  }

  private async sendDiscordPickerMessageLegacy(
    conversation: ConversationTarget,
    picker: PickerRender,
  ): Promise<unknown> {
    const legacySend = (this.api.runtime.channel as {
      discord?: {
        sendComponentMessage?: (
          to: string,
          spec: DiscordComponentMessageSpec,
          opts?: { accountId?: string },
        ) => Promise<unknown>;
      };
    }).discord?.sendComponentMessage;
    if (typeof legacySend === "function") {
      return await legacySend(
        conversation.conversationId,
        this.buildDiscordPickerSpec(picker),
        {
          accountId: conversation.accountId,
        },
      );
    }
    const runtimeApi = await this.loadDiscordRuntimeApi();
    if (typeof runtimeApi?.sendDiscordComponentMessage === "function") {
      return await runtimeApi.sendDiscordComponentMessage(
        conversation.conversationId,
        this.buildDiscordPickerSpec(picker),
        {
          cfg: this.getOpenClawConfig(),
          accountId: conversation.accountId,
        },
      );
    }
    throw new Error("Discord component messaging is unavailable.");
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

  private async buildDiscordPickerMessage(
    picker: PickerRender,
  ): Promise<DiscordComponentBuildResult> {
    const discordSdk = await this.loadDiscordSdk();
    return discordSdk.buildDiscordComponentMessage({
      spec: this.buildDiscordPickerSpec(picker),
    });
  }

  private async tryBuildDiscordPickerMessage(
    picker: PickerRender,
  ): Promise<DiscordComponentBuildResult | undefined> {
    try {
      return await this.buildDiscordPickerMessage(picker);
    } catch (error) {
      this.api.logger.debug?.(`codex discord picker build fallback: ${String(error)}`);
      return undefined;
    }
  }

  private async loadDiscordSdk(): Promise<DiscordSdkModule> {
    return await loadOpenClawCompatModule<DiscordSdkModule>({
      specifier: "openclaw/plugin-sdk/discord",
      fallbackRelativePath: "dist/plugin-sdk/discord.js",
      label: "discord",
      logger: this.api.logger,
    });
  }

  private async loadTelegramAccountSdk(): Promise<TelegramAccountSdkModule> {
    return await loadOpenClawCompatModule<TelegramAccountSdkModule>({
      specifier: "openclaw/plugin-sdk/telegram-account",
      fallbackRelativePath: "dist/plugin-sdk/telegram-account.js",
      label: "telegram account",
      logger: this.api.logger,
    });
  }

  private async loadDiscordRuntimeApi(): Promise<DiscordRuntimeApiModule | undefined> {
    try {
      const openClawEntrypointPath = resolveOpenClawEntrypointPath();
      const runtimeApiPath = resolveCompatFallbackPath(
        openClawEntrypointPath,
        "dist/extensions/discord/runtime-api.js",
      );
      if (!existsSync(runtimeApiPath)) {
        return undefined;
      }
      return (await import(pathToFileURL(runtimeApiPath).href)) as DiscordRuntimeApiModule;
    } catch (error) {
      this.api.logger.debug?.(`codex discord runtime api unavailable: ${String(error)}`);
      return undefined;
    }
  }

  private async loadDiscordExtensionApi(): Promise<DiscordExtensionApiModule | undefined> {
    try {
      const openClawEntrypointPath = resolveOpenClawEntrypointPath();
      const apiPath = resolveCompatFallbackPath(
        openClawEntrypointPath,
        "dist/extensions/discord/api.js",
      );
      if (!existsSync(apiPath)) {
        return undefined;
      }
      return (await import(pathToFileURL(apiPath).href)) as DiscordExtensionApiModule;
    } catch (error) {
      this.api.logger.debug?.(`codex discord extension api unavailable: ${String(error)}`);
      return undefined;
    }
  }

  private async editDiscordComponentMessage(
    to: string,
    messageId: string,
    spec: DiscordComponentMessageSpec,
    opts?: { accountId?: string },
  ): Promise<{ messageId: string; channelId: string }> {
    try {
      const discordSdk = await this.loadDiscordSdk();
      return await discordSdk.editDiscordComponentMessage(to, messageId, spec, opts);
    } catch (error) {
      const runtimeApi = await this.loadDiscordRuntimeApi();
      if (typeof runtimeApi?.editDiscordComponentMessage === "function") {
        return await runtimeApi.editDiscordComponentMessage(to, messageId, spec, {
          cfg: this.getOpenClawConfig(),
          accountId: opts?.accountId,
        });
      }
      throw error;
    }
  }

  private async registerBuiltDiscordComponentMessage(params: {
    buildResult: DiscordComponentBuildResult;
    messageId: string;
  }): Promise<void> {
    try {
      const discordSdk = await this.loadDiscordSdk();
      discordSdk.registerBuiltDiscordComponentMessage(params);
      return;
    } catch (error) {
      const runtimeApi = await this.loadDiscordRuntimeApi();
      if (typeof runtimeApi?.registerBuiltDiscordComponentMessage === "function") {
        runtimeApi.registerBuiltDiscordComponentMessage(params);
        return;
      }
      throw error;
    }
  }

  private async dispatchCallbackAction(
    callback: CallbackAction,
    responders: PickerResponders,
  ): Promise<void> {
    if (callback.kind === "start-new-thread") {
      if (responders.conversation.channel !== "discord") {
        await responders.clear().catch(() => undefined);
      }
      const result = await this.startNewThreadAndBindConversation(
        callback.conversation,
        this.store.getBinding(callback.conversation),
        callback.workspaceDir,
        callback.syncTopic ?? false,
        {
          requestedModel: callback.requestedModel,
          requestedFast: callback.requestedFast,
          requestedYolo: callback.requestedYolo,
        },
        responders.requestConversationBinding,
      );
      if (result.status === "pending") {
        return;
      }
      if (result.status === "error") {
        await responders.reply(result.message);
        return;
      }
      await this.store.removeCallback(callback.token);
      return;
    }
    if (callback.kind === "resume-thread") {
      if (responders.conversation.channel !== "discord") {
        await responders.clear().catch(() => undefined);
      }
      const currentBinding = this.store.getBinding(callback.conversation);
      const profile = this.resolveRequestedPermissionsMode(
        this.getPermissionsMode(currentBinding),
        callback.requestedYolo,
      );
      const threadState = await this.client
        .readThreadState({
          profile,
          sessionKey: buildPluginSessionKey(callback.threadId),
          threadId: callback.threadId,
        })
        .catch(() => undefined);
      const preferences = this.buildBindingPreferencesWithOverrides(
        currentBinding?.preferences,
        {
          requestedModel: callback.requestedModel,
          requestedFast: callback.requestedFast,
          requestedYolo: undefined,
        },
        callback.requestedModel ?? threadState?.model?.trim(),
      );
      const bindResult = await this.requestConversationBinding(
        callback.conversation,
        {
          threadId: callback.threadId,
          workspaceDir: threadState?.cwd?.trim() || callback.workspaceDir,
          permissionsMode: profile,
          threadTitle: threadState?.threadName?.trim() || callback.threadTitle,
          syncTopic: callback.syncTopic,
          preferences,
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
          title: threadState?.threadName?.trim() || callback.threadTitle,
          projectKey: threadState?.cwd?.trim() || callback.workspaceDir,
          threadId: callback.threadId,
        });
        if (syncedName) {
          await this.renameConversationIfSupported(responders.conversation, syncedName);
        }
      }
      await this.sendBoundConversationNotifications(callback.conversation);
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
    if (callback.kind === "toggle-fast") {
      const binding = this.store.getBinding(callback.conversation);
      await this.store.removeCallback(callback.token);
      if (!binding) {
        await responders.reply("No Codex binding for this conversation.");
        return;
      }
      const profile = this.getPermissionsMode(binding);
      const { state: threadState, effectiveState } = await this.readEffectiveThreadState(binding);
      const currentModel = await this.resolveCurrentModelHint(binding, effectiveState);
      if (!modelSupportsFast(currentModel)) {
        await responders.reply(
          `Fast mode is unavailable for ${currentModel ?? "the current model"}. Use a GPT-5.4+ model to enable it.`,
        );
        return;
      }
      const currentTier = normalizeServiceTier(
        effectiveState?.serviceTier ?? threadState?.serviceTier,
      );
      const nextTier = currentTier === "fast" ? null : "fast";
      let updatedState = threadState;
      if (threadState) {
        updatedState = await this.client.setThreadServiceTier({
          profile,
          sessionKey: binding.sessionKey,
          threadId: binding.threadId,
          serviceTier: nextTier,
        }).catch((error) => {
          if (isMissingThreadError(error)) {
            return threadState;
          }
          throw error;
        });
      }
      const preferredServiceTier = preferredServiceTierFromRequest(nextTier);
      const updatedBinding: StoredBinding = {
        ...binding,
        preferences: {
          ...(binding.preferences ?? {
            preferredServiceTier: null,
            updatedAt: Date.now(),
          }),
          preferredServiceTier,
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      };
      await this.store.upsertBinding(updatedBinding);
      this.api.logger.debug?.(
        `codex status control toggle-fast conversation=${this.formatConversationForLog(callback.conversation)} requested=${nextTier ?? "<none>"} raw=${formatThreadStateForLog(updatedState)} effective=${formatThreadStateForLog(applyBindingPreferencesToThreadState(updatedState, updatedBinding))} ${formatBindingPreferencesForLog(updatedBinding)}`,
      );
      const statusCard = await this.buildStatusCard(
        {
          ...callback.conversation,
          threadId: responders.conversation.threadId,
        },
        updatedBinding,
        true,
      );
      await responders.editPicker({
        text: statusCard.text,
        buttons: statusCard.buttons,
      });
      return;
    }
    if (callback.kind === "show-reasoning-picker") {
      const binding = this.store.getBinding(callback.conversation);
      await this.store.removeCallback(callback.token);
      if (!binding) {
        await responders.reply("No Codex binding for this conversation.");
        return;
      }
      const conversation = {
        ...callback.conversation,
        threadId: responders.conversation.threadId,
      };
      const [picker, statusCard] = await Promise.all([
        this.buildReasoningPicker(
          conversation,
          binding,
          {
            returnToStatus: true,
          },
        ),
        this.buildStatusCard(
          conversation,
          binding,
          true,
        ),
      ]);
      await responders.editPicker({
        text: statusCard.text,
        buttons: picker.buttons,
      });
      return;
    }
    if (callback.kind === "set-reasoning") {
      const binding = this.store.getBinding(callback.conversation);
      await this.store.removeCallback(callback.token);
      if (!binding) {
        await responders.reply("No Codex binding for this conversation.");
        return;
      }
      const normalizedReasoning = normalizeReasoningEffort(callback.reasoningEffort);
      if (!normalizedReasoning) {
        await responders.reply("That reasoning level is no longer available.");
        return;
      }
      const updatedBinding: StoredBinding = {
        ...binding,
        preferences: {
          ...(binding.preferences ?? {
            preferredServiceTier: null,
            updatedAt: Date.now(),
          }),
          preferredReasoningEffort: normalizedReasoning,
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      };
      await this.store.upsertBinding(updatedBinding);
      this.api.logger.debug?.(
        `codex status control set-reasoning conversation=${this.formatConversationForLog(callback.conversation)} requested=${normalizedReasoning} ${formatBindingPreferencesForLog(updatedBinding)}`,
      );
      if (callback.returnToStatus) {
        const statusCard = await this.buildStatusCard(
          {
            ...callback.conversation,
            threadId: responders.conversation.threadId,
          },
          updatedBinding,
          true,
        );
        await responders.editPicker({
          text: statusCard.text,
          buttons: statusCard.buttons,
        });
        return;
      }
      await responders.clear().catch(() => undefined);
      await responders.reply(`Codex reasoning set to ${formatReasoningEffortLabel(normalizedReasoning)}.`);
      return;
    }
    if (callback.kind === "toggle-permissions") {
      const binding = this.store.getBinding(callback.conversation);
      await this.store.removeCallback(callback.token);
      if (!binding) {
        await responders.reply("No Codex binding for this conversation.");
        return;
      }
      const currentProfile = this.getPermissionsMode(binding);
      const nextProfile = currentProfile === "full-access" ? "default" : "full-access";
      if (nextProfile === "full-access" && !this.hasFullAccessProfile()) {
        const unchangedBinding: StoredBinding = {
          ...binding,
          updatedAt: Date.now(),
        };
        await this.store.upsertBinding(unchangedBinding);
        const unavailableCard = await this.buildStatusCard(
          {
            ...callback.conversation,
            threadId: responders.conversation.threadId,
          },
          unchangedBinding,
          true,
        );
        await responders.editPicker({
          text: `${unavailableCard.text}\n\n${buildPermissionsUnavailableNote()}`,
          buttons: unavailableCard.buttons,
        });
        return;
      }
      const active = this.activeRuns.get(buildConversationKey(callback.conversation));
      const { state: currentThreadState } = await this.readEffectiveThreadState(binding);
      const updatedBindingBase: StoredBinding = {
        ...binding,
        permissionsMode: active ? currentProfile : nextProfile,
        pendingPermissionsMode: active ? nextProfile : undefined,
        updatedAt: Date.now(),
      };
      const updatedBinding = active
        ? await this.persistBindingPermissionsMode(updatedBindingBase, currentProfile, nextProfile)
        : currentThreadState
          ? await this.migrateBindingPermissionsMode(updatedBindingBase, nextProfile)
          : await this.persistBindingPermissionsMode(updatedBindingBase, nextProfile);
      this.api.logger.debug?.(
        `codex status control toggle-permissions conversation=${this.formatConversationForLog(callback.conversation)} currentProfile=${currentProfile} requestedProfile=${nextProfile} activeRun=${active?.mode ?? "none"} ${formatBindingPreferencesForLog(updatedBinding)}`,
      );
      const statusCard = await this.buildStatusCard(
        {
          ...callback.conversation,
          threadId: responders.conversation.threadId,
        },
        updatedBinding,
        true,
      );
      await responders.editPicker({
        text: active
          ? `${statusCard.text}\n\n${buildPendingPermissionsMigrationNote(nextProfile)}`
          : statusCard.text,
        buttons: statusCard.buttons,
      });
      return;
    }
    if (callback.kind === "compact-thread") {
      const binding = this.store.getBinding(callback.conversation);
      await this.store.removeCallback(callback.token);
      if (!binding) {
        await responders.reply("No Codex binding for this conversation.");
        return;
      }
      void this.startCompact({
        conversation: {
          ...callback.conversation,
          threadId: responders.conversation.threadId,
        },
        binding,
      });
      const statusCard = await this.buildStatusCard(
        {
          ...callback.conversation,
          threadId: responders.conversation.threadId,
        },
        binding,
        true,
      );
      await responders.editPicker({
        text: `${statusCard.text}\n\nCompaction started.`,
        buttons: statusCard.buttons,
      });
      return;
    }
    if (callback.kind === "stop-run") {
      const binding = this.store.getBinding(callback.conversation);
      await this.store.removeCallback(callback.token);
      const active = this.activeRuns.get(buildConversationKey(callback.conversation));
      if (!active) {
        const statusCard = await this.buildStatusCard(
          {
            ...callback.conversation,
            threadId: responders.conversation.threadId,
          },
          binding,
          Boolean(binding),
        );
        await responders.editPicker({
          text: statusCard.text,
          buttons: statusCard.buttons ?? [],
        });
        return;
      }
      await active.handle.interrupt().catch(() => undefined);
      await this.waitForActiveRunToClear(callback.conversation);
      const nextBinding = this.store.getBinding(callback.conversation) ?? binding;
      const statusCard = await this.buildStatusCard(
        {
          ...callback.conversation,
          threadId: responders.conversation.threadId,
        },
        nextBinding,
        Boolean(nextBinding),
      );
      await responders.editPicker({
        text: statusCard.text,
        buttons: statusCard.buttons ?? [],
      });
      return;
    }
    if (callback.kind === "refresh-status") {
      const binding = this.store.getBinding(callback.conversation);
      await this.store.removeCallback(callback.token);
      const statusCard = await this.buildStatusCard(
        {
          ...callback.conversation,
          threadId: responders.conversation.threadId,
        },
        binding,
        Boolean(binding),
      );
      await responders.editPicker({
        text: statusCard.text,
        buttons: statusCard.buttons ?? [],
      });
      return;
    }
    if (callback.kind === "detach-thread") {
      await this.store.removeCallback(callback.token);
      await responders.detachConversationBinding?.().catch(() => undefined);
      await this.unbindConversation(callback.conversation);
      const statusCard = await this.buildStatusCard(
        {
          ...callback.conversation,
          threadId: responders.conversation.threadId,
        },
        null,
        false,
      );
      await responders.editPicker({
        text: `${statusCard.text}\n\nDetached this conversation from Codex.`,
        buttons: [],
      });
      return;
    }
    if (callback.kind === "show-skills") {
      const binding = this.store.getBinding(callback.conversation);
      await this.store.removeCallback(callback.token);
      await responders.acknowledge?.();
      const payload = await this.handleSkillsCommand(
        {
          ...callback.conversation,
          threadId: responders.conversation.threadId,
        },
        binding,
        "",
      );
      if (!(isDiscordChannel(callback.conversation.channel) && payload.text === "Sent Codex skills to this Discord conversation.")) {
        await this.sendReplyPayloadToConversation(
          {
            ...callback.conversation,
            threadId: responders.conversation.threadId,
          },
          payload,
        );
      }
      return;
    }
    if (callback.kind === "run-skill") {
      const binding = this.store.getBinding(callback.conversation);
      await this.store.removeCallback(callback.token);
      await responders.acknowledge?.();
      const conversation = {
        ...callback.conversation,
        threadId: responders.conversation.threadId,
      };
      const workspaceDir =
        callback.workspaceDir?.trim() ||
        binding?.workspaceDir ||
        resolveWorkspaceDir({
          bindingWorkspaceDir: binding?.workspaceDir,
          configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
          serviceWorkspaceDir: this.serviceWorkspaceDir,
        });
      const prompt = `$${callback.skillName}`;
      const active = this.activeRuns.get(buildConversationKey(conversation));
      const ackText = this.buildRunPromptAckText(prompt);
      if (active) {
        if (active.mode === "plan") {
          this.activeRuns.delete(buildConversationKey(conversation));
          await active.handle.interrupt().catch(() => undefined);
        } else {
          const handled = await active.handle.queueMessage(prompt);
          if (handled) {
            await this.sendText(conversation, ackText);
            return;
          }
        }
      }
      await this.startTurn({
        conversation,
        binding,
        workspaceDir,
        prompt,
        reason: "command",
      });
      await this.sendText(conversation, ackText);
      return;
    }
    if (callback.kind === "show-skill-help") {
      await this.store.removeCallback(callback.token);
      await responders.acknowledge?.();
      await this.sendText(
        {
          ...callback.conversation,
          threadId: responders.conversation.threadId,
        },
        formatSkillHelpText({
          name: callback.skillName,
          description: callback.description,
          cwd: callback.cwd,
          enabled: callback.enabled,
        }),
      );
      return;
    }
    if (callback.kind === "show-mcp") {
      const binding = this.store.getBinding(callback.conversation);
      await this.store.removeCallback(callback.token);
      await responders.acknowledge?.();
      const payload = await this.handleMcpCommand(binding, "");
      await this.sendReplyPayloadToConversation(
        {
          ...callback.conversation,
          threadId: responders.conversation.threadId,
        },
        payload,
      );
      return;
    }
    if (callback.kind === "show-model-picker") {
      const binding = this.store.getBinding(callback.conversation);
      await this.store.removeCallback(callback.token);
      if (!binding) {
        await responders.reply("No Codex binding for this conversation.");
        return;
      }
      const conversation = {
        ...callback.conversation,
        threadId: responders.conversation.threadId,
      };
      if (responders.sourceMessage) {
        const [picker, statusCard] = await Promise.all([
          this.buildModelPicker(
            conversation,
            binding,
            {
              returnToStatus: true,
            },
          ),
          this.buildStatusCard(
            conversation,
            binding,
            true,
          ),
        ]);
        await responders.editPicker({
          text: statusCard.text,
          buttons: picker.buttons,
        });
        return;
      }
      const picker = await this.buildModelPicker(
        conversation,
        binding,
        {
          returnToStatus: true,
          statusMessage: responders.sourceMessage,
        },
      );
      await responders.acknowledge?.();
      await this.sendPickerToConversation(conversation, picker);
      return;
    }
    if (callback.kind === "set-model") {
      const binding = this.store.getBinding(callback.conversation);
      await this.store.removeCallback(callback.token);
      if (!binding) {
        await responders.reply("No Codex binding for this conversation.");
        return;
      }
      const profile = this.getPermissionsMode(binding);
      const { state: threadState } = await this.readEffectiveThreadState(binding);
      let state = threadState;
      if (threadState) {
        state = await this.client.setThreadModel({
          profile,
          sessionKey: binding.sessionKey,
          threadId: binding.threadId,
          model: callback.model,
        }).catch((error) => {
          if (isMissingThreadError(error)) {
            return threadState;
          }
          throw error;
        });
      }
      const nextPreferredServiceTier = modelSupportsFast(callback.model)
        ? binding.preferences?.preferredServiceTier ?? null
        : "default";
      let nextState = state;
      if (!modelSupportsFast(callback.model) && normalizeServiceTier(state?.serviceTier) === "fast") {
        nextState = await this.client
          .setThreadServiceTier({
            profile,
            sessionKey: binding.sessionKey,
            threadId: binding.threadId,
            serviceTier: null,
          })
          .catch(() => ({ ...state, serviceTier: "default" } as ThreadState));
      }
      const updatedBinding: StoredBinding = {
        ...binding,
        preferences: {
          ...(binding.preferences ?? {
            preferredServiceTier: null,
            updatedAt: Date.now(),
          }),
          preferredModel: callback.model,
          preferredServiceTier: nextPreferredServiceTier,
          updatedAt: Date.now(),
        },
        updatedAt: Date.now(),
      };
      await this.store.upsertBinding(updatedBinding);
      this.api.logger.debug?.(
        `codex status control set-model conversation=${this.formatConversationForLog(callback.conversation)} requested=${callback.model} raw=${formatThreadStateForLog(nextState)} effective=${formatThreadStateForLog(applyBindingPreferencesToThreadState(nextState, updatedBinding))} ${formatBindingPreferencesForLog(updatedBinding)}`,
      );
      if (callback.returnToStatus) {
        const statusCard = await this.buildStatusCard(
          {
            ...callback.conversation,
            threadId: responders.conversation.threadId,
          },
          updatedBinding,
          true,
        );
        if (callback.statusMessage) {
          const updatedOriginal = await this.updateStatusCardMessage(
            {
              ...callback.conversation,
              threadId: responders.conversation.threadId,
            },
            callback.statusMessage,
            statusCard,
          );
          if (updatedOriginal) {
            await responders.editPicker({
              text: `Codex model set to ${callback.model}.`,
              buttons: [],
            });
            return;
          }
        }
        await responders.editPicker({
          text: statusCard.text,
          buttons: statusCard.buttons,
        });
        return;
      }
      await responders.clear().catch(() => undefined);
      await responders.reply(`Codex model set to ${nextState?.model || callback.model}.`);
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
    const parsed =
      callback.view.mode === "skills"
        ? null
        : {
            includeAll: callback.view.includeAll,
            listProjects: callback.view.mode === "projects",
            startNew:
              (callback.view.mode === "projects" && callback.view.action === "start-new-thread") ||
              callback.view.mode === "workspaces",
            syncTopic: callback.view.syncTopic ?? false,
            cwd: callback.view.workspaceDir,
            requestedModel: callback.view.requestedModel,
            requestedFast: callback.view.requestedFast,
            requestedYolo: callback.view.requestedYolo,
            query:
              callback.view.mode === "threads" || callback.view.mode === "projects"
                ? callback.view.query ?? ""
                : "",
          };
    const picker =
      callback.view.mode === "projects"
        ? await this.renderProjectPicker(
            responders.conversation,
            binding,
            parsed!,
            callback.view.page,
            callback.view.action ?? "resume-thread",
          )
        : callback.view.mode === "workspaces"
          ? await this.renderNewThreadWorkspacePicker(
              responders.conversation,
              binding,
              parsed!,
              callback.view.page,
              callback.view.projectName,
            )
        : callback.view.mode === "skills"
          ? await this.buildSkillsPicker(
              responders.conversation,
              binding,
              {
                page: callback.view.page,
                filter: callback.view.filter,
                clickMode: callback.view.clickMode,
              },
            )
          : await this.renderThreadPicker(
              responders.conversation,
              binding,
              parsed!,
              callback.view.page,
              callback.view.projectName,
            );
    await responders.editPicker(picker);
  }

  private async startNewThreadAndBindConversation(
    conversation: ConversationTarget,
    binding: StoredBinding | null,
    workspaceDir: string,
    syncTopic: boolean,
    overrides: CommandPreferenceOverrides,
    requestConversationBinding?: PickerResponders["requestConversationBinding"],
  ): Promise<
    | { status: "bound" }
    | { status: "pending"; reply: ReplyPayload }
    | { status: "error"; message: string }
  > {
    const profile = this.resolveRequestedPermissionsMode(
      this.getPermissionsMode(binding),
      overrides.requestedYolo,
    );
    const created = await this.client.startThread({
      profile,
      sessionKey: binding?.sessionKey,
      workspaceDir,
      model: overrides.requestedModel?.trim() || undefined,
    });
    const preferences = this.buildBindingPreferencesWithOverrides(
      binding?.preferences,
      overrides,
      overrides.requestedModel ?? created.model?.trim(),
    );
    const bindResult = await this.requestConversationBinding(
      conversation,
      {
        threadId: created.threadId,
        workspaceDir: created.cwd?.trim() || workspaceDir,
        threadTitle: created.threadName,
        permissionsMode: profile,
        syncTopic,
        preferences,
        notifyBound: true,
      },
      requestConversationBinding,
    );
    if (bindResult.status === "pending") {
      return bindResult;
    }
    if (bindResult.status === "error") {
      return bindResult;
    }
    if (syncTopic) {
      const syncedName = buildResumeTopicName({
        title: created.threadName,
        projectKey: created.cwd?.trim() || workspaceDir,
        threadId: created.threadId,
      });
      if (syncedName) {
        await this.renameConversationIfSupported(conversation, syncedName);
      }
    }
    await this.sendBoundConversationNotifications(conversation);
    return { status: "bound" };
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
      profile: "default",
      sessionKey,
      workspaceDir,
      filter: trimmed,
    });
    return selectThreadFromMatches(threads, trimmed);
  }

  private async persistBindingPermissionsMode(
    binding: StoredBinding,
    profile: PermissionsMode,
    pendingProfile?: PermissionsMode | null,
  ): Promise<StoredBinding> {
    const nextBinding: StoredBinding = {
      ...binding,
      permissionsMode: profile,
      pendingPermissionsMode: pendingProfile ?? undefined,
      updatedAt: Date.now(),
    };
    await this.store.upsertBinding(nextBinding);
    return nextBinding;
  }

  private async migrateBindingPermissionsMode(
    binding: StoredBinding,
    profile: PermissionsMode,
  ): Promise<StoredBinding> {
    if (profile === "full-access" && !this.hasFullAccessProfile()) {
      throw new Error("Full Access is unavailable in the current Codex Desktop session.");
    }
    const preferredPermissions = getPermissionsForMode(profile);
    const state = await this.client
      .setThreadPermissions({
        profile,
        sessionKey: binding.sessionKey,
        threadId: binding.threadId,
        approvalPolicy: preferredPermissions.approvalPolicy,
        sandbox: preferredPermissions.sandbox,
      })
      .catch(() =>
        this.client.readThreadState({
          profile,
          sessionKey: binding.sessionKey,
          threadId: binding.threadId,
        }),
      );
    const nextBinding: StoredBinding = {
      ...binding,
      permissionsMode: profile,
      pendingPermissionsMode: undefined,
      workspaceDir: state.cwd?.trim() || binding.workspaceDir,
      threadTitle: state.threadName?.trim() || binding.threadTitle,
      updatedAt: Date.now(),
    };
    await this.store.upsertBinding(nextBinding);
    return nextBinding;
  }

  private async applyPendingBindingPermissionsModeMigration(
    conversation: ConversationTarget,
  ): Promise<StoredBinding | null> {
    const binding = this.store.getBinding(conversation);
    const pendingProfile = getBindingPendingPermissionsMode(binding);
    if (!binding || !pendingProfile || pendingProfile === getBindingPermissionsMode(binding)) {
      return binding;
    }
    try {
      const migrated = await this.migrateBindingPermissionsMode(binding, pendingProfile);
      this.api.logger.debug?.(
        `codex migrated binding profile ${this.formatConversationForLog(conversation)} profile=${pendingProfile}`,
      );
      return migrated;
    } catch (error) {
      this.api.logger.warn(
        `codex failed to migrate binding profile ${this.formatConversationForLog(conversation)} target=${pendingProfile}: ${String(error)}`,
      );
      return binding;
    }
  }

  private async bindConversation(
    conversation: ConversationTarget,
    params: {
      threadId: string;
      workspaceDir: string;
      threadTitle?: string;
      permissionsMode?: PermissionsMode;
      pendingPermissionsMode?: PermissionsMode;
      preferences?: ConversationPreferences;
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
      permissionsMode: params.permissionsMode ?? existing?.permissionsMode ?? "default",
      pendingPermissionsMode: params.pendingPermissionsMode ?? existing?.pendingPermissionsMode,
      threadTitle:
        params.threadTitle ??
        (existing?.threadId === params.threadId ? existing.threadTitle : undefined),
      pinnedBindingMessage: existing?.pinnedBindingMessage,
      contextUsage: existing?.contextUsage,
      preferences: params.preferences ?? existing?.preferences,
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
      permissionsMode: normalizePermissionsMode(pending.permissionsMode),
      preferences: pending.preferences,
    });
    return { binding, pendingBind: pending };
  }

  private async requestConversationBinding(
    conversation: ConversationTarget,
    params: {
      threadId: string;
      workspaceDir: string;
      permissionsMode?: PermissionsMode;
      threadTitle?: string;
      syncTopic?: boolean;
      notifyBound?: boolean;
      preferences?: ConversationPreferences;
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
          permissionsMode: params.permissionsMode,
          threadTitle: params.threadTitle,
          syncTopic: params.syncTopic,
          notifyBound: params.notifyBound,
          preferences: params.preferences,
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
    const profile = this.getPermissionsMode(binding);
    const restoreConversation: ConversationTarget = {
      channel: conversation.channel,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
      parentConversationId: conversation.parentConversationId,
      threadId: "threadId" in conversation ? conversation.threadId : undefined,
    };

    const readStateForRestore = async (): Promise<ThreadState | undefined> => {
      try {
        return await this.client.readThreadState({
          profile,
          sessionKey: binding.sessionKey,
          threadId: binding.threadId,
        });
      } catch (error) {
        if (isMissingThreadError(error)) {
          this.api.logger.warn(
            `codex bound restore could not read thread state ${this.formatConversationForLog(restoreConversation)} boundThread=${binding.threadId}: ${String(error)}`,
          );
          return undefined;
        }
        throw error;
      }
    };

    const readReplayForRestore = async (): Promise<{
      lastUserMessage?: string;
      lastAssistantMessage?: string;
    }> => {
      try {
        return await this.client.readThreadContext({
          profile,
          sessionKey: binding.sessionKey,
          threadId: binding.threadId,
        });
      } catch (error) {
        if (isMissingThreadError(error)) {
          this.api.logger.warn(
            `codex bound restore could not read thread replay ${this.formatConversationForLog(restoreConversation)} boundThread=${binding.threadId}: ${String(error)}`,
          );
          return { lastUserMessage: undefined, lastAssistantMessage: undefined };
        }
        throw error;
      }
    };

    const [initialState, replay] = await Promise.all([
      readStateForRestore(),
      readReplayForRestore(),
    ]);
    const state =
      (await this.reconcileThreadConfiguration(binding, {
        threadState: initialState,
        context: "restore desired thread settings",
      })) ?? initialState;

    const nextBinding =
      (state?.threadName && state.threadName !== binding.threadTitle) ||
      (state?.cwd?.trim() && state.cwd.trim() !== binding.workspaceDir)
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

  private async sendBoundConversationNotifications(
    conversation: ConversationTarget | ConversationRef,
  ): Promise<void> {
    const target: ConversationTarget = {
      channel: conversation.channel,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
      parentConversationId: conversation.parentConversationId,
      threadId: "threadId" in conversation ? conversation.threadId : undefined,
    };
    const messages = await this.buildBoundConversationMessages(conversation);
    for (const message of messages.slice(1)) {
      await this.sendText(target, message);
    }
    const binding = this.store.getBinding(target);
    if (!binding) {
      return;
    }
    const card = await this.buildStatusCard(target, binding, true);
    if (!card.buttons) {
      return;
    }
    try {
      const delivered = await this.sendReplyWithDeliveryRef(target, {
        text: card.text,
        buttons: card.buttons,
      });
      await this.pinBindingMessage(target, delivered);
    } catch (error) {
      this.api.logger.warn(`codex bound status card send failed: ${String(error)}`);
    }
  }

  private async sendStatusCardCommandReply(
    conversation: ConversationTarget,
    text: string,
    buttons: PluginInteractiveButtons,
  ): Promise<ReplyPayload> {
    try {
      await this.sendReplyWithDeliveryRef(conversation, {
        text,
        buttons,
      });
      return isDiscordChannel(conversation.channel)
        ? { text: "Sent Codex status controls to this Discord conversation." }
        : {};
    } catch (error) {
      this.api.logger.warn(`codex ${conversation.channel} status card send failed: ${String(error)}`);
      return { text };
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
    const profile = activeRun?.profile ?? this.getPermissionsMode(binding);
    const pendingProfile = getBindingPendingPermissionsMode(binding);
    const workspaceDir = resolveWorkspaceDir({
      bindingWorkspaceDir: binding?.workspaceDir,
      configuredWorkspaceDir: this.settings.defaultWorkspaceDir,
      serviceWorkspaceDir: this.serviceWorkspaceDir,
    });
    const [threadState, account, limits, projectFolder] = await Promise.all([
      binding
        ? this.client.readThreadState({
            profile,
            sessionKey: binding.sessionKey,
            threadId: binding.threadId,
          }).catch(() => undefined)
        : Promise.resolve(undefined),
      this.client.readAccount({
        profile,
        sessionKey: binding?.sessionKey,
      }).catch(() => null),
      this.client.readRateLimits({
        profile,
        sessionKey: binding?.sessionKey,
      }).catch(() => []),
      this.resolveProjectFolder(binding?.workspaceDir || workspaceDir),
    ]);
    const effectiveThreadState = buildDesiredThreadConfiguration(threadState, binding).effectiveState;
    const displayThreadState =
      effectiveThreadState ??
      (binding
        ? {
            threadId: binding.threadId,
            threadName: binding.threadTitle,
            cwd: binding.workspaceDir,
          }
        : undefined);
    const threadNote =
      binding && !threadState
        ? "Live thread details are unavailable until Codex materializes the thread, usually after the first user message. Model, reasoning, and fast-mode changes made here are saved as defaults until then."
        : undefined;
    this.api.logger.debug?.(
      `codex status snapshot bindingActive=${bindingActive ? "yes" : "no"} activeRun=${activeRun?.mode ?? "none"} boundThread=${binding?.threadId ?? "<none>"} raw=${formatThreadStateForLog(threadState)} effective=${formatThreadStateForLog(displayThreadState)} ${formatBindingPreferencesForLog(binding)} threadCwd=${displayThreadState?.cwd?.trim() || "<none>"}`,
    );

    return formatCodexStatusText({
      pluginVersion: PLUGIN_VERSION,
      threadState: displayThreadState,
      bindingThreadTitle: binding?.threadTitle,
      account,
      rateLimits: limits,
      bindingActive,
      projectFolder,
      worktreeFolder: displayThreadState?.cwd?.trim() || binding?.workspaceDir || workspaceDir,
      contextUsage: binding?.contextUsage,
      planMode: bindingActive ? activeRun?.mode === "plan" : undefined,
      threadNote,
      permissionNote:
        pendingProfile && activeRun
          ? buildPendingPermissionsMigrationNote(pendingProfile)
          : undefined,
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
    const delivered = await this.sendReplyWithDeliveryRef(conversation, payload);
    return delivered !== null;
  }

  private async sendReplyWithDeliveryRef(
    conversation: ConversationTarget,
    payload: {
      text?: string;
      buttons?: PluginInteractiveButtons;
      mediaUrl?: string;
    },
  ): Promise<DeliveredMessageRef | null> {
    const text = payload.text?.trim() ?? "";
    const hasMedia = typeof payload.mediaUrl === "string" && payload.mediaUrl.trim().length > 0;
    if (!text && !hasMedia) {
      return null;
    }
    this.api.logger.debug?.(
      `codex outbound send start ${this.formatConversationForLog(conversation)} textChars=${text.length} media=${hasMedia ? "yes" : "no"} buttons=${payload.buttons?.length ?? 0} preview="${summarizeTextForLog(text, 80)}"`,
    );
    if (isTelegramChannel(conversation.channel)) {
      const outbound = await this.loadTelegramOutboundAdapter();
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
      let delivered: DeliveredMessageRef | null = null;
      if (hasMedia) {
        const result =
          chunks.length <= 1 && payload.buttons && outbound?.sendPayload
            ? await outbound.sendPayload({
                cfg: this.getOpenClawConfig(),
                to: conversation.parentConversationId ?? conversation.conversationId,
                accountId: conversation.accountId,
                threadId: conversation.threadId,
                mediaLocalRoots,
                payload: {
                  text: chunks[0] ?? text,
                  mediaUrl: payload.mediaUrl,
                  channelData: {
                    telegram: {
                      buttons: payload.buttons,
                    },
                  },
                },
              })
            : await this.sendTelegramMediaChunk(outbound, conversation, chunks[0] ?? text, {
                mediaUrl: payload.mediaUrl,
                mediaLocalRoots,
                buttons: chunks.length <= 1 ? payload.buttons : undefined,
              });
        delivered = {
          provider: "telegram",
          messageId: result.messageId,
          chatId:
            typeof result.chatId === "string"
              ? result.chatId
              : conversation.parentConversationId ?? conversation.conversationId,
        };
        for (let index = 1; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          if (!chunk) {
            continue;
          }
          const result =
            index === chunks.length - 1 && payload.buttons && outbound?.sendPayload
              ? await outbound.sendPayload({
                  cfg: this.getOpenClawConfig(),
                  to: conversation.parentConversationId ?? conversation.conversationId,
                  accountId: conversation.accountId,
                  threadId: conversation.threadId,
                  payload: {
                    text: chunk,
                    channelData: {
                      telegram: {
                        buttons: payload.buttons,
                      },
                    },
                  },
                })
              : await this.sendTelegramTextChunk(outbound, conversation, chunk, {
                  buttons: index === chunks.length - 1 ? payload.buttons : undefined,
                });
          if (index === chunks.length - 1 || !delivered) {
            delivered = {
              provider: "telegram",
              messageId: result.messageId,
              chatId:
                typeof result.chatId === "string"
                  ? result.chatId
                  : conversation.parentConversationId ?? conversation.conversationId,
            };
          }
        }
        this.api.logger.debug?.(
          `codex outbound send complete ${this.formatConversationForLog(conversation)} channel=telegram chunks=${Math.max(chunks.length, 1)} media=${hasMedia ? "yes" : "no"}`,
        );
        return delivered;
      }
      const textChunks = chunks.length > 0 ? chunks : [text];
      for (let index = 0; index < textChunks.length; index += 1) {
        const chunk = textChunks[index];
        if (!chunk) {
          continue;
        }
        const result =
          index === textChunks.length - 1 && payload.buttons && outbound?.sendPayload
            ? await outbound.sendPayload({
                cfg: this.getOpenClawConfig(),
                to: conversation.parentConversationId ?? conversation.conversationId,
                accountId: conversation.accountId,
                threadId: conversation.threadId,
                payload: {
                  text: chunk,
                  channelData: {
                    telegram: {
                      buttons: payload.buttons,
                    },
                  },
                },
              })
            : await this.sendTelegramTextChunk(outbound, conversation, chunk, {
                buttons: index === textChunks.length - 1 ? payload.buttons : undefined,
              });
        if (!delivered || index === textChunks.length - 1) {
          delivered = {
            provider: "telegram",
            messageId: result.messageId,
            chatId:
              typeof result.chatId === "string"
                ? result.chatId
                : conversation.parentConversationId ?? conversation.conversationId,
          };
        }
      }
      this.api.logger.debug?.(
        `codex outbound send complete ${this.formatConversationForLog(conversation)} channel=telegram chunks=${textChunks.length} media=no`,
      );
      return delivered;
    }
    if (isDiscordChannel(conversation.channel)) {
      const outbound = await this.loadDiscordOutboundAdapter();
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
      let delivered: DeliveredMessageRef | null = null;
      if (payload.buttons && payload.buttons.length > 0) {
        this.api.logger.debug(
          `codex discord reply send conversation=${conversation.conversationId} rows=${payload.buttons.length}`,
        );
        const attachmentChunk = hasMedia ? (chunks.shift() ?? text) : undefined;
        if (hasMedia) {
          const result = await this.sendDiscordTextChunk(outbound, conversation, attachmentChunk ?? "", {
            mediaUrl: payload.mediaUrl,
            mediaLocalRoots,
          });
          delivered = {
            provider: "discord",
            messageId: result.messageId,
            channelId:
              typeof result.channelId === "string"
                ? result.channelId
                : conversation.conversationId,
          };
        }
        const finalChunk = chunks.pop() ?? (hasMedia ? "" : text);
        for (const chunk of chunks) {
          const result = await this.sendDiscordTextChunk(outbound, conversation, chunk);
          if (!delivered) {
            delivered = {
              provider: "discord",
              messageId: result.messageId,
              channelId:
                typeof result.channelId === "string"
                  ? result.channelId
                  : conversation.conversationId,
            };
          }
        }
        const result = outbound?.sendPayload
          ? await outbound.sendPayload({
              cfg: this.getOpenClawConfig(),
              to: conversation.conversationId,
              accountId: conversation.accountId,
              threadId: conversation.threadId,
              mediaLocalRoots,
              payload: {
                text: finalChunk,
                channelData: {
                  discord: {
                    components: this.buildDiscordPickerSpec({
                      text: finalChunk,
                      buttons: payload.buttons,
                    }),
                  },
                },
              },
            })
          : await this.sendDiscordPickerMessageLegacy(conversation, {
              text: finalChunk,
              buttons: payload.buttons,
            });
        if (
          result &&
          typeof result === "object" &&
          typeof (result as { messageId?: unknown }).messageId === "string" &&
          typeof (result as { channelId?: unknown }).channelId === "string"
        ) {
          delivered = {
            provider: "discord",
            messageId: (result as { messageId: string }).messageId,
            channelId:
              typeof (result as { channelId?: unknown }).channelId === "string"
                ? (result as { channelId: string }).channelId
                : conversation.conversationId,
          };
        }
        this.api.logger.debug?.(
          `codex outbound send complete ${this.formatConversationForLog(conversation)} channel=discord chunks=${chunks.length + 1 + (hasMedia ? 1 : 0)} media=${hasMedia ? "yes" : "no"} buttons=${payload.buttons.length}`,
        );
        return delivered;
      }
      const textChunks = chunks.length > 0 ? chunks : [text];
      if (hasMedia) {
        const firstChunk = textChunks.shift() ?? "";
        const result = await this.sendDiscordTextChunk(outbound, conversation, firstChunk, {
          mediaUrl: payload.mediaUrl,
          mediaLocalRoots,
        });
        delivered = {
          provider: "discord",
          messageId: result.messageId,
          channelId:
            typeof result.channelId === "string" ? result.channelId : conversation.conversationId,
        };
      }
      for (const chunk of textChunks) {
        if (!chunk) {
          continue;
        }
        const result = await this.sendDiscordTextChunk(outbound, conversation, chunk);
        if (!delivered) {
          delivered = {
            provider: "discord",
            messageId: result.messageId,
            channelId:
              typeof result.channelId === "string"
                ? result.channelId
                : conversation.conversationId,
          };
        }
      }
      this.api.logger.debug?.(
        `codex outbound send complete ${this.formatConversationForLog(conversation)} channel=discord chunks=${textChunks.length + (hasMedia ? 1 : 0)} media=${hasMedia ? "yes" : "no"}`,
      );
      return delivered;
    }
    return null;
  }

  private getOpenClawConfig(): unknown {
    return this.lastRuntimeConfig ?? (this.api as OpenClawPluginApi & { config?: unknown }).config;
  }

  private async loadTelegramOutboundAdapter(): Promise<TelegramOutboundAdapter | undefined> {
    const loadAdapter = this.api.runtime.channel.outbound?.loadAdapter;
    if (typeof loadAdapter !== "function") {
      return undefined;
    }
    return (await loadAdapter("telegram")) as TelegramOutboundAdapter | undefined;
  }

  private async loadDiscordOutboundAdapter(): Promise<DiscordOutboundAdapter | undefined> {
    const loadAdapter = this.api.runtime.channel.outbound?.loadAdapter;
    if (typeof loadAdapter !== "function") {
      return undefined;
    }
    return (await loadAdapter("discord")) as DiscordOutboundAdapter | undefined;
  }

  private async sendTelegramTextChunk(
    outbound: TelegramOutboundAdapter | undefined,
    conversation: ConversationTarget,
    text: string,
    opts?: { buttons?: PluginInteractiveButtons },
  ): Promise<{ messageId: string; chatId?: string }> {
    const target = conversation.parentConversationId ?? conversation.conversationId;
    const buttons = opts?.buttons;
    if (buttons && outbound?.sendPayload) {
      return await outbound.sendPayload({
        cfg: this.getOpenClawConfig(),
        to: target,
        payload: {
          text,
          channelData: {
            telegram: {
              buttons,
            },
          },
        },
        accountId: conversation.accountId,
        threadId: conversation.threadId,
      });
    }
    const legacySend = this.api.runtime.channel.telegram?.sendMessageTelegram;
    if (buttons && typeof legacySend === "function") {
      return await legacySend(target, text, {
        accountId: conversation.accountId,
        messageThreadId: typeof conversation.threadId === "number" ? conversation.threadId : undefined,
        buttons,
      });
    }
    if (outbound?.sendText) {
      return await outbound.sendText({
        cfg: this.getOpenClawConfig(),
        to: target,
        text,
        accountId: conversation.accountId,
        threadId: conversation.threadId,
      });
    }
    if (typeof legacySend !== "function") {
      throw new Error("Telegram send runtime unavailable");
    }
    return await legacySend(target, text, {
      accountId: conversation.accountId,
      messageThreadId: typeof conversation.threadId === "number" ? conversation.threadId : undefined,
      buttons,
    });
  }

  private async sendTelegramMediaChunk(
    outbound: TelegramOutboundAdapter | undefined,
    conversation: ConversationTarget,
    text: string,
    opts: {
      mediaUrl?: string;
      mediaLocalRoots?: readonly string[];
      buttons?: PluginInteractiveButtons;
    },
  ): Promise<{ messageId: string; chatId?: string }> {
    if (!opts.mediaUrl) {
      throw new Error("Telegram media send requires mediaUrl");
    }
    const target = conversation.parentConversationId ?? conversation.conversationId;
    if (opts.buttons && outbound?.sendPayload) {
      return await outbound.sendPayload({
        cfg: this.getOpenClawConfig(),
        to: target,
        payload: {
          text,
          mediaUrl: opts.mediaUrl,
          channelData: {
            telegram: {
              buttons: opts.buttons,
            },
          },
        },
        mediaLocalRoots: opts.mediaLocalRoots,
        accountId: conversation.accountId,
        threadId: conversation.threadId,
      });
    }
    const legacySend = this.api.runtime.channel.telegram?.sendMessageTelegram;
    if (opts.buttons && typeof legacySend === "function") {
      return await legacySend(target, text, {
        accountId: conversation.accountId,
        messageThreadId: typeof conversation.threadId === "number" ? conversation.threadId : undefined,
        mediaUrl: opts.mediaUrl,
        mediaLocalRoots: opts.mediaLocalRoots,
        buttons: opts.buttons,
      });
    }
    if (outbound?.sendMedia) {
      return await outbound.sendMedia({
        cfg: this.getOpenClawConfig(),
        to: target,
        text,
        mediaUrl: opts.mediaUrl,
        mediaLocalRoots: opts.mediaLocalRoots,
        accountId: conversation.accountId,
        threadId: conversation.threadId,
      });
    }
    if (typeof legacySend !== "function") {
      throw new Error("Telegram media send runtime unavailable");
    }
    return await legacySend(target, text, {
      accountId: conversation.accountId,
      messageThreadId: typeof conversation.threadId === "number" ? conversation.threadId : undefined,
      mediaUrl: opts.mediaUrl,
      mediaLocalRoots: opts.mediaLocalRoots,
      buttons: opts.buttons,
    });
  }

  private async sendDiscordTextChunk(
    outbound: DiscordOutboundAdapter | undefined,
    conversation: ConversationTarget,
    text: string,
    opts?: { mediaUrl?: string; mediaLocalRoots?: readonly string[] },
  ): Promise<{ messageId: string; channelId?: string }> {
    const mediaUrl = opts?.mediaUrl;
    const mediaLocalRoots = opts?.mediaLocalRoots;
    if (mediaUrl && outbound?.sendMedia) {
      return await outbound.sendMedia({
        cfg: this.getOpenClawConfig(),
        to: conversation.conversationId,
        text,
        mediaUrl,
        accountId: conversation.accountId,
        threadId: conversation.threadId,
        mediaLocalRoots,
      });
    }
    if (!mediaUrl && outbound?.sendText) {
      return await outbound.sendText({
        cfg: this.getOpenClawConfig(),
        to: conversation.conversationId,
        text,
        accountId: conversation.accountId,
        threadId: conversation.threadId,
      });
    }
    const legacySend = (this.api.runtime.channel as {
      discord?: {
        sendMessageDiscord?: (
          to: string,
          text: string,
          opts?: {
            accountId?: string;
            mediaUrl?: string;
            mediaLocalRoots?: readonly string[];
          },
        ) => Promise<{ messageId: string; channelId: string }>;
      };
    }).discord?.sendMessageDiscord;
    if (typeof legacySend === "function") {
      return await legacySend(conversation.conversationId, text, {
        accountId: conversation.accountId,
        mediaUrl,
        mediaLocalRoots,
      });
    }
    const runtimeApi = await this.loadDiscordRuntimeApi();
    if (typeof runtimeApi?.sendMessageDiscord === "function") {
      return await runtimeApi.sendMessageDiscord(conversation.conversationId, text, {
        cfg: this.getOpenClawConfig(),
        accountId: conversation.accountId,
        mediaUrl,
        mediaLocalRoots,
      });
    }
    throw new Error("Discord outbound messaging is unavailable.");
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
    refresh?: () => Promise<void>;
  } | null> {
    if (isTelegramChannel(conversation.channel)) {
      const legacyTyping = this.api.runtime.channel.telegram?.typing?.start;
      if (typeof legacyTyping === "function") {
        return await legacyTyping({
          to: conversation.parentConversationId ?? conversation.conversationId,
          accountId: conversation.accountId,
          messageThreadId: conversation.threadId,
        });
      }
      return await this.startTelegramTypingLease(conversation);
    }
    if (isDiscordChannel(conversation.channel)) {
      if (conversation.conversationId.startsWith("user:")) {
        return null;
      }
      const channelId =
        denormalizeDiscordConversationId(conversation.conversationId) ?? conversation.conversationId;
      const legacyTyping = (this.api.runtime.channel as {
        discord?: {
          typing?: {
            start?: (params: {
              channelId: string;
              accountId?: string;
            }) => Promise<{ refresh: () => Promise<void>; stop: () => void }>;
          };
        };
      }).discord?.typing?.start;
      if (typeof legacyTyping !== "function") {
        const runtimeApi = await this.loadDiscordRuntimeApi();
        if (typeof runtimeApi?.sendTypingDiscord !== "function") {
          return null;
        }
        const sendTyping = async () => {
          await runtimeApi.sendTypingDiscord?.(channelId, {
            cfg: this.getOpenClawConfig(),
            accountId: conversation.accountId,
          });
        };
        await sendTyping().catch((error) => {
          this.api.logger.debug?.(`codex discord typing skipped: ${String(error)}`);
        });
        const timer = setInterval(() => {
          void sendTyping().catch((error) => {
            this.api.logger.debug?.(`codex discord typing refresh failed: ${String(error)}`);
          });
        }, 4_000);
        return {
          refresh: sendTyping,
          stop: () => clearInterval(timer),
        };
      }
      return await legacyTyping({
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
      const outbound = await this.loadTelegramOutboundAdapter();
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
        const result = await this.sendTelegramTextChunk(outbound, conversation, chunk);
        if (!firstDelivered) {
          firstDelivered = {
            provider: "telegram",
            messageId: result.messageId,
            chatId:
              typeof result.chatId === "string"
                ? result.chatId
                : conversation.parentConversationId ?? conversation.conversationId,
          };
        }
      }
      return firstDelivered;
    }
    if (isDiscordChannel(conversation.channel)) {
      const outbound = await this.loadDiscordOutboundAdapter();
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
        const result = await this.sendDiscordTextChunk(outbound, conversation, chunk);
        if (!firstDelivered) {
          firstDelivered = {
            provider: "discord",
            messageId: result.messageId,
            channelId:
              typeof result.channelId === "string"
                ? result.channelId
                : conversation.conversationId,
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
    const legacyResolution = this.api.runtime.channel.telegram?.resolveTelegramToken?.(
      this.getOpenClawConfig(),
      { accountId },
    );
    const legacyToken = legacyResolution?.token?.trim();
    if (legacyToken) {
      return legacyToken;
    }
    const cfg = this.getOpenClawConfig();
    if (!cfg) {
      return undefined;
    }
    try {
      const telegramAccount = await this.loadTelegramAccountSdk();
      const account = telegramAccount.resolveTelegramAccount({
        cfg,
        accountId,
      });
      const token = account?.token?.trim();
      return token || undefined;
    } catch (error) {
      this.api.logger.debug?.(`codex telegram account facade unavailable: ${String(error)}`);
      return undefined;
    }
  }

  private async resolveDiscordBotToken(accountId?: string): Promise<string | undefined> {
    const cfg = this.lastRuntimeConfig;
    if (!cfg) {
      return undefined;
    }
    try {
      const discordSdk = await this.loadDiscordSdk();
      const account = discordSdk.resolveDiscordAccount({
        cfg: cfg as Parameters<DiscordSdkModule["resolveDiscordAccount"]>[0]["cfg"],
        accountId,
      });
      const token = account.token?.trim();
      if (token) {
        return token;
      }
    } catch (error) {
      this.api.logger.debug?.(`codex discord account facade unavailable: ${String(error)}`);
    }
    const discordApi = await this.loadDiscordExtensionApi();
    const account = discordApi?.resolveDiscordAccount?.({
      cfg,
      accountId,
    });
    const token = account?.token?.trim();
    return token || undefined;
  }

  private async startTelegramTypingLease(conversation: ConversationTarget): Promise<{
    refresh: () => Promise<void>;
    stop: () => void;
  } | null> {
    const token = await this.resolveTelegramBotToken(conversation.accountId);
    if (!token) {
      return null;
    }
    const body = {
      chat_id: conversation.parentConversationId ?? conversation.conversationId,
      action: "typing",
      ...(conversation.threadId != null ? { message_thread_id: conversation.threadId } : {}),
    };
    const sendTyping = async () => {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(
          `Telegram sendChatAction failed status=${response.status} body=${await response.text()}`,
        );
      }
    };
    await sendTyping().catch((error) => {
      this.api.logger.debug?.(`codex telegram typing skipped: ${String(error)}`);
    });
    const timer = setInterval(() => {
      void sendTyping().catch((error) => {
        this.api.logger.debug?.(`codex telegram typing refresh failed: ${String(error)}`);
      });
    }, 4_000);
    return {
      refresh: sendTyping,
      stop: () => clearInterval(timer),
    };
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

  private async callTelegramBotApi(
    method: string,
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
    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(
        `Telegram ${method} failed status=${response.status} body=${responseText}`,
      );
    }
    const trimmedBody = responseText.trim();
    if (!trimmedBody) {
      return;
    }
    try {
      const parsed = JSON.parse(trimmedBody) as { ok?: unknown; description?: unknown };
      if (parsed.ok === false) {
        const description =
          typeof parsed.description === "string" && parsed.description.trim()
            ? parsed.description.trim()
            : trimmedBody;
        throw new Error(`Telegram ${method} failed body=${description}`);
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        return;
      }
      throw error;
    }
  }

  private async callTelegramPinApi(
    method: "pinChatMessage" | "unpinChatMessage",
    token: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await this.callTelegramBotApi(method, token, body);
  }

  private async callTelegramEditMessageApi(
    token: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await this.callTelegramBotApi("editMessageText", token, body);
  }

  private async callTelegramTopicEditApi(
    token: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await this.callTelegramBotApi("editForumTopic", token, body);
  }

  private async renameConversationIfSupported(
    conversation: ConversationTarget,
    name: string,
  ): Promise<void> {
    if (isTelegramChannel(conversation.channel) && conversation.threadId != null) {
      const legacyRename = this.api.runtime.channel.telegram?.conversationActions?.renameTopic;
      if (typeof legacyRename === "function") {
        await legacyRename(
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
      const token = await this.resolveTelegramBotToken(conversation.accountId);
      if (!token) {
        return;
      }
      await this.callTelegramTopicEditApi(token, {
        chat_id: conversation.parentConversationId ?? conversation.conversationId,
        message_thread_id: conversation.threadId,
        name,
      }).catch((error) => {
        this.api.logger.warn(`codex telegram topic rename failed: ${String(error)}`);
      });
      return;
    }
    if (isDiscordChannel(conversation.channel)) {
      const legacyEditChannel = (this.api.runtime.channel as {
        discord?: {
          conversationActions?: {
            editChannel?: (
              channelId: string,
              params: { name?: string },
              opts?: { accountId?: string },
            ) => Promise<unknown>;
          };
        };
      }).discord?.conversationActions?.editChannel;
      if (typeof legacyEditChannel !== "function") {
        const runtimeApi = await this.loadDiscordRuntimeApi();
        if (typeof runtimeApi?.editChannelDiscord !== "function") {
          return;
        }
        await runtimeApi.editChannelDiscord(
          {
            channelId:
              denormalizeDiscordConversationId(conversation.conversationId) ??
              conversation.conversationId,
            name,
          },
          {
            cfg: this.getOpenClawConfig(),
            accountId: conversation.accountId,
          },
        ).catch((error) => {
          this.api.logger.warn(`codex discord channel rename failed: ${String(error)}`);
        });
        return;
      }
      await legacyEditChannel(
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
