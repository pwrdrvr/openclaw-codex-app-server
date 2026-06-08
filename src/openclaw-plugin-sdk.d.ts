declare module "openclaw/plugin-sdk" {
  export type ReplyPayload = {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    replyToId?: string;
    replyToTag?: boolean;
    replyToCurrent?: boolean;
    audioAsVoice?: boolean;
    isError?: boolean;
    isReasoning?: boolean;
    channelData?: Record<string, unknown>;
  };

  export type ConversationRef = {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  };

  export type PluginLogger = {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
    debug: (message: string) => void;
  };

  export type PluginInboundMedia = {
    kind: "image" | "audio" | "video" | "document";
    path?: string;
    url?: string;
    mimeType?: string;
    fileName?: string;
    source?: "attachment" | "staged" | "remote" | "metadata";
  };

  export type PluginCommandContext = {
    senderId?: string;
    channel: string;
    channelId?: string;
    isAuthorizedSender: boolean;
    args?: string;
    commandBody: string;
    config: unknown;
    from?: string;
    to?: string;
    accountId?: string;
    messageThreadId?: string | number;
    threadParentId?: string;
    media?: PluginInboundMedia[];
  };

  export type PluginInteractiveButtons = Array<
    Array<{ text: string; callback_data: string; style?: "danger" | "success" | "primary" }>
  >;

  export type PluginConversationBinding = {
    bindingId: string;
    pluginId: string;
    pluginName?: string;
    pluginRoot: string;
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
    threadId?: string | number;
    boundAt: number;
    summary?: string;
    detachHint?: string;
  };

  export type PluginConversationBindingResolutionDecision = "allow-once" | "allow-always" | "deny";

  export type PluginConversationBindingResolvedEvent = {
    status: "approved" | "denied";
    binding?: PluginConversationBinding;
    decision: PluginConversationBindingResolutionDecision;
    request: {
      summary?: string;
      detachHint?: string;
      requestedBySenderId?: string;
      conversation: {
        channel: string;
        accountId: string;
        conversationId: string;
        parentConversationId?: string;
        threadId?: string | number;
      };
    };
  };

  export type PluginInteractiveTelegramHandlerContext = {
    channel: "telegram";
    accountId: string;
    callbackId: string;
    conversationId: string;
    parentConversationId?: string;
    senderId?: string;
    senderUsername?: string;
    threadId?: number;
    isGroup: boolean;
    isForum: boolean;
    auth: { isAuthorizedSender: boolean };
    callback: {
      data: string;
      namespace: string;
      payload: string;
      messageId: number;
      chatId: string;
      messageText?: string;
    };
    respond: {
      reply: (params: { text: string; buttons?: PluginInteractiveButtons }) => Promise<void>;
      editMessage: (params: { text: string; buttons?: PluginInteractiveButtons }) => Promise<void>;
      editButtons: (params: { buttons: PluginInteractiveButtons }) => Promise<void>;
      clearButtons: () => Promise<void>;
      deleteMessage: () => Promise<void>;
    };
  };

  export type PluginInteractiveDiscordHandlerContext = {
    channel: "discord";
    accountId: string;
    interactionId: string;
    conversationId: string;
    parentConversationId?: string;
    guildId?: string;
    senderId?: string;
    senderUsername?: string;
    auth: { isAuthorizedSender: boolean };
    interaction: {
      kind: "button" | "select" | "modal";
      data: string;
      namespace: string;
      payload: string;
      messageId?: string;
      values?: string[];
      fields?: Array<{ id: string; name: string; values: string[] }>;
    };
    respond: {
      acknowledge: () => Promise<void>;
      reply: (params: { text: string; ephemeral?: boolean }) => Promise<void>;
      followUp: (params: { text: string; ephemeral?: boolean }) => Promise<void>;
      editMessage: (params: { text?: string; components?: unknown[] }) => Promise<void>;
      clearComponents: (params?: { text?: string }) => Promise<void>;
    };
  };

  export type OpenClawPluginService = {
    id: string;
    start: (ctx: { workspaceDir?: string }) => void | Promise<void>;
    stop?: (ctx: { workspaceDir?: string }) => void | Promise<void>;
  };

  export type SessionBindingRecord = {
    targetSessionKey: string;
  };

  export type OpenClawPluginApi = {
    id: string;
    config: unknown;
    pluginConfig?: Record<string, unknown>;
    logger: PluginLogger;
    runtime: {
      state: {
        resolveStateDir: () => string;
      };
      channel: {
        bindings: {
          bind: (input: {
            targetSessionKey: string;
            targetKind: "session" | "subagent";
            conversation: ConversationRef;
            placement?: "current" | "child";
            metadata?: Record<string, unknown>;
          }) => Promise<unknown>;
          unbind: (input: {
            targetSessionKey?: string;
            bindingId?: string;
            reason: string;
          }) => Promise<unknown>;
          resolveByConversation: (ref: ConversationRef) => SessionBindingRecord | null;
        };
        text: {
          chunkText: (text: string, limit: number) => string[];
          resolveTextChunkLimit: (
            cfg: unknown,
            provider?: string,
            accountId?: string | null,
            opts?: { fallbackLimit?: number },
          ) => number;
        };
        outbound?: {
          loadAdapter: (channel: string) => Promise<
            | {
                sendText?: (ctx: {
                  cfg: unknown;
                  to: string;
                  text: string;
                  accountId?: string;
                  threadId?: string | number;
                }) => Promise<{ messageId: string; chatId?: string; channelId?: string }>;
                sendMedia?: (ctx: {
                  cfg: unknown;
                  to: string;
                  text: string;
                  mediaUrl: string;
                  accountId?: string;
                  threadId?: string | number;
                  mediaLocalRoots?: readonly string[];
                }) => Promise<{ messageId: string; chatId?: string; channelId?: string }>;
                sendPayload?: (ctx: {
                  cfg: unknown;
                  to: string;
                  payload: ReplyPayload;
                  accountId?: string;
                  threadId?: string | number;
                  mediaLocalRoots?: readonly string[];
                }) => Promise<{ messageId: string; chatId?: string; channelId?: string }>;
              }
            | undefined
          >;
        };
        telegram: {
          sendMessageTelegram: (
            to: string,
            text: string,
            opts?: {
              accountId?: string;
              messageThreadId?: number;
              mediaUrl?: string;
              mediaLocalRoots?: readonly string[];
              plainText?: string;
              textMode?: "markdown" | "html";
              buttons?: PluginInteractiveButtons;
            },
          ) => Promise<{ messageId: string; chatId: string }>;
          resolveTelegramToken: (
            cfg?: unknown,
            opts?: {
              envToken?: string | null;
              accountId?: string | null;
              logMissingFile?: (message: string) => void;
            },
          ) => { token: string; source: string };
          typing: {
            start: (params: {
              to: string;
              accountId?: string;
              messageThreadId?: number;
            }) => Promise<{ refresh: () => Promise<void>; stop: () => void }>;
          };
          conversationActions: {
            renameTopic: (
              chatId: string,
              messageThreadId: number,
              name: string,
              opts?: { accountId?: string },
            ) => Promise<unknown>;
          };
        };
        discord: {
          sendMessageDiscord: (
            to: string,
            text: string,
            opts?: {
              accountId?: string;
              mediaUrl?: string;
              mediaLocalRoots?: readonly string[];
            },
          ) => Promise<{ messageId: string; channelId: string }>;
          sendComponentMessage: (
            to: string,
            spec: unknown,
            opts?: { accountId?: string },
          ) => Promise<unknown>;
          typing: {
            start: (params: {
              channelId: string;
              accountId?: string;
            }) => Promise<{ refresh: () => Promise<void>; stop: () => void }>;
          };
          conversationActions: {
            editChannel: (
              channelId: string,
              params: { name?: string },
              opts?: { accountId?: string },
            ) => Promise<unknown>;
          };
        };
      };
    };
    registerService: (service: OpenClawPluginService) => void;
    registerInteractiveHandler: (registration: {
      channel: "telegram" | "discord";
      namespace: string;
      handler: (ctx: any) => Promise<{ handled?: boolean } | void> | { handled?: boolean } | void;
    }) => void;
    onConversationBindingResolved: (
      handler: (event: PluginConversationBindingResolvedEvent) => void | Promise<void>,
    ) => void;
    registerCommand: (command: {
      name: string;
      description: string;
      acceptsArgs?: boolean;
      handler: (ctx: PluginCommandContext) => Promise<ReplyPayload> | ReplyPayload;
    }) => void;
    on: (
      hookName: "inbound_claim",
      handler: (event: {
        content: string;
        channel: string;
        accountId?: string;
        conversationId?: string;
        parentConversationId?: string;
        threadId?: string | number;
        media?: PluginInboundMedia[];
      }) => Promise<{ handled: boolean }> | { handled: boolean },
    ) => void;
  };
}

declare module "openclaw/plugin-sdk/discord" {
  export type DiscordComponentMessageSpec = {
    text?: string;
    blocks?: Array<{
      type: "actions";
      buttons?: Array<{
        label: string;
        style?: "primary" | "secondary" | "success" | "danger" | "link";
        callbackData?: string;
      }>;
    }>;
  };

  export function resolveDiscordAccount(...args: any[]): any;

  export function buildDiscordComponentMessage(params: {
    spec: DiscordComponentMessageSpec;
    fallbackText?: string;
    sessionKey?: string;
    agentId?: string;
    accountId?: string;
  }): {
    components: unknown[];
    entries: unknown[];
    modals: unknown[];
  };

  export function editDiscordComponentMessage(
    to: string,
    messageId: string,
    spec: DiscordComponentMessageSpec,
    opts?: {
      accountId?: string;
    },
  ): Promise<{
    messageId: string;
    channelId: string;
  }>;

  export function registerBuiltDiscordComponentMessage(params: {
    buildResult: {
      components: unknown[];
      entries: unknown[];
      modals: unknown[];
    };
    messageId: string;
  }): void;
}

declare module "openclaw/plugin-sdk/telegram-account" {
  export function resolveTelegramAccount(...args: any[]): any;
}

declare module "ws" {
  const WebSocket: any;
  export default WebSocket;
}
