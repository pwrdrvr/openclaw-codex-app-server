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
    messageThreadId?: number;
  };

  export type PluginInteractiveButtons = Array<
    Array<{ text: string; callback_data: string; style?: "danger" | "success" | "primary" }>
  >;

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
        telegram: {
          sendMessageTelegram: (
            to: string,
            text: string,
            opts?: {
              accountId?: string;
              messageThreadId?: number;
              buttons?: PluginInteractiveButtons;
            },
          ) => Promise<unknown>;
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
            opts?: { accountId?: string },
          ) => Promise<unknown>;
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
      }) => Promise<{ handled: boolean }> | { handled: boolean },
    ) => void;
  };
}

declare module "ws" {
  const WebSocket: any;
  export default WebSocket;
}
