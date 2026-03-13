import crypto from "node:crypto";
import type {
  PendingApprovalDecision,
  PendingInputAction,
  PendingInputState,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function findFirstStringByKeys(
  value: unknown,
  keys: readonly string[],
  depth = 0,
): string | undefined {
  if (depth > 5) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = findFirstStringByKeys(item, keys, depth + 1);
      if (match) {
        return match;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const direct = pickString(record, keys);
  if (direct) {
    return direct;
  }
  for (const nested of Object.values(record)) {
    const match = findFirstStringByKeys(nested, keys, depth + 1);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function normalizeApprovalDecision(value: string): PendingApprovalDecision | null {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "accept":
    case "approve":
    case "allow":
      return "accept";
    case "acceptwithexecpolicyamendment":
    case "acceptforsession":
    case "approveforsession":
    case "allowforsession":
      return "acceptForSession";
    case "decline":
    case "deny":
    case "reject":
      return "decline";
    case "cancel":
    case "abort":
    case "stop":
      return "cancel";
    default:
      return null;
  }
}

function humanizeApprovalDecision(
  decision: PendingApprovalDecision,
  sessionPrefix?: string,
): string {
  switch (decision) {
    case "accept":
      return "Approve Once";
    case "acceptForSession":
      return sessionPrefix ? `Approve for Session (${sessionPrefix})` : "Approve for Session";
    case "decline":
      return "Decline";
    case "cancel":
      return "Cancel";
  }
}

function extractSessionPrefix(value: unknown): string | undefined {
  const record = asRecord(value);
  return (
    findFirstStringByKeys(record?.proposedExecpolicyAmendment, [
      "prefix",
      "commandPrefix",
      "prefixToApprove",
      "allowedPrefix",
      "command_prefix",
    ]) ??
    findFirstStringByKeys(record?.sessionApproval, [
      "prefix",
      "commandPrefix",
      "prefixToApprove",
      "allowedPrefix",
      "command_prefix",
    ]) ??
    findFirstStringByKeys(record?.execPolicyAmendment, [
      "prefix",
      "commandPrefix",
      "prefixToApprove",
      "allowedPrefix",
      "command_prefix",
    ])
  );
}

function buildApprovalActionsFromDecisions(value: unknown): PendingInputAction[] {
  const record = asRecord(value);
  const rawDecisions = record?.availableDecisions ?? record?.decisions;
  if (!Array.isArray(rawDecisions)) {
    return [];
  }
  const actions: PendingInputAction[] = [];
  for (const entry of rawDecisions) {
    if (typeof entry === "string") {
      const decision = normalizeApprovalDecision(entry);
      if (!decision) {
        continue;
      }
      actions.push({
        kind: "approval",
        decision,
        responseDecision: entry,
        label: humanizeApprovalDecision(decision),
      });
      continue;
    }
    const decisionRecord = asRecord(entry);
    const decisionValue =
      pickString(decisionRecord, ["decision", "value", "name", "id", "action"]) ?? "";
    const decision = normalizeApprovalDecision(decisionValue);
    if (!decision) {
      continue;
    }
    const sessionPrefix =
      decision === "acceptForSession" ? extractSessionPrefix(decisionRecord) : undefined;
    const proposedExecpolicyAmendment =
      decision === "acceptForSession"
        ? (asRecord(decisionRecord?.proposedExecpolicyAmendment) ??
          asRecord(decisionRecord?.execPolicyAmendment) ??
          undefined)
        : undefined;
    actions.push({
      kind: "approval",
      decision,
      responseDecision: decisionValue || decision,
      ...(proposedExecpolicyAmendment ? { proposedExecpolicyAmendment } : {}),
      ...(sessionPrefix ? { sessionPrefix } : {}),
      label:
        pickString(decisionRecord, ["label", "title", "text"]) ??
        humanizeApprovalDecision(decision, sessionPrefix),
    });
  }
  return actions;
}

function resolveApprovalDecisionFromText(text: string): PendingApprovalDecision | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("session")) {
    return "acceptForSession";
  }
  if (/cancel|abort|stop/.test(normalized)) {
    return "cancel";
  }
  if (/deny|decline|reject|block|no/.test(normalized)) {
    return "decline";
  }
  if (/approve|allow|accept|yes/.test(normalized)) {
    return "accept";
  }
  return null;
}

function buildApprovalActionsFromOptions(options: string[]): PendingInputAction[] {
  const seen = new Set<PendingApprovalDecision>();
  const actions: PendingInputAction[] = [];
  for (const option of options) {
    const decision = resolveApprovalDecisionFromText(option);
    if (!decision || seen.has(decision)) {
      continue;
    }
    seen.add(decision);
    actions.push({
      kind: "approval",
      decision,
      responseDecision: decision,
      label: option.trim() || humanizeApprovalDecision(decision),
    });
  }
  return actions;
}

export function buildPendingUserInputActions(params: {
  method?: string;
  requestParams?: unknown;
  options?: string[];
}): PendingInputAction[] {
  const methodLower = params.method?.trim().toLowerCase() ?? "";
  const options = params.options?.map((option) => option.trim()).filter(Boolean) ?? [];
  if (methodLower.includes("requestapproval")) {
    const approvalActions = buildApprovalActionsFromDecisions(params.requestParams);
    const resolvedApprovalActions =
      approvalActions.length > 0 ? approvalActions : buildApprovalActionsFromOptions(options);
    return [...resolvedApprovalActions, { kind: "steer", label: "Tell Codex What To Do" }];
  }
  return options.map((option) => ({
    kind: "option",
    label: option,
    value: option,
  }));
}

function dedupeJoinedText(chunks: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of chunks.map((value) => value.trim()).filter(Boolean)) {
    if (seen.has(chunk)) {
      continue;
    }
    seen.add(chunk);
    out.push(chunk);
  }
  return out.join("\n\n").trim();
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectText(entry));
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  const directKeys = [
    "text",
    "delta",
    "message",
    "prompt",
    "question",
    "summary",
    "title",
    "content",
    "description",
    "reason",
  ];
  const out = directKeys.flatMap((key) => collectText(record[key]));
  for (const nestedKey of ["item", "turn", "thread", "response", "result", "data", "questions"]) {
    out.push(...collectText(record[nestedKey]));
  }
  return out;
}

function buildMarkdownCodeBlock(text: string, language = ""): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }
  const fenceMatches = [...normalized.matchAll(/`{3,}/g)];
  const longestFence = fenceMatches.reduce((max, match) => Math.max(max, match[0].length), 2);
  const fence = "`".repeat(longestFence + 1);
  const languageTag = language.trim();
  return `${fence}${languageTag}\n${normalized}\n${fence}`;
}

export function buildPendingPromptText(params: {
  method: string;
  requestId: string;
  options: string[];
  actions: PendingInputAction[];
  expiresAt: number;
  requestParams: unknown;
}): string {
  const lines = [
    /requestapproval/i.test(params.method)
      ? `Codex approval requested (${params.requestId})`
      : `Codex input requested (${params.requestId})`,
  ];
  const requestText = dedupeJoinedText(collectText(params.requestParams));
  if (requestText) {
    lines.push(requestText);
  }
  const command =
    findFirstStringByKeys(params.requestParams, [
      "command",
      "cmd",
      "displayCommand",
      "rawCommand",
      "shellCommand",
    ]) ?? "";
  if (command) {
    lines.push("", "Command:", "", buildMarkdownCodeBlock(command, "sh"));
  }
  if (params.actions.length > 0) {
    lines.push("", "Choices:");
    params.actions
      .filter((action) => action.kind !== "steer")
      .forEach((action, index) => {
        lines.push(`${index + 1}. ${action.label}`);
      });
    lines.push("", 'Reply with "1", "2", "option 1", etc., or use a button.');
    if (/requestapproval/i.test(params.method)) {
      lines.push("You can also reply with free text to tell Codex what to do instead.");
    }
  } else if (params.options.length > 0) {
    lines.push("", "Options:");
    params.options.forEach((option, index) => {
      lines.push(`${index + 1}. ${option}`);
    });
  } else {
    lines.push("Reply with a free-form response.");
  }
  const seconds = Math.max(1, Math.round((params.expiresAt - Date.now()) / 1_000));
  lines.push(`Expires in: ${seconds}s`);
  return lines.join("\n");
}

export function createPendingInputState(params: {
  method: string;
  requestId: string;
  requestParams: unknown;
  options: string[];
  expiresAt: number;
}): PendingInputState {
  const actions = buildPendingUserInputActions({
    method: params.method,
    requestParams: params.requestParams,
    options: params.options,
  });
  return {
    requestId: params.requestId,
    options: params.options,
    actions,
    expiresAt: params.expiresAt,
    promptText: buildPendingPromptText({
      method: params.method,
      requestId: params.requestId,
      options: params.options,
      actions,
      expiresAt: params.expiresAt,
      requestParams: params.requestParams,
    }),
    method: params.method,
  };
}

export function parseCodexUserInput(
  text: string,
  optionsCount: number,
): { kind: "option"; index: number } | { kind: "text"; text: string } {
  const normalized = text.trim();
  if (!normalized) {
    return { kind: "text", text: "" };
  }
  const match = normalized.match(/^\s*(?:option\s*)?([1-9]\d*)\s*$/i);
  if (!match) {
    return { kind: "text", text: normalized };
  }
  const oneBased = Number.parseInt(match[1] ?? "", 10);
  if (Number.isInteger(oneBased) && oneBased >= 1 && oneBased <= optionsCount) {
    return { kind: "option", index: oneBased - 1 };
  }
  return { kind: "text", text: normalized };
}

export function requestToken(requestId: string): string {
  return crypto.createHash("sha1").update(requestId).digest("base64url").slice(0, 10);
}
