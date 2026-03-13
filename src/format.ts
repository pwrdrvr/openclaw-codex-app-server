import type {
  AccountSummary,
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

function formatProjectBadge(projectKey?: string): string | undefined {
  if (!projectKey) {
    return undefined;
  }
  const parts = projectKey
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  const worktreesIndex = parts.lastIndexOf("worktrees");
  if (worktreesIndex >= 0 && parts.length > worktreesIndex + 2) {
    return `${parts[worktreesIndex + 1]}/${parts[worktreesIndex + 2]}`;
  }
  return parts[parts.length - 1];
}

function formatThreadButtonTitle(thread: ThreadSummary): string {
  return thread.title?.trim() || thread.threadId;
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

export function formatThreadButtonLabel(thread: ThreadSummary): string {
  const prefix = "Resume: ";
  const projectBadge = formatProjectBadge(thread.projectKey);
  const suffix = projectBadge ? ` (${projectBadge})` : "";
  const maxLength = 72;
  const availableTitleLength = Math.max(16, maxLength - prefix.length - suffix.length);
  const title = truncateMiddle(formatThreadButtonTitle(thread), availableTitleLength);
  return `${prefix}${title}${suffix}`;
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
  return [
    "Codex models:",
    ...models.slice(0, 20).map((model) => {
      const current = model.current || model.id === state?.model ? " (current)" : "";
      return `- ${model.id}${current}`;
    }),
  ].join("\n");
}

export function formatSkills(skills: SkillSummary[]): string {
  if (skills.length === 0) {
    return "No Codex skills reported.";
  }
  return [
    "Codex skills:",
    ...skills.slice(0, 30).map((skill) =>
      `- ${skill.name}${skill.enabled === false ? " (disabled)" : ""}${skill.cwd ? ` - ${skill.cwd}` : ""}`,
    ),
  ].join("\n");
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

export function formatMcpServers(servers: McpServerSummary[]): string {
  if (servers.length === 0) {
    return "No Codex MCP servers reported.";
  }
  return [
    "Codex MCP servers:",
    ...servers.slice(0, 20).map((server) =>
      `- ${server.name} - tools ${server.toolCount}, resources ${server.resourceCount}, templates ${server.resourceTemplateCount}`,
    ),
  ].join("\n");
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
  if (result.aborted) {
    return "Codex turn stopped.";
  }
  return "Codex completed without a text reply.";
}

export function formatReviewCompletion(result: ReviewResult): string {
  return result.reviewText.trim() || (result.aborted ? "Codex review stopped." : "Codex review completed.");
}
