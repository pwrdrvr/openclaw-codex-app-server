import os from "node:os";
import type {
  AccountSummary,
  ContextUsageSnapshot,
  ExperimentalFeatureSummary,
  McpServerSummary,
  ModelSummary,
  RateLimitSummary,
  ReviewResult,
  SkillSummary,
  StoredBinding,
  ThreadReplay,
  ThreadState,
  ThreadSummary,
  TurnResult,
} from "./types.js";
import { getProjectName } from "./thread-picker.js";

function formatDateAge(value?: number): string | undefined {
  if (!value) {
    return undefined;
  }
  const deltaMs = Math.max(0, Date.now() - value);
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }
  const keep = maxLength - 3;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${value.slice(0, left)}...${value.slice(value.length - right)}`;
}

function formatThreadButtonTitle(thread: ThreadSummary): string {
  return thread.title?.trim() || thread.threadId;
}

function formatCompactAge(value?: number): string | undefined {
  if (!value) {
    return undefined;
  }
  const deltaMs = Math.max(0, Date.now() - value);
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes < 1) {
    return "0m";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function isLikelyWorktreePath(value?: string): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed && /[/\\]worktrees[/\\][^/\\]+[/\\][^/\\]+/.test(trimmed));
}

export function formatBinding(binding: StoredBinding | null): string {
  if (!binding) {
    return "No Codex binding for this conversation.";
  }
  return [
    "Codex is bound to this conversation.",
    `Thread: ${binding.threadId}`,
    `Workspace: ${binding.workspaceDir}`,
    binding.threadTitle ? `Title: ${binding.threadTitle}` : "",
    "Plain text in this bound conversation routes to Codex.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatThreadPicker(threads: ThreadSummary[]): string {
  if (threads.length === 0) {
    return "No matching Codex threads found.";
  }
  return [
    "Choose a Codex thread:",
    ...threads.slice(0, 10).map((thread, index) => {
      const age = formatDateAge(thread.updatedAt ?? thread.createdAt);
      const parts = [
        `${index + 1}. ${thread.title || thread.threadId}`,
        age ? `updated ${age}` : "",
        thread.projectKey ? `cwd ${thread.projectKey}` : "",
      ].filter(Boolean);
      return parts.join(" - ");
    }),
  ].join("\n");
}

export function formatThreadButtonLabel(params: {
  thread: ThreadSummary;
  includeProjectSuffix: boolean;
  isWorktree?: boolean;
  hasChanges?: boolean;
  maxLength?: number;
}): string {
  const title = formatThreadButtonTitle(params.thread);
  const projectBadge = params.includeProjectSuffix ? getProjectName(params.thread.projectKey) : undefined;
  const projectSuffix = projectBadge ? ` (${projectBadge})` : "";
  const ageSuffix = [
    formatCompactAge(params.thread.updatedAt) ? `U:${formatCompactAge(params.thread.updatedAt)}` : undefined,
    formatCompactAge(params.thread.createdAt) ? `C:${formatCompactAge(params.thread.createdAt)}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const iconPrefix = [
    params.isWorktree ? "🌿" : undefined,
    params.hasChanges ? "✏️" : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const maxLength = params.maxLength ?? 72;
  const reservedLength =
    (iconPrefix ? `${iconPrefix} `.length : 0) +
    projectSuffix.length +
    (ageSuffix ? ` ${ageSuffix}`.length : 0);
  const titleBudget = Math.max(12, maxLength - reservedLength);
  const clippedTitle = truncateMiddle(title, titleBudget);
  return [iconPrefix, `${clippedTitle}${projectSuffix}`, ageSuffix].filter(Boolean).join(" ");
}

export function formatThreadPickerIntro(params: {
  page: number;
  totalPages: number;
  totalItems: number;
  includeAll: boolean;
  syncTopic?: boolean;
  projectName?: string;
  workspaceDir?: string;
}): string {
  const pageLabel = `Page ${params.page + 1}/${params.totalPages}`;
  const scopeLabel = params.projectName
    ? `Showing recent Codex sessions for ${params.projectName}.`
    : params.includeAll
      ? "Showing recent Codex sessions across all projects."
      : params.workspaceDir
        ? `Showing recent Codex sessions for ${getProjectName(params.workspaceDir) ?? "this project"}.`
        : "Showing recent Codex sessions.";
  return [
    `${scopeLabel} ${pageLabel}.`,
    "Legend: 🌿 worktree, ✏️ uncommitted changes, U updated, C created.",
    params.syncTopic
      ? "Choosing a session will also try to sync the current channel/topic name."
      : "",
    `Tap a session to resume it. Use Projects to browse by project or \`--cwd /path/to/project\` to narrow to one workspace.`,
    params.totalItems === 0 ? "No matching Codex threads found." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatProjectPickerIntro(params: {
  page: number;
  totalPages: number;
  totalItems: number;
  workspaceDir?: string;
}): string {
  const scopeLabel = params.workspaceDir
    ? `Showing projects for ${getProjectName(params.workspaceDir) ?? "this workspace"}.`
    : "Choose a project to filter recent Codex sessions.";
  return [
    `${scopeLabel} Page ${params.page + 1}/${params.totalPages}.`,
    "Tap a project to show only that project's sessions. Use `--cwd /path/to/project` to target one exact workspace.",
    params.totalItems === 0 ? "No Codex projects found." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatThreadState(state: ThreadState, binding: StoredBinding | null): string {
  return [
    binding ? "Bound conversation status:" : "Codex thread status:",
    `Thread: ${state.threadId}`,
    state.threadName ? `Name: ${state.threadName}` : "",
    state.model ? `Model: ${state.model}` : "",
    state.serviceTier ? `Service tier: ${state.serviceTier}` : "Service tier: default",
    state.cwd ? `Workspace: ${state.cwd}` : binding ? `Workspace: ${binding.workspaceDir}` : "",
    state.approvalPolicy ? `Permissions: ${state.approvalPolicy}` : "",
    state.sandbox ? `Sandbox: ${state.sandbox}` : "",
    "Plain text in this bound conversation routes to Codex.",
  ]
    .filter(Boolean)
    .join("\n");
}

function shortenHomePath(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const home = os.homedir().trim();
  if (!home) {
    return trimmed;
  }
  if (trimmed === home) {
    return "~";
  }
  if (trimmed.startsWith(`${home}/`)) {
    return `~/${trimmed.slice(home.length + 1)}`;
  }
  return trimmed;
}

function formatTokenCount(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "0";
  }
  const safe = Math.max(0, value);
  if (safe >= 1_000_000) {
    return `${(safe / 1_000_000).toFixed(1)}m`;
  }
  if (safe >= 1_000) {
    const precision = safe >= 10_000 ? 0 : 1;
    const formattedThousands = (safe / 1_000).toFixed(precision);
    if (Number(formattedThousands) >= 1_000) {
      return `${(safe / 1_000_000).toFixed(1)}m`;
    }
    return `${formattedThousands}k`;
  }
  return String(Math.round(safe));
}

export function formatCodexPermissions(params: {
  approvalPolicy?: string;
  sandbox?: string;
}): string | undefined {
  const approval = params.approvalPolicy?.trim();
  const sandbox = params.sandbox?.trim();
  if (!approval && !sandbox) {
    return undefined;
  }
  if (approval === "on-request" && sandbox === "workspace-write") {
    return "Default";
  }
  if (approval === "never" && sandbox === "danger-full-access") {
    return "Full Access";
  }
  if (approval && sandbox) {
    return `Custom (${sandbox}, ${approval})`;
  }
  return approval ?? sandbox;
}

export function formatCodexAccountText(account: AccountSummary | null | undefined): string {
  if (!account) {
    return "unknown";
  }
  if (account.type === "chatgpt" && account.email?.trim()) {
    return account.planType?.trim()
      ? `${account.email.trim()} (${account.planType.trim()})`
      : account.email.trim();
  }
  if (account.type === "apiKey") {
    return "API key";
  }
  if (account.requiresOpenaiAuth === false) {
    return "not required";
  }
  if (account.requiresOpenaiAuth === true) {
    return "not signed in";
  }
  return "unknown";
}

export function formatCodexModelText(threadState: ThreadState | undefined): string {
  const model = threadState?.model?.trim();
  const provider = threadState?.modelProvider?.trim();
  const reasoning = threadState?.reasoningEffort?.trim();
  const parts = [
    provider && model && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model,
  ].filter(Boolean) as string[];
  if (reasoning) {
    parts.push(`reasoning ${reasoning}`);
  }
  return parts.join(" · ") || "unknown";
}

function formatCodexFastModeValue(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return "off";
  }
  if (normalized === "default" || normalized === "auto") {
    return "off";
  }
  if (normalized === "fast" || normalized === "priority") {
    return "on";
  }
  return normalized;
}

function advanceCodexResetAtToNextWindow(params: {
  resetAt: number | undefined;
  windowSeconds?: number;
  nowMs: number;
}): number | undefined {
  const resetAt = params.resetAt;
  if (!resetAt || !Number.isFinite(resetAt)) {
    return undefined;
  }
  if (
    !params.windowSeconds ||
    !Number.isFinite(params.windowSeconds) ||
    params.windowSeconds <= 0
  ) {
    return resetAt;
  }
  const windowMs = Math.round(params.windowSeconds * 1_000);
  if (windowMs <= 0 || resetAt >= params.nowMs) {
    return resetAt;
  }
  const missedWindows = Math.floor((params.nowMs - resetAt) / windowMs) + 1;
  return resetAt + missedWindows * windowMs;
}

export function getCodexStatusTimeZoneLabel(): string | undefined {
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
  return timeZone || undefined;
}

function formatCodexRateLimitReset(params: {
  resetAt: number | undefined;
  windowSeconds?: number;
  nowMs?: number;
}): string | undefined {
  const nowMs = params.nowMs ?? Date.now();
  const normalizedResetAt = advanceCodexResetAtToNextWindow({
    resetAt: params.resetAt,
    windowSeconds: params.windowSeconds,
    nowMs,
  });
  if (!normalizedResetAt || !Number.isFinite(normalizedResetAt)) {
    return undefined;
  }
  const now = new Date(nowMs);
  const date = new Date(normalizedResetAt);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const sameDay = now.toDateString() === date.toDateString();
  if (sameDay) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

export function formatCodexRateLimitLine(
  limit: RateLimitSummary,
  nowMs = Date.now(),
): string {
  const prefix = `${limit.name}: `;
  const resetText = formatCodexRateLimitReset({
    resetAt: limit.resetAt,
    windowSeconds: limit.windowSeconds,
    nowMs,
  });
  if (typeof limit.usedPercent === "number") {
    const remaining = Math.max(0, Math.round(100 - limit.usedPercent));
    return `${prefix}${remaining}% left${resetText ? ` (resets ${resetText})` : ""}`;
  }
  if (typeof limit.remaining === "number" && typeof limit.limit === "number") {
    return `${prefix}${limit.remaining}/${limit.limit} remaining${resetText ? ` (resets ${resetText})` : ""}`;
  }
  return `${prefix}unavailable`;
}

function splitCodexRateLimitName(name: string): {
  prefix: string;
  label: string;
  labelOrder: number;
} {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (lower.endsWith("5h limit")) {
    const prefix = trimmed.slice(0, Math.max(0, trimmed.length - "5h limit".length)).trim();
    return { prefix, label: "5h limit", labelOrder: 0 };
  }
  if (lower.endsWith("weekly limit")) {
    const prefix = trimmed.slice(0, Math.max(0, trimmed.length - "weekly limit".length)).trim();
    return { prefix, label: "Weekly limit", labelOrder: 1 };
  }
  return { prefix: "", label: trimmed, labelOrder: 99 };
}

function normalizeCodexModelKey(value: string | undefined): string {
  const trimmed = value?.trim().toLowerCase() ?? "";
  const withoutProvider = trimmed.includes("/") ? (trimmed.split("/").at(-1) ?? trimmed) : trimmed;
  return withoutProvider.replace(/[^a-z0-9]+/g, "");
}

export function selectVisibleCodexRateLimits(params: {
  rateLimits: RateLimitSummary[];
  currentModel?: string;
}): RateLimitSummary[] {
  const currentModelKey = normalizeCodexModelKey(params.currentModel);
  return [...params.rateLimits]
    .filter((limit) => {
      const { prefix } = splitCodexRateLimitName(limit.name);
      if (!prefix) {
        return true;
      }
      if (!currentModelKey) {
        return false;
      }
      return normalizeCodexModelKey(prefix) === currentModelKey;
    })
    .toSorted((left, right) => {
      const leftName = splitCodexRateLimitName(left.name);
      const rightName = splitCodexRateLimitName(right.name);
      const leftPrefixBlank = leftName.prefix ? 1 : 0;
      const rightPrefixBlank = rightName.prefix ? 1 : 0;
      if (leftPrefixBlank !== rightPrefixBlank) {
        return leftPrefixBlank - rightPrefixBlank;
      }
      const prefixCompare = leftName.prefix.localeCompare(rightName.prefix);
      if (prefixCompare !== 0) {
        return prefixCompare;
      }
      if (leftName.labelOrder !== rightName.labelOrder) {
        return leftName.labelOrder - rightName.labelOrder;
      }
      return left.name.localeCompare(right.name);
    });
}

export function formatCodexContextUsageSnapshot(
  usage?: ContextUsageSnapshot,
): string | undefined {
  if (!usage) {
    return undefined;
  }
  const totalTokens = usage.totalTokens;
  const contextWindow = usage.contextWindow;
  if (typeof totalTokens !== "number") {
    return undefined;
  }
  const totalLabel = formatTokenCount(totalTokens);
  const contextLabel = typeof contextWindow === "number" ? formatTokenCount(contextWindow) : "?";
  const percentFull =
    typeof totalTokens === "number" && typeof contextWindow === "number" && contextWindow > 0
      ? Math.max(0, Math.min(100, Math.round((totalTokens / contextWindow) * 100)))
      : undefined;
  const extras: string[] = [];
  if (typeof percentFull === "number") {
    extras.push(`${percentFull}% full`);
  }
  return `${totalLabel} / ${contextLabel} tokens used${
    extras.length > 0 ? ` (${extras.join(", ")})` : ""
  }`;
}

export function formatCodexStatusText(params: {
  threadState?: ThreadState;
  account?: AccountSummary | null;
  rateLimits: RateLimitSummary[];
  projectFolder?: string;
  worktreeFolder?: string;
  bindingActive?: boolean;
  contextUsage?: ContextUsageSnapshot;
  planMode?: boolean;
}): string {
  const lines = [];
  lines.push(`Binding: ${params.bindingActive ? "active" : "none"}`);
  if (params.threadState?.threadName?.trim()) {
    lines.push(`Thread: ${params.threadState.threadName.trim()}`);
  }
  if (params.threadState) {
    lines.push(`Model: ${formatCodexModelText(params.threadState)}`);
  }
  lines.push(`Project folder: ${shortenHomePath(params.projectFolder) ?? "unknown"}`);
  lines.push(`Worktree folder: ${shortenHomePath(params.worktreeFolder) ?? "unknown"}`);
  if (params.threadState || params.bindingActive) {
    lines.push(`Fast mode: ${formatCodexFastModeValue(params.threadState?.serviceTier)}`);
  }
  if (params.bindingActive && params.planMode !== undefined) {
    lines.push(`Plan mode: ${params.planMode ? "on" : "off"}`);
  }
  const contextUsageText = formatCodexContextUsageSnapshot(params.contextUsage);
  if (contextUsageText) {
    lines.push(`Context usage: ${contextUsageText}`);
  } else if (params.bindingActive) {
    lines.push("Context usage: unavailable until Codex emits a token-usage update");
  }
  const permissions = formatCodexPermissions({
    approvalPolicy: params.threadState?.approvalPolicy,
    sandbox: params.threadState?.sandbox,
  });
  if (permissions) {
    lines.push(`Permissions: ${permissions}`);
  }
  lines.push(`Account: ${formatCodexAccountText(params.account)}`);
  const sessionId = params.threadState?.threadId?.trim();
  if (sessionId) {
    lines.push(`Session: ${sessionId}`);
  }
  const visibleRateLimits = selectVisibleCodexRateLimits({
    rateLimits: params.rateLimits,
    currentModel: params.threadState?.model,
  });
  if (visibleRateLimits.length > 0) {
    const timeZoneLabel = getCodexStatusTimeZoneLabel();
    lines.push("");
    if (timeZoneLabel) {
      lines.push(`Rate limits timezone: ${timeZoneLabel}`);
    }
    for (const limit of visibleRateLimits) {
      lines.push(formatCodexRateLimitLine(limit));
    }
  }
  return lines.join("\n");
}

export function formatBoundThreadSummary(params: {
  binding: StoredBinding;
  state?: ThreadState;
}): string {
  const workspacePath = params.state?.cwd?.trim() || params.binding.workspaceDir;
  const projectName =
    getProjectName(workspacePath) ||
    getProjectName(params.binding.workspaceDir) ||
    "Unknown";
  const threadName =
    params.state?.threadName?.trim() ||
    params.binding.threadTitle?.trim();
  const parts = [
    "Codex thread bound.",
    `Project: ${projectName}`,
    threadName ? `Thread Name: ${threadName}` : "",
    `Thread ID: ${params.binding.threadId}`,
    isLikelyWorktreePath(workspacePath) ? `Worktree Path: ${workspacePath}` : "",
    !isLikelyWorktreePath(workspacePath) && workspacePath ? `Project Path: ${workspacePath}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

export function formatAccountSummary(account: AccountSummary, limits: RateLimitSummary[]): string {
  const lines = ["Codex account:"];
  if (account.email) {
    lines.push(`Email: ${account.email}`);
  }
  if (account.planType) {
    lines.push(`Plan: ${account.planType}`);
  }
  if (account.type) {
    lines.push(`Auth: ${account.type}`);
  }
  if (account.requiresOpenaiAuth) {
    lines.push("OpenAI auth required.");
  }
  if (limits.length > 0) {
    lines.push("", "Rate limits:");
    for (const limit of limits.slice(0, 6)) {
      const parts = [
        limit.name,
        typeof limit.usedPercent === "number" ? `${limit.usedPercent}% used` : "",
        typeof limit.remaining === "number" ? `${limit.remaining}% remaining` : "",
      ].filter(Boolean);
      lines.push(`- ${parts.join(" - ")}`);
    }
  }
  return lines.join("\n");
}

export function formatModels(models: ModelSummary[], state?: ThreadState): string {
  if (models.length === 0) {
    return state?.model ? `Current model: ${state.model}` : "No Codex models reported.";
  }
  const currentModel = models.find((model) => model.current)?.id || state?.model;
  const lines = [];
  if (currentModel) {
    lines.push(`Current model: ${currentModel}`);
  }
  lines.push(
    "Available models:",
    ...models.slice(0, 20).map((model) => {
      const current = model.current || model.id === state?.model ? " (current)" : "";
      return `- ${model.id}${current}`;
    }),
  );
  return lines.join("\n");
}

export function formatSkills(params: {
  workspaceDir: string;
  skills: SkillSummary[];
  filter?: string;
}): string {
  const filter = params.filter?.trim().toLowerCase();
  const skills = filter
    ? params.skills.filter((skill) => {
        const haystack = [skill.name, skill.description, skill.cwd].filter(Boolean).join("\n");
        return haystack.toLowerCase().includes(filter);
      })
    : params.skills;
  const lines = [`Codex skills for ${params.workspaceDir}:`];
  if (skills.length === 0) {
    lines.push(filter ? `No Codex skills matched "${params.filter?.trim()}".` : "No Codex skills found.");
    return lines.join("\n");
  }
  for (const skill of skills.slice(0, 20)) {
    const suffix = skill.description?.trim() ? ` - ${skill.description.trim()}` : "";
    const state =
      skill.enabled === false ? " (disabled)" : skill.enabled === true ? "" : " (status unknown)";
    lines.push(`- ${skill.name}${state}${suffix}`);
  }
  if (skills.length > 20) {
    lines.push(`- …and ${skills.length - 20} more`);
  }
  return lines.join("\n");
}

export function formatExperimentalFeatures(features: ExperimentalFeatureSummary[]): string {
  if (features.length === 0) {
    return "No Codex experimental features reported.";
  }
  return [
    "Codex experimental features:",
    ...features.slice(0, 30).map((feature) =>
      `- ${feature.displayName || feature.name}${feature.enabled ? " (enabled)" : ""}`,
    ),
  ].join("\n");
}

export function formatMcpServers(params: {
  servers: McpServerSummary[];
  filter?: string;
}): string {
  const filter = params.filter?.trim().toLowerCase();
  const servers = filter
    ? params.servers.filter((server) => {
        const haystack = [server.name, server.authStatus].filter(Boolean).join("\n");
        return haystack.toLowerCase().includes(filter);
      })
    : params.servers;
  const lines = ["Codex MCP servers:"];
  if (servers.length === 0) {
    lines.push(filter ? `No MCP servers matched "${params.filter?.trim()}".` : "No MCP servers reported.");
    return lines.join("\n");
  }
  for (const server of servers.slice(0, 20)) {
    const details = [
      server.authStatus ? `auth=${server.authStatus}` : undefined,
      `tools=${server.toolCount}`,
      `resources=${server.resourceCount}`,
      `templates=${server.resourceTemplateCount}`,
    ].filter(Boolean);
    lines.push(`- ${server.name} · ${details.join(" · ")}`);
  }
  if (servers.length > 20) {
    lines.push(`- …and ${servers.length - 20} more`);
  }
  return lines.join("\n");
}

export function formatThreadReplay(replay: ThreadReplay): string {
  return [
    replay.lastUserMessage ? `Last user:\n${replay.lastUserMessage}` : "",
    replay.lastAssistantMessage ? `Last assistant:\n${replay.lastAssistantMessage}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function formatTurnCompletion(result: TurnResult): string {
  if (result.planArtifact?.markdown) {
    return result.planArtifact.markdown;
  }
  if (result.text?.trim()) {
    return result.text.trim();
  }
  if (result.stoppedReason === "approval") {
    return "Cancelled the Codex approval request.";
  }
  if (result.aborted) {
    return "Codex turn stopped.";
  }
  return "Codex completed without a text reply.";
}

export function formatReviewCompletion(result: ReviewResult): string {
  return result.reviewText.trim() || (result.aborted ? "Codex review stopped." : "Codex review completed.");
}

export type ParsedReviewFinding = {
  priorityLabel?: string;
  title: string;
  location?: string;
  body?: string;
};

export function parseCodexReviewOutput(text: string): {
  summary?: string;
  findings: ParsedReviewFinding[];
} {
  const lines = text.trim().split(/\r?\n/);
  const findings: ParsedReviewFinding[] = [];
  const summaryLines: string[] = [];
  const findingRe =
    /^-?\s*(?:\[(?<priority>P\d)\]\s*)?(?<title>.+?)(?:\s+Location:\s*(?<location>.+))?$/i;
  let current: ParsedReviewFinding | null = null;
  let inFindings = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      if (!inFindings && summaryLines.at(-1) !== "") {
        summaryLines.push("");
      }
      continue;
    }
    const match = trimmed.match(findingRe);
    const looksLikeFinding =
      (trimmed.startsWith("[P") || trimmed.startsWith("- [P")) &&
      Boolean(match?.groups?.title?.trim());
    if (looksLikeFinding) {
      inFindings = true;
      if (current) {
        findings.push(current);
      }
      current = {
        priorityLabel: match?.groups?.priority?.toUpperCase(),
        title: match?.groups?.title?.trim() ?? trimmed,
        location: match?.groups?.location?.trim() || undefined,
      };
      continue;
    }
    if (!inFindings) {
      summaryLines.push(trimmed);
      continue;
    }
    if (!current) {
      continue;
    }
    current.body = current.body ? `${current.body}\n${trimmed}` : trimmed;
  }
  if (current) {
    findings.push(current);
  }
  const summary = summaryLines.join("\n").trim() || undefined;
  return { summary, findings };
}

export function formatCodexReviewFindingMessage(params: {
  finding: ParsedReviewFinding;
  index: number;
}): string {
  const heading = params.finding.priorityLabel ?? `Finding ${params.index + 1}`;
  const lines = [heading, params.finding.title];
  if (params.finding.location) {
    lines.push(`Location: ${params.finding.location}`);
  }
  if (params.finding.body?.trim()) {
    lines.push("", params.finding.body.trim());
  }
  return lines.join("\n");
}

export function formatCodexPlanSteps(
  steps: TurnResult["planArtifact"] extends infer T ? (T extends { steps: infer S } ? S : never) : never,
): string | undefined {
  if (!Array.isArray(steps) || steps.length === 0) {
    return undefined;
  }
  const lines = ["Plan steps:"];
  for (const step of steps) {
    const marker =
      step.status === "completed" ? "[x]" : step.status === "inProgress" ? "[>]" : "[ ]";
    lines.push(`- ${marker} ${step.step}`);
  }
  return lines.join("\n");
}

export function formatCodexPlanInlineText(plan: NonNullable<TurnResult["planArtifact"]>): string {
  const lines: string[] = ["Plan"];
  if (plan.explanation?.trim()) {
    lines.push("", plan.explanation.trim());
  }
  const stepsText = formatCodexPlanSteps(plan.steps);
  if (stepsText) {
    lines.push("", stepsText);
  }
  if (plan.markdown.trim()) {
    lines.push("", plan.markdown.trim());
  }
  return lines.join("\n").trim();
}

export function buildCodexPlanMarkdownPreview(
  markdown: string,
  maxChars = 1400,
): string | undefined {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n[Preview truncated. Open the attachment for the full plan.]`;
}

export function formatCodexPlanAttachmentSummary(
  plan: NonNullable<TurnResult["planArtifact"]>,
): string {
  const lines = ["Plan ready."];
  if (plan.explanation?.trim()) {
    lines.push("", plan.explanation.trim());
  }
  const stepsText = formatCodexPlanSteps(plan.steps);
  if (stepsText) {
    lines.push("", stepsText);
  }
  const summaryPreview = buildCodexPlanMarkdownPreview(plan.markdown, 1400);
  if (summaryPreview) {
    lines.push("", "Plan preview:", "", summaryPreview);
  }
  return lines.join("\n").trim();
}

export function formatCodexPlanAttachmentFallback(
  plan: NonNullable<TurnResult["planArtifact"]>,
): string {
  const lines = [
    "I couldn't attach the full Markdown plan here, so here's a condensed inline summary instead.",
  ];
  if (plan.explanation?.trim()) {
    lines.push("", plan.explanation.trim());
  }
  const stepsText = formatCodexPlanSteps(plan.steps);
  if (stepsText) {
    lines.push("", stepsText);
  }
  const markdownPreview = plan.markdown.trim();
  if (markdownPreview) {
    const maxPreviewChars = 1800;
    const preview =
      markdownPreview.length > maxPreviewChars
        ? `${markdownPreview.slice(0, maxPreviewChars).trimEnd()}\n\n[Truncated]`
        : markdownPreview;
    lines.push("", preview);
  }
  return lines.join("\n").trim();
}
