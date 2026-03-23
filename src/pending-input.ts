import crypto from "node:crypto";
import type {
  PendingApprovalDecision,
  PendingInputAction,
  PendingInputState,
  PendingQuestionnaireAnswer,
  PendingQuestionnaireQuestion,
  PendingQuestionnaireState,
} from "./types.js";

const MAX_PENDING_REQUEST_TEXT_CHARS = 1200;
const MAX_PENDING_PROMPT_TEXT_CHARS = 2200;

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

function isFileChangeApprovalMethod(methodLower: string): boolean {
  return methodLower.includes("filechange/requestapproval");
}

function isCommandApprovalMethod(methodLower: string): boolean {
  return methodLower.includes("commandexecution/requestapproval") || methodLower === "turn/requestapproval";
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

function buildApprovalActionsFromMethod(
  methodLower: string,
  requestParams: unknown,
): PendingInputAction[] {
  if (isFileChangeApprovalMethod(methodLower)) {
    return [
      {
        kind: "approval",
        decision: "accept",
        responseDecision: "accept",
        label: "Approve File Changes",
      },
      {
        kind: "approval",
        decision: "decline",
        responseDecision: "decline",
        label: "Decline",
      },
    ];
  }
  if (!isCommandApprovalMethod(methodLower)) {
    return [];
  }
  const sessionPrefix = extractSessionPrefix(requestParams);
  const actions: PendingInputAction[] = [
    {
      kind: "approval",
      decision: "accept",
      responseDecision: "accept",
      label: "Approve Once",
    },
  ];
  if (sessionPrefix) {
    actions.push({
      kind: "approval",
      decision: "acceptForSession",
      responseDecision: "acceptForSession",
      sessionPrefix,
      label: humanizeApprovalDecision("acceptForSession", sessionPrefix),
    });
  }
  actions.push(
    {
      kind: "approval",
      decision: "decline",
      responseDecision: "decline",
      label: "Decline",
    },
    {
      kind: "approval",
      decision: "cancel",
      responseDecision: "cancel",
      label: "Cancel",
    },
  );
  return actions;
}

function extractFilePaths(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  const pushPath = (pathValue: unknown) => {
    if (typeof pathValue !== "string") {
      return;
    }
    const trimmed = pathValue.trim();
    if (!trimmed || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    out.push(trimmed);
  };
  const filePaths = Array.isArray(record.filePaths)
    ? record.filePaths
    : Array.isArray(record.file_paths)
      ? record.file_paths
      : [];
  filePaths.forEach((entry) => pushPath(entry));
  const changes = Array.isArray(record.changes) ? record.changes : [];
  changes.forEach((entry) => pushPath(asRecord(entry)?.path));
  return out;
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
      approvalActions.length > 0
        ? approvalActions
        : buildApprovalActionsFromOptions(options).length > 0
          ? buildApprovalActionsFromOptions(options)
          : buildApprovalActionsFromMethod(methodLower, params.requestParams);
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

function truncateWithNotice(text: string, maxChars: number, notice: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(1, maxChars)).trimEnd()}\n\n${notice}`;
}

function parseQuestionnaireOption(line: string): { key: string; label: string } | null {
  const match = line.trim().match(/^[•*-]?\s*([A-Z])[\.\)]?\s+(.+)$/);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    key: match[1],
    label: match[2].trim(),
  };
}

function extractQuestionnaireFromStructuredRequest(
  value: unknown,
): PendingQuestionnaireState | undefined {
  const record = asRecord(value);
  const rawQuestions = Array.isArray(record?.questions) ? record.questions : [];
  if (rawQuestions.length === 0) {
    return undefined;
  }
  const questions: PendingQuestionnaireQuestion[] = rawQuestions
    .map((entry, index) => {
      const question = asRecord(entry);
      if (!question) {
        return null;
      }
      const rawOptions = Array.isArray(question.options) ? question.options : [];
      const options = rawOptions
        .map((option, optionIndex) => {
          const optionRecord = asRecord(option);
          if (!optionRecord) {
            return null;
          }
          const label = pickString(optionRecord, ["label", "title", "text"]);
          if (!label) {
            return null;
          }
          return {
            key: String.fromCharCode(65 + optionIndex),
            label,
            description: pickString(optionRecord, ["description", "details", "summary"]),
            recommended: /\(recommended\)/i.test(label),
          };
        })
        .filter(Boolean) as PendingQuestionnaireQuestion["options"];
      if (options.length === 0) {
        return null;
      }
      const header = pickString(question, ["header"]);
      const prompt = pickString(question, ["question"]) ?? header ?? `Question ${index + 1}`;
      return {
        index,
        id: pickString(question, ["id"]) ?? `q${index + 1}`,
        header,
        prompt,
        options,
        guidance: [],
        allowFreeform: question.isOther === true || question.is_other === true,
      };
    })
    .filter(Boolean) as PendingQuestionnaireQuestion[];
  if (questions.length === 0) {
    return undefined;
  }
  return {
    questions,
    currentIndex: 0,
    answers: questions.map(() => null),
    responseMode: "structured",
  };
}

export function parsePendingQuestionnaire(text: string): PendingQuestionnaireState | undefined {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return undefined;
  }
  const starts = [...normalized.matchAll(/(?:^|\n)(\d+)\.\s+/g)].map((match) => match.index ?? 0);
  if (starts.length < 2) {
    return undefined;
  }
  const questions: PendingQuestionnaireQuestion[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index] ?? 0;
    const end = starts[index + 1] ?? normalized.length;
    const block = normalized
      .slice(start, end)
      .trim()
      .replace(/^\d+\.\s+/, "");
    const lines = block.split("\n");
    const prompt = lines.shift()?.trim() ?? "";
    if (!prompt) {
      continue;
    }
    const options: Array<{ key: string; label: string }> = [];
    const guidance: string[] = [];
    let inGuidance = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      if (/^guidance:?$/i.test(line)) {
        inGuidance = true;
        continue;
      }
      const option = parseQuestionnaireOption(line);
      if (option && !inGuidance) {
        options.push(option);
        continue;
      }
      if (inGuidance) {
        guidance.push(line.replace(/^[•*-]\s*/, "").trim());
      }
    }
    if (options.length === 0) {
      continue;
    }
    questions.push({
      index: questions.length,
      id: `q${questions.length + 1}`,
      prompt,
      options,
      guidance,
    });
  }
  if (questions.length < 2) {
    return undefined;
  }
  return {
    questions,
    currentIndex: 0,
    answers: questions.map(() => null),
    responseMode: "compact",
  };
}

export function formatPendingQuestionnairePrompt(
  questionnaire: PendingQuestionnaireState,
): string {
  const question = questionnaire.questions[questionnaire.currentIndex];
  if (!question) {
    return "Codex needs input.";
  }
  const heading =
    question.header && question.prompt && question.header !== question.prompt
      ? `${question.header}: ${question.prompt}`
      : (question.header ?? question.prompt);
  const lines = [
    `Codex plan question ${questionnaire.currentIndex + 1} of ${questionnaire.questions.length}`,
    "",
    heading,
    "",
  ];
  for (const option of question.options) {
    lines.push(`${option.key}. ${option.label}`);
    if (option.description) {
      lines.push(`   ${option.description}`);
    }
  }
  if (question.guidance.length > 0) {
    lines.push("", "Guidance:");
    for (const item of question.guidance) {
      lines.push(`- ${item}`);
    }
  }
  if (question.allowFreeform) {
    lines.push("", "Other: You can reply with free text.");
  }
  const currentAnswer = questionnaire.answers[questionnaire.currentIndex];
  if (currentAnswer) {
    lines.push(
      "",
      `Current answer: ${
        currentAnswer.kind === "option"
          ? `${currentAnswer.optionKey}. ${currentAnswer.optionLabel}`
          : currentAnswer.text
      }`,
    );
  } else if (questionnaire.awaitingFreeform) {
    lines.push("", "Current answer: waiting for your free-form reply");
  }
  return lines.join("\n");
}

export function renderPendingQuestionnaireAnswer(answer: PendingQuestionnaireAnswer | null): string {
  if (!answer) {
    return "";
  }
  return answer.kind === "option" ? answer.optionLabel.trim() : answer.text.trim();
}

export function buildPendingQuestionnaireResponse(
  questionnaire: PendingQuestionnaireState,
): { answers: Record<string, { answers: string[] }> } | string {
  if (questionnaire.responseMode === "compact") {
    return questionnaire.questions
      .map((question, index) => {
        const answer = questionnaire.answers[index];
        if (!answer) {
          return "";
        }
        return answer.kind === "option"
          ? `${question.index + 1}${answer.optionKey}`
          : `${question.index + 1}: ${answer.text.trim()}`;
      })
      .filter(Boolean)
      .join(" ");
  }
  return {
    answers: Object.fromEntries(
      questionnaire.questions.map((question, index) => {
        const answer = questionnaire.answers[index];
        const rendered = renderPendingQuestionnaireAnswer(answer);
        return [question.id, { answers: rendered ? [rendered] : [] }];
      }),
    ),
  };
}

export function addQuestionnaireResponseNote(
  response: { answers: Record<string, { answers: string[] }> } | string,
  note: string,
): { answers: Record<string, { answers: string[] }> } | string {
  const trimmed = note.trim();
  if (!trimmed || typeof response === "string") {
    return response;
  }
  const entries = Object.entries(response.answers);
  if (entries.length === 0) {
    return response;
  }
  const [firstId, firstAnswer] = entries[0];
  return {
    answers: {
      ...response.answers,
      [firstId]: {
        answers: [...firstAnswer.answers, `user_note: ${trimmed}`],
      },
    },
  };
}

export function questionnaireIsComplete(questionnaire: PendingQuestionnaireState): boolean {
  return questionnaire.answers.every(
    (answer) =>
      answer != null &&
      (answer.kind === "option" || (answer.kind === "text" && answer.text.trim().length > 0)),
  );
}

export function questionnaireCurrentQuestionHasAnswer(
  questionnaire: PendingQuestionnaireState,
): boolean {
  const answer = questionnaire.answers[questionnaire.currentIndex];
  return (
    answer != null &&
    (answer.kind === "option" || (answer.kind === "text" && answer.text.trim().length > 0))
  );
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

/**
 * Strips common shell launcher wrappers from a command string for display.
 * For example: `/bin/zsh -lc 'git status'` → `git status`
 *
 * Matches upstream Codex Desktop behavior (strip_bash_lc_and_escape in
 * codex-rs/tui/src/exec_command.rs). The raw command is preserved for
 * approval transport; only the displayed form is simplified.
 */
export function stripShellLauncher(command: string): string {
  const match = command.match(
    /^(?:\/[/\w]*\/)?(?:bash|zsh|sh|dash|ksh|tcsh|fish)\s+-lc\s+(['"])([\s\S]*)\1\s*$/,
  );
  if (match) {
    return match[2];
  }
  return command;
}

/**
 * Extracts a display command from the app-server's `commandActions` array.
 *
 * The app-server protocol provides `commandActions` as "best-effort parsed
 * command actions for friendly display" (see CommandAction type in
 * codex-rs/app-server-protocol). Each action has a `.command` field that is
 * already stripped of shell launcher wrappers by the Rust-side parser
 * (extract_shell_command → strip_bash_lc_and_escape).
 *
 * When available, this is more reliable than regex-based stripping because
 * the upstream parser uses tree-sitter for proper shell parsing.
 */
export function extractCommandFromActions(requestParams: unknown): string | undefined {
  const record = asRecord(requestParams);
  if (!record) return undefined;
  const actions = record.commandActions;
  if (!Array.isArray(actions) || actions.length === 0) return undefined;
  const commands = actions
    .map((a: unknown) => {
      const action = asRecord(a);
      if (!action || typeof action.command !== "string") return undefined;
      return action.command;
    })
    .filter((c): c is string => c !== undefined);
  if (commands.length === 0) return undefined;
  return commands.join(" && ");
}

export function buildPendingPromptText(params: {
  method: string;
  requestId: string;
  options: string[];
  actions: PendingInputAction[];
  expiresAt: number;
  requestParams: unknown;
}): string {
  const methodLower = params.method.trim().toLowerCase();
  const lines = [
    /requestapproval/i.test(params.method)
      ? isFileChangeApprovalMethod(methodLower)
        ? `Codex file change approval requested (${params.requestId})`
        : isCommandApprovalMethod(methodLower)
          ? `Codex command approval requested (${params.requestId})`
          : `Codex approval requested (${params.requestId})`
      : `Codex input requested (${params.requestId})`,
  ];
  const requestText = dedupeJoinedText(collectText(params.requestParams));
  if (requestText) {
    lines.push(
      truncateWithNotice(
        requestText,
        MAX_PENDING_REQUEST_TEXT_CHARS,
        "[Request details truncated. Use steer text if you want to redirect Codex.]",
      ),
    );
  }
  // Prefer the pre-parsed commandActions from the app-server protocol when
  // available — the Rust side already strips shell launchers via tree-sitter.
  // Fall back to regex-based stripShellLauncher on the raw command string.
  const displayCommand = extractCommandFromActions(params.requestParams);
  const rawCommand =
    findFirstStringByKeys(params.requestParams, [
      "command",
      "cmd",
      "displayCommand",
      "rawCommand",
      "shellCommand",
    ]) ?? "";
  const command = displayCommand ?? (rawCommand ? stripShellLauncher(rawCommand) : "");
  if (command) {
    lines.push("", "Command:", "", buildMarkdownCodeBlock(command, "sh"));
  }
  const grantRoot = findFirstStringByKeys(params.requestParams, ["grantRoot", "grant_root"]);
  if (grantRoot) {
    lines.push("", `Requested writable root: \`${grantRoot}\``);
  }
  if (isFileChangeApprovalMethod(methodLower)) {
    const filePaths = extractFilePaths(params.requestParams);
    if (filePaths.length > 0) {
      lines.push("", "Files:");
      for (const filePath of filePaths.slice(0, 12)) {
        lines.push(`- \`${filePath}\``);
      }
      if (filePaths.length > 12) {
        lines.push(`- ...and ${filePaths.length - 12} more`);
      }
    }
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
  return truncateWithNotice(
    lines.join("\n"),
    MAX_PENDING_PROMPT_TEXT_CHARS,
    "[Prompt truncated for chat delivery. Use the buttons or reply with steer text.]",
  );
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
  const questionnaire =
    extractQuestionnaireFromStructuredRequest(params.requestParams) ??
    parsePendingQuestionnaire(dedupeJoinedText(collectText(params.requestParams)));
  return {
    requestId: params.requestId,
    options: params.options,
    actions,
    expiresAt: params.expiresAt,
    questionnaire,
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
