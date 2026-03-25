#!/usr/bin/env node

import { spawn } from "node:child_process";
import readline from "node:readline";
import process from "node:process";
import path from "node:path";

const DEFAULT_PROTOCOL_VERSION = "1.0";
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_PROMPT =
  "Run `npm view dive version` in the shell and reply with only the exact stdout from that command.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeTextForLog(text, maxChars = 140) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "<empty>";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function pickString(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function collectText(value) {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
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
    "output",
  ];
  const out = directKeys.flatMap((key) => collectText(record[key]));
  for (const nestedKey of ["item", "turn", "thread", "response", "result", "data", "items"]) {
    out.push(...collectText(record[nestedKey]));
  }
  return out;
}

function extractAssistantItemId(value) {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const item = asRecord(record.item) ?? record;
  return pickString(item, ["id", "itemId", "item_id"]);
}

function extractAssistantTextFromItemPayload(value) {
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  const item = asRecord(record.item) ?? record;
  const itemType = pickString(item, ["type"])?.toLowerCase();
  if (!itemType || (itemType !== "agentmessage" && itemType !== "assistantmessage")) {
    return "";
  }
  return collectText(item).join("\n").trim();
}

function extractAssistantNotificationText(method, params) {
  const methodLower = method.trim().toLowerCase();
  if (methodLower === "item/agentmessage/delta") {
    return {
      mode: "delta",
      text: collectText(params).join("\n"),
      itemId: extractAssistantItemId(params),
    };
  }
  if (methodLower === "item/completed") {
    return {
      mode: "snapshot",
      text: extractAssistantTextFromItemPayload(params),
      itemId: extractAssistantItemId(params),
    };
  }
  return { mode: "ignore", text: "", itemId: undefined };
}

function extractIds(value) {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  return {
    threadId:
      pickString(record, ["threadId", "thread_id"]) ??
      pickString(asRecord(record.thread), ["threadId", "thread_id", "id"]),
    runId:
      pickString(record, ["runId", "turnId", "run_id", "turn_id"]) ??
      pickString(asRecord(record.turn), ["runId", "turnId", "run_id", "turn_id", "id"]),
  };
}

function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt }];
}

class StdioJsonRpcHarness {
  constructor({ label, command, args, cwd }) {
    this.label = label;
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.requests = [];
    this.closed = false;
    this.logs = [];
    this.approvalRequests = [];
    this._doneResolve = null;
    this.done = new Promise((resolve) => {
      this._doneResolve = resolve;
    });
  }

  log(message) {
    const line = `[${this.label}] ${message}`;
    this.logs.push(line);
    console.log(line);
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.log(`spawned pid=${this.child.pid ?? "<unknown>"} cmd=${this.command} args=${JSON.stringify(this.args)}`);
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        this.log(`stderr ${summarizeTextForLog(text)}`);
      }
    });
    this.child.on("exit", (code, signal) => {
      this.closed = true;
      this.log(`exited code=${code ?? "<none>"} signal=${signal ?? "<none>"}`);
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`process exited before response: code=${code ?? "<none>"}`));
      }
      this.pending.clear();
      this._doneResolve?.();
    });
    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let payload;
      try {
        payload = JSON.parse(trimmed);
      } catch (error) {
        this.log(`non-json stdout ${summarizeTextForLog(trimmed)}`);
        return;
      }
      this.handleEnvelope(payload).catch((error) => {
        this.log(`handleEnvelope failed: ${String(error)}`);
      });
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      clientInfo: {
        name: "openclaw-codex-app-server-thread-smoke",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    await this.notify("initialized", {});
    this.log(`initialized server=${pickString(asRecord(result)?.serverInfo ?? asRecord(result), ["name"]) || "<unknown>"}`);
    return result;
  }

  async notify(method, params) {
    this.write({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  async request(method, params, timeoutMs = 15_000) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
    this.write({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    return await promise;
  }

  write(payload) {
    if (!this.child?.stdin || this.closed) {
      throw new Error(`${this.label} stdin unavailable`);
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async handleEnvelope(payload) {
    const record = asRecord(payload);
    if (!record) {
      return;
    }
    if (record.id != null && !record.method) {
      const pending = this.pending.get(record.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(record.id);
      if (record.error) {
        pending.reject(new Error(pickString(asRecord(record.error), ["message"]) || "unknown error"));
        return;
      }
      pending.resolve(record.result);
      return;
    }
    if (!record.method) {
      return;
    }
    const method = String(record.method);
    const params = record.params;
    if (record.id != null) {
      await this.handleServerRequest(record.id, method, params);
      return;
    }
    await this.handleNotification(method, params);
  }

  async handleServerRequest(id, method, params) {
    const methodLower = method.trim().toLowerCase();
    this.requests.push({ method, params });
    this.log(`server request ${method}`);
    if (methodLower.includes("requestapproval")) {
      this.approvalRequests.push({
        method,
        params,
        at: Date.now(),
      });
      this.write({
        jsonrpc: "2.0",
        id,
        result: { decision: "decline" },
      });
      this.log(`declined approval request ${method}`);
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id,
      result: {},
    });
  }

  async handleNotification(method, params) {
    const methodLower = method.trim().toLowerCase();
    this.notifications.push({ method, params, at: Date.now() });
    if (methodLower === "turn/completed") {
      const ids = extractIds(params);
      this.log(`turn completed thread=${ids.threadId || "<none>"} turn=${ids.runId || "<none>"}`);
      return;
    }
    if (methodLower === "turn/failed" || methodLower === "turn/cancelled") {
      const ids = extractIds(params);
      this.log(`turn terminal ${method} thread=${ids.threadId || "<none>"} turn=${ids.runId || "<none>"}`);
      return;
    }
    const assistant = extractAssistantNotificationText(method, params);
    if (assistant.mode === "snapshot" && assistant.text.trim()) {
      this.log(`assistant snapshot ${summarizeTextForLog(assistant.text)}`);
    }
  }

  async startThread(cwd) {
    const result = await this.request("thread/start", { cwd }, 15_000);
    const threadId = extractIds(result).threadId;
    if (!threadId) {
      throw new Error("thread/start did not return a thread id");
    }
    this.log(`thread started thread=${threadId}`);
    return threadId;
  }

  async resumeThread({ threadId, approvalPolicy, sandbox }) {
    const result = await this.request(
      "thread/resume",
      {
        threadId,
        approvalPolicy,
        sandbox,
        persistExtendedHistory: false,
      },
      15_000,
    );
    const state = {
      threadId: extractIds(result).threadId ?? threadId,
      approvalPolicy: pickString(asRecord(result), ["approvalPolicy", "approval_policy"]) || "<none>",
      sandbox: pickString(asRecord(result), ["sandbox", "sandboxMode", "sandbox_mode"]) || "<none>",
    };
    this.log(
      `thread resumed thread=${state.threadId} requestedApproval=${approvalPolicy} requestedSandbox=${sandbox} returnedApproval=${state.approvalPolicy} returnedSandbox=${state.sandbox}`,
    );
    return state;
  }

  async runTurn({ threadId, prompt, timeoutMs }) {
    const baselineApprovalCount = this.approvalRequests.length;
    const baselineNotificationCount = this.notifications.length;
    const startResult = await this.request(
      "turn/start",
      {
        threadId,
        input: buildTurnInput(prompt),
      },
      15_000,
    );
    const ids = extractIds(startResult);
    const turnId = ids.runId;
    this.log(`turn started thread=${threadId} turn=${turnId || "<none>"} prompt=${summarizeTextForLog(prompt)}`);
    const deadline = Date.now() + timeoutMs;
    let assistantText = "";
    while (Date.now() < deadline) {
      const approval = this.approvalRequests[baselineApprovalCount];
      if (approval) {
        return {
          kind: "approval-requested",
          threadId,
          turnId,
          approvalMethod: approval.method,
        };
      }

      const relevantNotifications = this.notifications.slice(baselineNotificationCount);
      for (const notification of relevantNotifications) {
        const idsFromNotification = extractIds(notification.params);
        if (idsFromNotification.threadId && idsFromNotification.threadId !== threadId) {
          continue;
        }
        const assistant = extractAssistantNotificationText(notification.method, notification.params);
        if (assistant.text.trim()) {
          assistantText = assistant.text.trim();
        }
        const methodLower = notification.method.trim().toLowerCase();
        if (methodLower === "turn/completed") {
          return {
            kind: "turn-completed",
            threadId,
            turnId,
            assistantText,
          };
        }
        if (methodLower === "turn/failed" || methodLower === "turn/cancelled") {
          return {
            kind: "turn-failed",
            threadId,
            turnId,
            failureMethod: notification.method,
            assistantText,
          };
        }
      }
      await sleep(250);
    }
    return {
      kind: "timeout",
      threadId,
      turnId,
      assistantText,
    };
  }

  async waitForThreadTerminal(threadId, timeoutMs) {
    const baselineNotificationCount = this.notifications.length;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const relevantNotifications = this.notifications.slice(baselineNotificationCount);
      for (const notification of relevantNotifications) {
        const ids = extractIds(notification.params);
        if (ids.threadId !== threadId) {
          continue;
        }
        const methodLower = notification.method.trim().toLowerCase();
        if (methodLower === "turn/completed" || methodLower === "turn/failed" || methodLower === "turn/cancelled") {
          return notification.method;
        }
      }
      await sleep(250);
    }
    return null;
  }

  async waitForThreadClosed(threadId, timeoutMs) {
    const baselineNotificationCount = this.notifications.length;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const relevantNotifications = this.notifications.slice(baselineNotificationCount);
      for (const notification of relevantNotifications) {
        const ids = extractIds(notification.params);
        if (ids.threadId !== threadId) {
          continue;
        }
        if (notification.method.trim().toLowerCase() === "thread/closed") {
          this.log(`thread closed thread=${threadId}`);
          return true;
        }
      }
      await sleep(250);
    }
    return false;
  }

  async close() {
    if (!this.child || this.closed) {
      return;
    }
    this.child.kill("SIGTERM");
    await Promise.race([this.done, sleep(2_000)]);
    if (!this.closed) {
      this.child.kill("SIGKILL");
      await Promise.race([this.done, sleep(1_000)]);
    }
  }
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    prompt: DEFAULT_PROMPT,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--cwd") {
      options.cwd = path.resolve(argv[++index]);
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[++index]);
      continue;
    }
    if (arg === "--prompt") {
      options.prompt = argv[++index];
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: node scripts/app-server-thread-permissions-smoke.mjs [options]",
          "",
          "Options:",
          "  --cwd <dir>         Working directory for new threads (default: current directory)",
          `  --timeout-ms <ms>   Per-turn timeout (default: ${DEFAULT_TIMEOUT_MS})`,
          "  --prompt <text>     Prompt to send after starting each thread",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error(`Invalid --timeout-ms value: ${options.timeoutMs}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const harness = new StdioJsonRpcHarness({
    label: "full-access-config",
    command: "codex",
    args: [
      "app-server",
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="danger-full-access"',
    ],
    cwd: options.cwd,
  });

  try {
    console.log(`Working directory: ${options.cwd}`);
    console.log(`Prompt: ${options.prompt}`);
    await harness.start();
    await harness.initialize();

    const defaultThreadId = await harness.startThread(options.cwd);
    const initialFullAccessOutcome = await harness.runTurn({
      threadId: defaultThreadId,
      prompt: options.prompt,
      timeoutMs: options.timeoutMs,
    });
    const initialThreadClosed = await harness.waitForThreadClosed(defaultThreadId, 15_000);
    const downgradedState = await harness.resumeThread({
      threadId: defaultThreadId,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    const defaultOutcome = await harness.runTurn({
      threadId: defaultThreadId,
      prompt: options.prompt,
      timeoutMs: options.timeoutMs,
    });
    const defaultTerminal =
      defaultOutcome.kind === "approval-requested"
        ? await harness.waitForThreadTerminal(defaultThreadId, 15_000)
        : null;

    const fullAccessThreadId = await harness.startThread(options.cwd);
    const fullAccessOutcome = await harness.runTurn({
      threadId: fullAccessThreadId,
      prompt: options.prompt,
      timeoutMs: options.timeoutMs,
    });

    const restoredState = await harness.resumeThread({
      threadId: defaultThreadId,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const restoredOutcome = await harness.runTurn({
      threadId: defaultThreadId,
      prompt: options.prompt,
      timeoutMs: options.timeoutMs,
    });

    const summary = {
      initialFullAccessOutcome,
      initialThreadClosed,
      downgradedState,
      defaultOutcome,
      defaultTerminal,
      fullAccessOutcome,
      restoredState,
      restoredOutcome,
    };

    console.log("\nSummary:");
    console.log(JSON.stringify(summary, null, 2));

    const succeeded =
      initialFullAccessOutcome.kind === "turn-completed" &&
      initialThreadClosed &&
      downgradedState.approvalPolicy === "on-request" &&
      downgradedState.sandbox === "workspace-write" &&
      defaultOutcome.kind === "approval-requested" &&
      fullAccessOutcome.kind === "turn-completed" &&
      restoredState.approvalPolicy === "never" &&
      restoredState.sandbox === "danger-full-access" &&
      restoredOutcome.kind === "turn-completed";

    if (!succeeded) {
      process.exitCode = 1;
    }
  } finally {
    await harness.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
