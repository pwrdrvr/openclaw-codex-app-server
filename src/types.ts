import type { ConversationRef, PluginInteractiveButtons } from "openclaw/plugin-sdk";

export const PLUGIN_ID = "openclaw-codex-app-server";
export const INTERACTIVE_NAMESPACE = "codexapp";
export const STORE_VERSION = 1;
export const CALLBACK_TOKEN_BYTES = 9;
export const CALLBACK_TTL_MS = 30 * 60_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const DEFAULT_INPUT_TIMEOUT_MS = 15 * 60_000;

export type CodexTransport = "stdio" | "websocket";

export type PluginSettings = {
  enabled: boolean;
  transport: CodexTransport;
  command: string;
  args: string[];
  url?: string;
  headers?: Record<string, string>;
  requestTimeoutMs: number;
  inputTimeoutMs: number;
  defaultWorkspaceDir?: string;
  defaultModel?: string;
  defaultServiceTier?: string;
};

export type CodexPlanStep = {
  step: string;
  status: "pending" | "inProgress" | "completed";
};

export type CodexPlanArtifact = {
  explanation?: string;
  steps: CodexPlanStep[];
  markdown: string;
};

export type PendingApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export type PendingInputAction =
  | {
      kind: "approval";
      label: string;
      decision: PendingApprovalDecision;
      responseDecision: string;
      proposedExecpolicyAmendment?: Record<string, unknown>;
      sessionPrefix?: string;
    }
  | {
      kind: "option";
      label: string;
      value: string;
    }
  | {
      kind: "steer";
      label: string;
    };

export type PendingQuestionnaireOption = {
  key: string;
  label: string;
  description?: string;
  recommended?: boolean;
};

export type PendingQuestionnaireAnswer =
  | {
      kind: "option";
      optionKey: string;
      optionLabel: string;
    }
  | {
      kind: "text";
      text: string;
    };

export type PendingQuestionnaireQuestion = {
  index: number;
  id: string;
  header?: string;
  prompt: string;
  options: PendingQuestionnaireOption[];
  guidance: string[];
  allowFreeform?: boolean;
};

export type PendingQuestionnaireState = {
  questions: PendingQuestionnaireQuestion[];
  currentIndex: number;
  answers: Array<PendingQuestionnaireAnswer | null>;
  awaitingFreeform?: boolean;
  responseMode?: "structured" | "compact";
};

export type PendingInputState = {
  requestId: string;
  options: string[];
  actions?: PendingInputAction[];
  expiresAt: number;
  promptText?: string;
  method?: string;
  questionnaire?: PendingQuestionnaireState;
};

export type ThreadSummary = {
  threadId: string;
  title?: string;
  summary?: string;
  projectKey?: string;
  createdAt?: number;
  updatedAt?: number;
  gitBranch?: string;
};

export type ModelSummary = {
  id: string;
  label?: string;
  description?: string;
  current?: boolean;
};

export type SkillSummary = {
  cwd?: string;
  name: string;
  description?: string;
  enabled?: boolean;
};

export type ExperimentalFeatureSummary = {
  name: string;
  stage?: string;
  displayName?: string;
  description?: string;
  enabled?: boolean;
  defaultEnabled?: boolean;
};

export type McpServerSummary = {
  name: string;
  authStatus?: string;
  toolCount: number;
  resourceCount: number;
  resourceTemplateCount: number;
};

export type RateLimitSummary = {
  name: string;
  limitId?: string;
  remaining?: number;
  limit?: number;
  used?: number;
  usedPercent?: number;
  resetAt?: number;
  windowSeconds?: number;
  windowMinutes?: number;
};

export type ThreadState = {
  threadId: string;
  threadName?: string;
  model?: string;
  modelProvider?: string;
  serviceTier?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: string;
  reasoningEffort?: string;
};

export type ThreadReplay = {
  lastUserMessage?: string;
  lastAssistantMessage?: string;
};

export type AccountSummary = {
  type?: "apiKey" | "chatgpt";
  email?: string;
  planType?: string;
  requiresOpenaiAuth?: boolean;
};

export type ContextUsageSnapshot = {
  totalTokens?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  contextWindow?: number;
  remainingTokens?: number;
  remainingPercent?: number;
};

export type CompactProgress =
  | {
      phase: "started" | "completed";
      itemId?: string;
      usage?: ContextUsageSnapshot;
    }
  | {
      phase: "usage";
      usage: ContextUsageSnapshot;
    };

export type CompactResult = {
  itemId?: string;
  usage?: ContextUsageSnapshot;
};

export type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "custom"; instructions: string };

export type CollaborationMode = {
  mode: string;
  settings?: {
    model?: string;
    reasoningEffort?: string;
    developerInstructions?: string | null;
  };
};

export type ReviewResult = {
  reviewText: string;
  reviewThreadId?: string;
  turnId?: string;
  aborted?: boolean;
};

export type TurnTerminalError = {
  message?: string;
  codexErrorInfo?: string;
  httpStatusCode?: number;
};

export type TurnResult = {
  threadId: string;
  text?: string;
  planArtifact?: CodexPlanArtifact;
  aborted?: boolean;
  stoppedReason?: "interrupt" | "cancelled" | "approval";
  terminalStatus?: "completed" | "interrupted" | "failed";
  terminalError?: TurnTerminalError;
  usage?: ContextUsageSnapshot;
};

export type StoredBinding = {
  conversation: ConversationRef;
  sessionKey: string;
  threadId: string;
  workspaceDir: string;
  threadTitle?: string;
  pinnedBindingMessage?:
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
  contextUsage?: ContextUsageSnapshot;
  updatedAt: number;
};

export type StoredPendingBind = {
  conversation: ConversationRef;
  threadId: string;
  workspaceDir: string;
  threadTitle?: string;
  syncTopic?: boolean;
  notifyBound?: boolean;
  updatedAt: number;
};

export type StoredPendingRequest = {
  requestId: string;
  conversation: ConversationRef;
  threadId: string;
  workspaceDir: string;
  state: PendingInputState;
  updatedAt: number;
};

export type CallbackAction =
  | {
      token: string;
      kind: "resume-thread";
      conversation: ConversationRef;
      threadId: string;
      workspaceDir: string;
      syncTopic?: boolean;
      createdAt: number;
      expiresAt: number;
    }
  | {
      token: string;
      kind: "pending-input";
      conversation: ConversationRef;
      requestId: string;
      actionIndex: number;
      createdAt: number;
      expiresAt: number;
    }
  | {
      token: string;
      kind: "pending-questionnaire";
      conversation: ConversationRef;
      requestId: string;
      questionIndex: number;
      action: "select" | "prev" | "next" | "freeform";
      optionIndex?: number;
      createdAt: number;
      expiresAt: number;
    }
  | {
      token: string;
      kind: "picker-view";
      conversation: ConversationRef;
      view:
        | {
            mode: "threads";
            includeAll: boolean;
            page: number;
            syncTopic?: boolean;
            query?: string;
            workspaceDir?: string;
            projectName?: string;
          }
        | {
            mode: "projects";
            includeAll: boolean;
            page: number;
            syncTopic?: boolean;
            query?: string;
            workspaceDir?: string;
          };
      createdAt: number;
      expiresAt: number;
    }
  | {
      token: string;
      kind: "run-prompt";
      conversation: ConversationRef;
      prompt: string;
      workspaceDir?: string;
      collaborationMode?: CollaborationMode;
      createdAt: number;
      expiresAt: number;
    }
  | {
      token: string;
      kind: "set-model";
      conversation: ConversationRef;
      model: string;
      createdAt: number;
      expiresAt: number;
    }
  | {
      token: string;
      kind: "reply-text";
      conversation: ConversationRef;
      text: string;
      createdAt: number;
      expiresAt: number;
    }
  | {
      token: string;
      kind: "rename-thread";
      conversation: ConversationRef;
      style: "thread-project" | "thread";
      syncTopic: boolean;
      createdAt: number;
      expiresAt: number;
    };

export type StoreSnapshot = {
  version: number;
  bindings: StoredBinding[];
  pendingBinds: StoredPendingBind[];
  pendingRequests: StoredPendingRequest[];
  callbacks: CallbackAction[];
};

export type ConversationTarget = ConversationRef & {
  threadId?: number;
};

export type CommandButtons = PluginInteractiveButtons;
