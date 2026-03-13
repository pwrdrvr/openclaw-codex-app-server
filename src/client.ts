import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import WebSocket from "ws";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { createPendingInputState, parseCodexUserInput } from "./pending-input.js";
import type {
  AccountSummary,
  CompactProgress,
  CompactResult,
  ContextUsageSnapshot,
  ExperimentalFeatureSummary,
  McpServerSummary,
  ModelSummary,
  PendingInputAction,
  PendingInputState,
  PluginSettings,
  RateLimitSummary,
  ReviewResult,
  ReviewTarget,
  SkillSummary,
  ThreadReplay,
  ThreadState,
  ThreadSummary,
  TurnResult,
} from "./types.js";

type JsonRpcId = string | number;
type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type JsonRpcNotificationHandler = (method: string, params: unknown) => Promise<void> | void;
type JsonRpcRequestHandler = (method: string, params: unknown) => Promise<unknown>;

type JsonRpcClient = {
  connect: () => Promise<void>;
  close: () => Promise<void>;
  notify: (method: string, params?: unknown) => Promise<void>;
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  setNotificationHandler: (handler: JsonRpcNotificationHandler) => void;
  setRequestHandler: (handler: JsonRpcRequestHandler) => void;
};

export type ActiveCodexRun = {
  result: Promise<TurnResult | ReviewResult>;
  queueMessage: (text: string) => Promise<boolean>;
  submitPendingInput: (actionIndex: number) => Promise<boolean>;
  interrupt: () => Promise<void>;
  isAwaitingInput: () => boolean;
  getThreadId: () => string | undefined;
};

const DEFAULT_PROTOCOL_VERSION = "1.0";
const TRAILING_NOTIFICATION_SETTLE_MS = 250;
const TURN_STEER_METHODS = ["turn/steer"] as const;
const TURN_INTERRUPT_METHODS = ["turn/interrupt"] as const;

function isTransportClosedError(error: unknown): boolean {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
  options?: { trim?: boolean },
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const text = options?.trim === false ? value : value.trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function pickFiniteNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function pickBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }
  }
  return undefined;
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

function findFirstNestedString(
  value: unknown,
  keys: readonly string[],
  nestedKeys: readonly string[] = keys,
  depth = 0,
): string | undefined {
  if (depth > 6) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findFirstNestedString(entry, keys, nestedKeys, depth + 1);
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
  const direct = pickString(record, [...keys]);
  if (direct) {
    return direct;
  }
  for (const key of keys) {
    const nestedRecord = asRecord(record[key]);
    if (!nestedRecord) {
      continue;
    }
    const nested = pickString(nestedRecord, [...nestedKeys]);
    if (nested) {
      return nested;
    }
  }
  for (const nested of Object.values(record)) {
    const match = findFirstNestedString(nested, keys, nestedKeys, depth + 1);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function findFirstArrayByKeys(
  value: unknown,
  keys: readonly string[],
  depth = 0,
): unknown[] | undefined {
  if (depth > 6) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findFirstArrayByKeys(entry, keys, depth + 1);
      if (match && match.length > 0) {
        return match;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const nested = record[key];
    if (Array.isArray(nested) && nested.length > 0) {
      return nested;
    }
  }
  for (const nested of Object.values(record)) {
    const match = findFirstArrayByKeys(nested, keys, depth + 1);
    if (match && match.length > 0) {
      return match;
    }
  }
  return undefined;
}

function findFirstNestedValue(value: unknown, keys: readonly string[], depth = 0): unknown {
  if (depth > 6) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findFirstNestedValue(entry, keys, depth + 1);
      if (match !== undefined) {
        return match;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  for (const nested of Object.values(record)) {
    const match = findFirstNestedValue(nested, keys, depth + 1);
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

function collectStreamingText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectStreamingText(entry)).join("");
  }
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  for (const key of ["delta", "text", "content", "message", "input", "output", "parts"]) {
    const direct = collectStreamingText(record[key]);
    if (direct) {
      return direct;
    }
  }
  for (const nestedKey of ["item", "turn", "thread", "response", "result", "data"]) {
    const nested = collectStreamingText(record[nestedKey]);
    if (nested) {
      return nested;
    }
  }
  return "";
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

function extractIds(value: unknown): { threadId?: string; runId?: string; requestId?: string } {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const threadRecord = asRecord(record.thread) ?? asRecord(record.session);
  const turnRecord = asRecord(record.turn) ?? asRecord(record.run);
  return {
    threadId:
      pickString(record, ["threadId", "thread_id", "conversationId", "conversation_id"]) ??
      pickString(threadRecord ?? {}, ["id", "threadId", "thread_id", "conversationId"]),
    runId:
      pickString(record, ["turnId", "turn_id", "runId", "run_id"]) ??
      pickString(turnRecord ?? {}, ["id", "turnId", "turn_id", "runId", "run_id"]),
    requestId:
      pickString(record, ["requestId", "request_id", "serverRequestId"]) ??
      pickString(asRecord(record.serverRequest) ?? {}, ["id", "requestId", "request_id"]),
  };
}

function extractOptionValues(value: unknown): string[] {
  const rawOptions = findFirstArrayByKeys(value, [
    "options",
    "choices",
    "availableDecisions",
    "decisions",
  ]);
  if (!rawOptions) {
    return [];
  }
  return rawOptions
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      return (
        pickString(asRecord(entry) ?? {}, ["label", "title", "text", "value", "name", "id"]) ?? ""
      );
    })
    .filter(Boolean);
}

function isInteractiveServerRequest(method: string): boolean {
  const normalized = method.trim().toLowerCase();
  return normalized.includes("requestuserinput") || normalized.includes("requestapproval");
}

function isMethodUnavailableError(error: unknown, method?: string): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  if (normalized.includes("method not found") || normalized.includes("unknown method")) {
    return true;
  }
  if (!normalized.includes("unknown variant")) {
    return false;
  }
  if (!method) {
    return true;
  }
  return normalized.includes(`unknown variant \`${method.toLowerCase()}\``);
}

const RPC_METHODS_REQUIRING_THREAD_ID = new Set([
  "thread/resume",
  "thread/unsubscribe",
  "thread/name/set",
  "thread/compact/start",
  "thread/read",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
  "review/start",
]);

function methodRequiresThreadId(method: string): boolean {
  return RPC_METHODS_REQUIRING_THREAD_ID.has(method.trim().toLowerCase());
}

function payloadHasThreadId(payload: unknown): boolean {
  const record = asRecord(payload);
  if (!record) {
    return false;
  }
  return Boolean(
    pickString(record, ["threadId", "thread_id"]) ??
      findFirstNestedString(record, ["threadId", "thread_id"]),
  );
}

class WsJsonRpcClient implements JsonRpcClient {
  private socket: any = null;
  private readonly pending = new Map<string, PendingRequest>();
  private counter = 0;
  private onNotification: JsonRpcNotificationHandler = () => undefined;
  private onRequest: JsonRpcRequestHandler = async () => ({});

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> | undefined,
    private readonly requestTimeoutMs: number,
  ) {}

  setNotificationHandler(handler: JsonRpcNotificationHandler): void {
    this.onNotification = handler;
  }

  setRequestHandler(handler: JsonRpcRequestHandler): void {
    this.onRequest = handler;
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    this.socket = await new Promise<any>((resolve, reject) => {
      const socket = new WebSocket(this.url, { headers: this.headers });
      socket.once("open", () => resolve(socket));
      socket.once("error", (error: unknown) => reject(error));
    });
    this.socket.on("message", (data: any) => {
      const text =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Buffer.from(String(data)).toString("utf8");
      void this.handleMessage(text);
    });
    this.socket.on("close", () => {
      this.flushPending(new Error("codex app server websocket closed"));
      this.socket = null;
    });
  }

  async close(): Promise<void> {
    this.flushPending(new Error("codex app server websocket closed"));
    const socket = this.socket;
    this.socket = null;
    if (!socket) {
      return;
    }
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
      setTimeout(resolve, 250);
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.send({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = `rpc-${++this.counter}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app server timeout: ${method}`));
      }, Math.max(100, timeoutMs ?? this.requestTimeoutMs));
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({ jsonrpc: "2.0", id, method, params: params ?? {} });
    return await result;
  }

  private send(payload: JsonRpcEnvelope): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("codex app server websocket not connected");
    }
    socket.send(JSON.stringify(payload));
  }

  private async handleMessage(raw: string): Promise<void> {
    const payload = parseJsonRpc(raw);
    if (!payload) {
      return;
    }
    await dispatchJsonRpcEnvelope(payload, {
      pending: this.pending,
      onNotification: this.onNotification,
      onRequest: this.onRequest,
      respond: (frame) => this.send(frame),
    });
  }

  private flushPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

class StdioJsonRpcClient implements JsonRpcClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private counter = 0;
  private onNotification: JsonRpcNotificationHandler = () => undefined;
  private onRequest: JsonRpcRequestHandler = async () => ({});

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly requestTimeoutMs: number,
  ) {}

  setNotificationHandler(handler: JsonRpcNotificationHandler): void {
    this.onNotification = handler;
  }

  setRequestHandler(handler: JsonRpcRequestHandler): void {
    this.onRequest = handler;
  }

  async connect(): Promise<void> {
    if (this.process) {
      return;
    }
    const child = spawn(this.command, ["app-server", ...this.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("codex app server stdio pipes unavailable");
    }
    this.process = child;
    const lineReader = readline.createInterface({ input: child.stdout });
    lineReader.on("line", (line) => {
      void this.handleLine(line);
    });
    child.stderr.on("data", () => undefined);
    child.on("close", () => {
      this.flushPending(new Error("codex app server stdio closed"));
      this.process = null;
    });
  }

  async close(): Promise<void> {
    this.flushPending(new Error("codex app server stdio closed"));
    const child = this.process;
    this.process = null;
    if (!child) {
      return;
    }
    child.kill();
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = `rpc-${++this.counter}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app server timeout: ${method}`));
      }, Math.max(100, timeoutMs ?? this.requestTimeoutMs));
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ jsonrpc: "2.0", id, method, params: params ?? {} });
    return await result;
  }

  private write(payload: JsonRpcEnvelope): void {
    const child = this.process;
    if (!child?.stdin) {
      throw new Error("codex app server stdio not connected");
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private async handleLine(line: string): Promise<void> {
    const payload = parseJsonRpc(line);
    if (!payload) {
      return;
    }
    await dispatchJsonRpcEnvelope(payload, {
      pending: this.pending,
      onNotification: this.onNotification,
      onRequest: this.onRequest,
      respond: (frame) => this.write(frame),
    });
  }

  private flushPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function parseJsonRpc(raw: string): JsonRpcEnvelope | null {
  try {
    const payload = JSON.parse(raw) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    return payload as JsonRpcEnvelope;
  } catch {
    return null;
  }
}

async function dispatchJsonRpcEnvelope(
  payload: JsonRpcEnvelope,
  params: {
    pending: Map<string, PendingRequest>;
    onNotification: JsonRpcNotificationHandler;
    onRequest: JsonRpcRequestHandler;
    respond: (payload: JsonRpcEnvelope) => void;
  },
): Promise<void> {
  if (payload.id != null && (Object.hasOwn(payload, "result") || Object.hasOwn(payload, "error"))) {
    const key = String(payload.id);
    const pending = params.pending.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    params.pending.delete(key);
    if (payload.error) {
      pending.reject(
        new Error(
          `codex app server rpc error (${payload.error.code ?? "unknown"}): ${payload.error.message ?? "unknown error"}`,
        ),
      );
      return;
    }
    pending.resolve(payload.result);
    return;
  }

  const method = payload.method?.trim();
  if (!method) {
    return;
  }
  if (payload.id == null) {
    await params.onNotification(method, payload.params);
    return;
  }
  try {
    const result = await params.onRequest(method, payload.params);
    params.respond({
      jsonrpc: "2.0",
      id: payload.id,
      result: result ?? {},
    });
  } catch (error) {
    params.respond({
      jsonrpc: "2.0",
      id: payload.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function createJsonRpcClient(settings: PluginSettings): JsonRpcClient {
  if (settings.transport === "websocket") {
    if (!settings.url) {
      throw new Error("Codex websocket transport requires a url.");
    }
    return new WsJsonRpcClient(settings.url, settings.headers, settings.requestTimeoutMs);
  }
  return new StdioJsonRpcClient(settings.command, settings.args, settings.requestTimeoutMs);
}

async function initializeClient(params: {
  client: JsonRpcClient;
  settings: PluginSettings;
  sessionKey?: string;
}): Promise<void> {
  await params.client.request("initialize", {
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    clientInfo: { name: "openclaw-app-server", version: "0.0.0-development" },
    capabilities: { experimentalApi: true },
  });
  await params.client.notify("initialized", {});
  if (params.sessionKey) {
    await params.client
      .request("session/update", {
        sessionKey: params.sessionKey,
        session_key: params.sessionKey,
      })
      .catch((error) => {
        if (!isMethodUnavailableError(error, "session/update")) {
          throw error;
        }
      });
  }
}

async function requestWithFallbacks(params: {
  client: JsonRpcClient;
  methods: string[];
  payloads: unknown[];
  timeoutMs: number;
}): Promise<unknown> {
  let lastError: unknown;
  for (const method of params.methods) {
    for (const payload of params.payloads) {
      if (methodRequiresThreadId(method) && !payloadHasThreadId(payload)) {
        throw new Error(`codex app server request missing threadId: ${method}`);
      }
      try {
        return await params.client.request(method, payload, params.timeoutMs);
      } catch (error) {
        lastError = error;
        if (!isMethodUnavailableError(error, method)) {
          continue;
        }
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildThreadDiscoveryFilter(filter?: string, workspaceDir?: string): unknown[] {
  return [
    {
      query: filter?.trim() || undefined,
      cwd: workspaceDir,
      limit: 50,
    },
    {
      filter: filter?.trim() || undefined,
      cwd: workspaceDir,
      limit: 50,
    },
    {},
  ];
}

function buildThreadResumePayloads(params: {
  threadId: string;
  model?: string;
  cwd?: string;
  serviceTier?: string | null;
}): Array<Record<string, unknown>> {
  const base: Record<string, unknown> = { threadId: params.threadId };
  if (params.model?.trim()) {
    base.model = params.model.trim();
  }
  if (params.cwd?.trim()) {
    base.cwd = params.cwd.trim();
  }
  if (params.serviceTier !== undefined) {
    base.serviceTier = params.serviceTier;
  }
  return [base, { ...base, thread_id: params.threadId, threadId: undefined }].map((entry) => {
    const next = { ...entry };
    if (next.threadId === undefined) {
      delete next.threadId;
    }
    return next;
  });
}

function buildTurnInput(prompt: string): unknown[] {
  return [
    [{ type: "text", text: prompt }],
    [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
  ];
}

function buildTurnStartPayloads(params: {
  threadId: string;
  prompt: string;
  model?: string;
}): unknown[] {
  return buildTurnInput(params.prompt).flatMap((input) => {
    const camel: Record<string, unknown> = {
      threadId: params.threadId,
      input,
    };
    const snake: Record<string, unknown> = {
      thread_id: params.threadId,
      input,
    };
    if (params.model?.trim()) {
      camel.model = params.model.trim();
      snake.model = params.model.trim();
    }
    return [camel, snake];
  });
}

function normalizeEpochTimestamp(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function extractThreadRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractThreadRecords(entry));
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  const directId = pickString(record, ["id", "threadId", "thread_id", "conversationId"]);
  if (directId && !Array.isArray(record.items) && !Array.isArray(record.threads)) {
    return [record];
  }
  const out: Record<string, unknown>[] = [];
  for (const key of ["threads", "items", "data", "results"]) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      out.push(...nested.flatMap((entry) => extractThreadRecords(entry)));
    }
  }
  return out;
}

function extractThreadsFromValue(value: unknown): ThreadSummary[] {
  const items = extractThreadRecords(value);
  const summaries = new Map<string, ThreadSummary>();
  for (const record of items) {
    const threadId =
      pickString(record, ["threadId", "thread_id", "id", "conversationId", "conversation_id"]) ??
      pickString(asRecord(record.thread) ?? {}, ["id", "threadId", "thread_id"]);
    if (!threadId) {
      continue;
    }
    const sessionRecord = asRecord(record.session);
    summaries.set(threadId, {
      threadId,
      title:
        pickString(record, ["title", "name", "headline"]) ??
        pickString(sessionRecord ?? {}, ["title", "name"]),
      summary:
        pickString(record, ["summary", "preview", "snippet", "text"]) ??
        dedupeJoinedText(collectText(record.messages ?? record.lastMessage ?? record.content)),
      projectKey:
        pickString(record, ["projectKey", "project_key", "cwd"]) ??
        pickString(sessionRecord ?? {}, ["cwd", "projectKey", "project_key"]),
      createdAt: normalizeEpochTimestamp(
        pickNumber(record, ["createdAt", "created_at"]) ??
          pickNumber(sessionRecord ?? {}, ["createdAt", "created_at"]),
      ),
      updatedAt: normalizeEpochTimestamp(
        pickNumber(record, ["updatedAt", "updated_at", "lastActivityAt", "createdAt"]) ??
          pickNumber(sessionRecord ?? {}, ["updatedAt", "updated_at", "lastActivityAt"]),
      ),
      gitBranch:
        pickString(asRecord(record.gitInfo) ?? {}, ["branch"]) ??
        pickString(asRecord(record.git_info) ?? {}, ["branch"]) ??
        pickString(asRecord(sessionRecord?.gitInfo) ?? {}, ["branch"]) ??
        pickString(asRecord(sessionRecord?.git_info) ?? {}, ["branch"]),
    });
  }
  return [...summaries.values()].sort(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
  );
}

function normalizeConversationRole(value: string | undefined): "user" | "assistant" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "user" || normalized === "usermessage") {
    return "user";
  }
  if (normalized === "assistant" || normalized === "agentmessage" || normalized === "assistantmessage") {
    return "assistant";
  }
  return undefined;
}

function collectMessageText(record: Record<string, unknown>): string {
  return dedupeJoinedText([
    ...collectText(record.content),
    ...collectText(record.text),
    ...collectText(record.message),
    ...collectText(record.messages),
    ...collectText(record.input),
    ...collectText(record.output),
    ...collectText(record.parts),
  ]);
}

function extractConversationMessages(
  value: unknown,
): Array<{ role: "user" | "assistant"; text: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry));
      return;
    }
    const record = asRecord(node);
    if (!record) {
      return;
    }
    const role = normalizeConversationRole(
      pickString(record, ["role", "author", "speaker", "source", "type"]),
    );
    const text = collectMessageText(record);
    if (role && text) {
      out.push({ role, text });
    }
    for (const key of [
      "items",
      "messages",
      "content",
      "parts",
      "entries",
      "data",
      "results",
      "turns",
      "events",
      "item",
      "message",
      "thread",
      "response",
      "result",
    ]) {
      visit(record[key]);
    }
  };
  visit(value);
  return out;
}

function extractThreadReplayFromReadResult(value: unknown): ThreadReplay {
  const messages = extractConversationMessages(value);
  let lastUserMessage: string | undefined;
  let lastAssistantMessage: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!lastAssistantMessage && message?.role === "assistant") {
      lastAssistantMessage = message.text;
    }
    if (!lastUserMessage && message?.role === "user") {
      lastUserMessage = message.text;
    }
    if (lastUserMessage && lastAssistantMessage) {
      break;
    }
  }
  return { lastUserMessage, lastAssistantMessage };
}

function extractModelSummaries(value: unknown): ModelSummary[] {
  const out = new Map<string, ModelSummary>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry));
      return;
    }
    const record = asRecord(node);
    if (!record) {
      return;
    }
    const provider = pickString(record, ["provider", "providerId", "provider_id"]);
    const rawId =
      pickString(record, ["id", "model", "modelId", "model_id", "name", "slug"]) ??
      pickString(record, ["ref", "modelRef", "model_ref"]);
    if (rawId) {
      const id =
        provider && !rawId.includes("/") && !rawId.startsWith("@") ? `${provider}/${rawId}` : rawId;
      const existing = out.get(id);
      out.set(id, {
        id,
        label:
          pickString(record, ["label", "title", "displayName", "display_name"]) ?? existing?.label,
        description:
          pickString(record, ["description", "summary", "details"]) ?? existing?.description,
        current:
          pickBoolean(record, ["current", "selected", "isCurrent", "is_current", "active"]) ??
          existing?.current,
      });
    }
    for (const key of ["models", "items", "data", "results", "entries", "available"]) {
      visit(record[key]);
    }
  };
  visit(value);
  return [...out.values()].sort((left, right) => {
    if (left.current && !right.current) {
      return -1;
    }
    if (!left.current && right.current) {
      return 1;
    }
    return left.id.localeCompare(right.id);
  });
}

function extractSkillSummaries(value: unknown): SkillSummary[] {
  const items: SkillSummary[] = [];
  const containers = Array.isArray(asRecord(value)?.data)
    ? (asRecord(value)?.data as unknown[])
    : Array.isArray(value)
      ? value
      : [];
  for (const containerValue of containers) {
    const container = asRecord(containerValue);
    if (!container) {
      continue;
    }
    const cwd = pickString(container, ["cwd", "path", "projectRoot"]);
    const skills = Array.isArray(container.skills) ? container.skills : [];
    for (const skillValue of skills) {
      const skill = asRecord(skillValue);
      if (!skill) {
        continue;
      }
      const name = pickString(skill, ["name", "id"]);
      if (!name) {
        continue;
      }
      const iface = asRecord(skill.interface);
      items.push({
        cwd,
        name,
        description:
          pickString(skill, ["description", "shortDescription"]) ??
          pickString(iface ?? {}, ["shortDescription", "description"]),
        enabled: pickBoolean(skill, ["enabled", "active", "isEnabled", "is_enabled"]),
      });
    }
  }
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

function extractExperimentalFeatureSummaries(value: unknown): ExperimentalFeatureSummary[] {
  const items: ExperimentalFeatureSummary[] = [];
  const entries = Array.isArray(asRecord(value)?.data)
    ? (asRecord(value)?.data as unknown[])
    : Array.isArray(value)
      ? value
      : [];
  for (const entryValue of entries) {
    const entry = asRecord(entryValue);
    if (!entry) {
      continue;
    }
    const name = pickString(entry, ["name", "id", "key"]);
    if (!name) {
      continue;
    }
    items.push({
      name,
      stage: pickString(entry, ["stage", "status"]),
      displayName: pickString(entry, ["displayName", "display_name", "title"]),
      description: pickString(entry, ["description", "summary", "announcement"]),
      enabled: pickBoolean(entry, ["enabled", "active", "isEnabled", "is_enabled"]),
      defaultEnabled: pickBoolean(entry, ["defaultEnabled", "default_enabled", "enabledByDefault"]),
    });
  }
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

function extractMcpServerSummaries(value: unknown): McpServerSummary[] {
  const items: McpServerSummary[] = [];
  const entries = Array.isArray(asRecord(value)?.data)
    ? (asRecord(value)?.data as unknown[])
    : Array.isArray(value)
      ? value
      : [];
  for (const entryValue of entries) {
    const entry = asRecord(entryValue);
    if (!entry) {
      continue;
    }
    const name = pickString(entry, ["name", "id"]);
    if (!name) {
      continue;
    }
    const tools = asRecord(entry.tools);
    items.push({
      name,
      authStatus: pickString(entry, ["authStatus", "auth_status", "status"]),
      toolCount: tools ? Object.keys(tools).length : Array.isArray(entry.tools) ? entry.tools.length : 0,
      resourceCount: Array.isArray(entry.resources) ? entry.resources.length : 0,
      resourceTemplateCount: Array.isArray(entry.resourceTemplates)
        ? entry.resourceTemplates.length
        : Array.isArray(entry.resource_templates)
          ? entry.resource_templates.length
          : 0,
    });
  }
  return items.sort((left, right) => left.name.localeCompare(right.name));
}

function summarizeSandboxPolicy(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if ("dangerFullAccess" in record || "danger_full_access" in record) {
    return "danger-full-access";
  }
  if ("readOnly" in record || "read_only" in record) {
    return "read-only";
  }
  if ("workspaceWrite" in record || "workspace_write" in record) {
    return "workspace-write";
  }
  if ("externalSandbox" in record || "external_sandbox" in record) {
    return "external-sandbox";
  }
  return pickString(record, ["mode", "type", "kind", "name"]);
}

function extractThreadState(value: unknown): ThreadState {
  return {
    threadId:
      extractIds(value).threadId ??
      findFirstNestedString(value, ["threadId", "thread_id", "id", "conversationId"]) ??
      "",
    threadName: findFirstNestedString(value, ["threadName", "thread_name", "name", "title"]),
    model: findFirstNestedString(value, ["model", "modelId", "model_id"]),
    modelProvider: findFirstNestedString(value, [
      "modelProvider",
      "model_provider",
      "provider",
      "providerId",
      "provider_id",
    ]),
    serviceTier: findFirstNestedString(value, ["serviceTier", "service_tier"]),
    cwd: findFirstNestedString(value, ["cwd", "workdir", "directory"]),
    approvalPolicy: findFirstNestedString(value, ["approvalPolicy", "approval_policy"]),
    sandbox: summarizeSandboxPolicy(findFirstNestedValue(value, ["sandbox", "sandbox_policy"])),
    reasoningEffort: findFirstNestedString(value, ["reasoningEffort", "reasoning_effort"]),
  };
}

function normalizeEpochMilliseconds(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const abs = Math.abs(value);
  if (abs < 100_000_000_000) {
    return Math.round(value * 1_000);
  }
  if (abs > 100_000_000_000_000) {
    return Math.round(value / 1_000);
  }
  return Math.round(value);
}

function extractRateLimitSummaries(value: unknown): RateLimitSummary[] {
  const out = new Map<string, RateLimitSummary>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry));
      return;
    }
    const record = asRecord(node);
    if (!record) {
      return;
    }
    const remaining = pickFiniteNumber(record, [
      "remaining",
      "remainingCount",
      "remaining_count",
      "available",
    ]);
    const limit = pickFiniteNumber(record, ["limit", "max", "quota", "capacity"]);
    const used = pickFiniteNumber(record, ["used", "consumed", "count"]);
    const usedPercent = pickFiniteNumber(record, ["usedPercent", "used_percent"]);
    const resetAt = pickNumber(record, [
      "resetAt",
      "reset_at",
      "resetsAt",
      "resets_at",
      "nextResetAt",
    ]);
    const windowSeconds = pickFiniteNumber(record, [
      "windowSeconds",
      "window_seconds",
      "resetInSeconds",
      "retryAfterSeconds",
    ]);
    const name =
      pickString(record, ["name", "label", "scope", "resource", "model", "id"]) ??
      (typeof remaining === "number" ||
      typeof limit === "number" ||
      typeof used === "number" ||
      typeof resetAt === "number"
        ? `limit-${out.size + 1}`
        : undefined);
    if (name) {
      out.set(name, {
        name,
        remaining,
        limit,
        used,
        usedPercent,
        resetAt: normalizeEpochMilliseconds(resetAt),
        windowSeconds,
      });
    }
    for (const key of [
      "limits",
      "items",
      "data",
      "results",
      "entries",
      "buckets",
      "rateLimits",
      "rate_limits",
    ]) {
      visit(record[key]);
    }
  };
  visit(value);
  return [...out.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function extractAccountSummary(value: unknown): AccountSummary {
  const root = asRecord(value) ?? {};
  const account = asRecord(findFirstNestedValue(value, ["account"])) ?? asRecord(root.account) ?? undefined;
  const type = pickString(account ?? {}, ["type"]);
  return {
    type: type === "apiKey" || type === "chatgpt" ? type : undefined,
    email: pickString(account ?? {}, ["email"]),
    planType: pickString(account ?? {}, ["planType", "plan_type"]),
    requiresOpenaiAuth: pickBoolean(root, ["requiresOpenaiAuth", "requires_openai_auth"]),
  };
}

function extractReviewTextFromNotification(method: string, params: unknown): string | undefined {
  const methodLower = method.trim().toLowerCase();
  if (methodLower !== "item/completed" && methodLower !== "item/started") {
    return undefined;
  }
  const item = asRecord(asRecord(params)?.item);
  const itemType = pickString(item ?? {}, ["type"])?.trim().toLowerCase();
  if (itemType !== "exitedreviewmode") {
    return undefined;
  }
  return pickString(item ?? {}, ["review"]);
}

function extractAssistantItemId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const item = asRecord(record.item) ?? record;
  return pickString(item, ["id", "itemId", "item_id", "messageId", "message_id"]);
}

function extractAssistantTextFromItemPayload(
  value: unknown,
  options?: { streaming?: boolean },
): string {
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  const item = asRecord(record.item) ?? record;
  const itemType = pickString(item, ["type"])?.toLowerCase();
  if (itemType !== "agentmessage") {
    return "";
  }
  return options?.streaming
    ? collectStreamingText(item)
    : (pickString(item, ["text"], { trim: false }) ?? collectStreamingText(item));
}

function extractAssistantNotificationText(
  method: string,
  params: unknown,
): { mode: "delta" | "snapshot" | "ignore"; text: string; itemId?: string } {
  const methodLower = method.trim().toLowerCase();
  if (methodLower === "item/agentmessage/delta") {
    return {
      mode: "delta",
      text: collectStreamingText(params),
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
  return { mode: "ignore", text: "" };
}

function extractPlanDeltaNotification(value: unknown): { itemId?: string; delta: string } {
  return {
    itemId: extractAssistantItemId(value),
    delta: collectStreamingText(value),
  };
}

function extractTurnPlanUpdate(value: unknown): {
  explanation?: string;
  steps: TurnResult["planArtifact"] extends infer T ? (T extends { steps: infer S } ? S : never) : never;
} {
  const record = asRecord(value);
  const planRecord = asRecord(record?.plan);
  const rawPlan = Array.isArray(record?.plan)
    ? record.plan
    : Array.isArray(planRecord?.steps)
      ? planRecord.steps
      : [];
  const steps = rawPlan
    .map((entry) => {
      const stepRecord = asRecord(entry);
      const step = pickString(stepRecord ?? {}, ["step", "title", "text"]);
      const statusRaw =
        pickString(stepRecord ?? {}, ["status"], { trim: true })?.toLowerCase() ?? "pending";
      if (!step) {
        return null;
      }
      const status =
        statusRaw === "inprogress" || statusRaw === "in_progress"
          ? "inProgress"
          : statusRaw === "completed"
            ? "completed"
            : "pending";
      return { step, status } as const;
    })
    .filter(Boolean) as Array<{ step: string; status: "pending" | "inProgress" | "completed" }>;
  return {
    explanation:
      pickString(planRecord ?? {}, ["explanation"], { trim: true }) ??
      pickString(record ?? {}, ["explanation"], { trim: true }) ??
      findFirstNestedString(value, ["explanation"]),
    steps,
  };
}

function extractCompletedPlanText(value: unknown): { itemId?: string; text?: string } {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const item = asRecord(record.item) ?? record;
  const itemType = pickString(item, ["type"])?.toLowerCase();
  if (itemType !== "plan") {
    return {};
  }
  return {
    itemId: extractAssistantItemId(item),
    text: pickString(item, ["text"], { trim: false }) ?? collectStreamingText(item),
  };
}

function extractThreadTokenUsageSnapshot(value: unknown): ContextUsageSnapshot | undefined {
  const root =
    asRecord(findFirstNestedValue(value, ["tokenUsage", "token_usage", "info"])) ?? asRecord(value);
  if (!root) {
    return undefined;
  }
  const currentUsage =
    asRecord(findFirstNestedValue(root, ["last", "last_token_usage"])) ??
    asRecord(root.last) ??
    asRecord(root.last_token_usage) ??
    asRecord(findFirstNestedValue(root, ["total", "total_token_usage"])) ??
    asRecord(root.total) ??
    asRecord(root.total_token_usage);
  const totalTokens = pickFiniteNumber(currentUsage ?? {}, ["totalTokens", "total_tokens"]);
  const inputTokens = pickFiniteNumber(currentUsage ?? {}, ["inputTokens", "input_tokens"]);
  const cachedInputTokens = pickFiniteNumber(currentUsage ?? {}, [
    "cachedInputTokens",
    "cached_input_tokens",
  ]);
  const outputTokens = pickFiniteNumber(currentUsage ?? {}, ["outputTokens", "output_tokens"]);
  const reasoningOutputTokens = pickFiniteNumber(currentUsage ?? {}, [
    "reasoningOutputTokens",
    "reasoning_output_tokens",
  ]);
  const contextWindow = pickFiniteNumber(root, ["modelContextWindow", "model_context_window"]);
  if (
    totalTokens === undefined &&
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined &&
    contextWindow === undefined
  ) {
    return undefined;
  }
  const remainingTokens =
    typeof contextWindow === "number" && typeof totalTokens === "number"
      ? Math.max(0, contextWindow - totalTokens)
      : undefined;
  const remainingPercent =
    typeof contextWindow === "number" && contextWindow > 0 && typeof remainingTokens === "number"
      ? Math.max(0, Math.min(100, Math.round((remainingTokens / contextWindow) * 100)))
      : undefined;
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    contextWindow,
    remainingTokens,
    remainingPercent,
  };
}

function extractContextCompactionProgress(
  method: string,
  params: unknown,
): { phase: "started" | "completed"; itemId?: string } | undefined {
  const methodLower = method.trim().toLowerCase();
  if (methodLower === "thread/compacted") {
    return { phase: "completed" };
  }
  if (methodLower !== "item/started" && methodLower !== "item/completed") {
    return undefined;
  }
  const item = asRecord(asRecord(params)?.item);
  const itemType = pickString(item ?? {}, ["type"])
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (itemType !== "contextcompaction") {
    return undefined;
  }
  return {
    phase: methodLower === "item/started" ? "started" : "completed",
    itemId: extractAssistantItemId(item),
  };
}

function mapPendingInputResponse(params: {
  methodLower: string;
  requestParams: unknown;
  response: unknown;
  options: string[];
  actions: PendingInputAction[];
  timedOut: boolean;
}): unknown {
  const { methodLower, response, options, actions, timedOut } = params;
  if (methodLower.includes("requestapproval")) {
    if (timedOut) {
      return { decision: "cancel" };
    }
    const record = asRecord(response);
    const index = typeof record?.index === "number" ? record.index : undefined;
    const action = index != null ? actions[index] : undefined;
    if (action?.kind === "approval") {
      return {
        decision: action.responseDecision,
        ...(action.proposedExecpolicyAmendment
          ? { proposedExecpolicyAmendment: action.proposedExecpolicyAmendment }
          : {}),
      };
    }
    const selected =
      (index != null
        ? action?.kind === "option"
          ? action.value
          : options[index]
        : undefined) ??
      pickString(record ?? {}, ["option", "text", "value", "label"]);
    return { decision: selected || "decline" };
  }
  if (timedOut) {
    return { cancelled: true, reason: "timeout" };
  }
  return response;
}

async function withInitializedClient<T>(
  params: {
    settings: PluginSettings;
    sessionKey?: string;
  },
  callback: (args: { client: JsonRpcClient; settings: PluginSettings }) => Promise<T>,
): Promise<T> {
  const client = createJsonRpcClient(params.settings);
  try {
    await client.connect();
    await initializeClient({
      client,
      settings: params.settings,
      sessionKey: params.sessionKey,
    });
    return await callback({ client, settings: params.settings });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function isMissingThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("no rollout found for thread id") ||
    normalized.includes("thread not found") ||
    normalized.includes("no thread found") ||
    normalized.includes("unknown thread id")
  );
}

export class CodexAppServerClient {
  constructor(
    private readonly settings: PluginSettings,
    private readonly logger: PluginLogger,
  ) {}

  async listThreads(params: {
    sessionKey?: string;
    workspaceDir?: string;
    filter?: string;
  }): Promise<ThreadSummary[]> {
    return await withInitializedClient(
      { settings: this.settings, sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        const result = await requestWithFallbacks({
          client,
          methods: ["thread/list", "thread/loaded/list"],
          payloads: buildThreadDiscoveryFilter(params.filter, params.workspaceDir),
          timeoutMs: settings.requestTimeoutMs,
        });
        return extractThreadsFromValue(result);
      },
    );
  }

  async listModels(params: { sessionKey?: string }): Promise<ModelSummary[]> {
    return await withInitializedClient(
      { settings: this.settings, sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        const result = await requestWithFallbacks({
          client,
          methods: ["model/list"],
          payloads: [{}],
          timeoutMs: settings.requestTimeoutMs,
        });
        return extractModelSummaries(result);
      },
    );
  }

  async listSkills(params: { sessionKey?: string; workspaceDir?: string }): Promise<SkillSummary[]> {
    return await withInitializedClient(
      { settings: this.settings, sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        const result = await requestWithFallbacks({
          client,
          methods: ["skills/list"],
          payloads: [
            {
              cwds: params.workspaceDir ? [params.workspaceDir] : undefined,
            },
            {
              cwd: params.workspaceDir,
            },
          ],
          timeoutMs: settings.requestTimeoutMs,
        });
        return extractSkillSummaries(result);
      },
    );
  }

  async listExperimentalFeatures(params: {
    sessionKey?: string;
  }): Promise<ExperimentalFeatureSummary[]> {
    return await withInitializedClient(
      { settings: this.settings, sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        const result = await requestWithFallbacks({
          client,
          methods: ["experimentalFeature/list"],
          payloads: [{ limit: 100 }, {}],
          timeoutMs: settings.requestTimeoutMs,
        });
        return extractExperimentalFeatureSummaries(result);
      },
    );
  }

  async listMcpServers(params: { sessionKey?: string }): Promise<McpServerSummary[]> {
    return await withInitializedClient(
      { settings: this.settings, sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        const result = await requestWithFallbacks({
          client,
          methods: ["mcpServerStatus/list"],
          payloads: [{ limit: 100 }, {}],
          timeoutMs: settings.requestTimeoutMs,
        });
        return extractMcpServerSummaries(result);
      },
    );
  }

  async readRateLimits(params: { sessionKey?: string }): Promise<RateLimitSummary[]> {
    return await withInitializedClient(
      { settings: this.settings, sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        const result = await requestWithFallbacks({
          client,
          methods: ["account/rateLimits/read"],
          payloads: [{}],
          timeoutMs: settings.requestTimeoutMs,
        });
        return extractRateLimitSummaries(result);
      },
    );
  }

  async readAccount(params: { sessionKey?: string }): Promise<AccountSummary> {
    return await withInitializedClient(
      { settings: this.settings, sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        const result = await requestWithFallbacks({
          client,
          methods: ["account/read"],
          payloads: [{ refreshToken: false }, { refresh_token: false }, {}],
          timeoutMs: settings.requestTimeoutMs,
        });
        return extractAccountSummary(result);
      },
    );
  }

  async readThreadState(params: { sessionKey?: string; threadId: string }): Promise<ThreadState> {
    return await withInitializedClient(
      { settings: this.settings, sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        try {
          const result = await requestWithFallbacks({
            client,
            methods: ["thread/resume"],
            payloads: buildThreadResumePayloads({ threadId: params.threadId }),
            timeoutMs: settings.requestTimeoutMs,
          });
          return extractThreadState(result);
        } finally {
          await requestWithFallbacks({
            client,
            methods: ["thread/unsubscribe"],
            payloads: [{ threadId: params.threadId }, { thread_id: params.threadId }],
            timeoutMs: settings.requestTimeoutMs,
          }).catch(() => undefined);
        }
      },
    );
  }

  async setThreadName(params: {
    sessionKey?: string;
    threadId: string;
    name: string;
  }): Promise<void> {
    await withInitializedClient(
      { settings: this.settings, sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        await requestWithFallbacks({
          client,
          methods: ["thread/name/set"],
          payloads: [
            { threadId: params.threadId, name: params.name },
            { thread_id: params.threadId, name: params.name },
          ],
          timeoutMs: settings.requestTimeoutMs,
        });
      },
    );
  }

  async setThreadModel(params: {
    sessionKey?: string;
    threadId: string;
    model: string;
    workspaceDir?: string;
  }): Promise<ThreadState> {
    return await withInitializedClient(
      { settings: this.settings, sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        try {
          const result = await requestWithFallbacks({
            client,
            methods: ["thread/resume"],
            payloads: buildThreadResumePayloads({
              threadId: params.threadId,
              model: params.model,
              cwd: params.workspaceDir,
            }),
            timeoutMs: settings.requestTimeoutMs,
          });
          return extractThreadState(result);
        } finally {
          await requestWithFallbacks({
            client,
            methods: ["thread/unsubscribe"],
            payloads: [{ threadId: params.threadId }, { thread_id: params.threadId }],
            timeoutMs: settings.requestTimeoutMs,
          }).catch(() => undefined);
        }
      },
    );
  }

  async setThreadServiceTier(params: {
    sessionKey?: string;
    threadId: string;
    serviceTier: string | null;
  }): Promise<ThreadState> {
    return await withInitializedClient(
      { settings: this.settings, sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        try {
          const result = await requestWithFallbacks({
            client,
            methods: ["thread/resume"],
            payloads: buildThreadResumePayloads({
              threadId: params.threadId,
              serviceTier: params.serviceTier,
            }),
            timeoutMs: settings.requestTimeoutMs,
          });
          return extractThreadState(result);
        } finally {
          await requestWithFallbacks({
            client,
            methods: ["thread/unsubscribe"],
            payloads: [{ threadId: params.threadId }, { thread_id: params.threadId }],
            timeoutMs: settings.requestTimeoutMs,
          }).catch(() => undefined);
        }
      },
    );
  }

  async compactThread(params: {
    sessionKey?: string;
    threadId: string;
    onProgress?: (progress: CompactProgress) => Promise<void> | void;
  }): Promise<CompactResult> {
    const client = createJsonRpcClient(this.settings);
    let latestUsage: ContextUsageSnapshot | undefined;
    let compactionItemId = "";
    let compactionCompleted = false;
    let settleTimer: NodeJS.Timeout | undefined;
    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: Error) => void) | undefined;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const settleSoon = () => {
      if (!resolveCompletion) {
        return;
      }
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      settleTimer = setTimeout(() => {
        const resolve = resolveCompletion;
        resolveCompletion = undefined;
        rejectCompletion = undefined;
        resolve?.();
      }, TRAILING_NOTIFICATION_SETTLE_MS);
    };

    const fail = (message: string) => {
      const reject = rejectCompletion;
      resolveCompletion = undefined;
      rejectCompletion = undefined;
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      reject?.(new Error(message));
    };

    client.setNotificationHandler(async (method, notificationParams) => {
      const methodLower = method.trim().toLowerCase();
      const ids = extractIds(notificationParams);
      if (ids.threadId && ids.threadId !== params.threadId) {
        return;
      }
      const usage = extractThreadTokenUsageSnapshot(notificationParams);
      if (usage) {
        latestUsage = usage;
        await params.onProgress?.({ phase: "usage", usage });
        if (compactionCompleted) {
          settleSoon();
        }
      }
      const progress = extractContextCompactionProgress(methodLower, notificationParams);
      if (progress) {
        if (progress.itemId) {
          compactionItemId = progress.itemId;
        }
        if (progress.phase === "completed") {
          compactionCompleted = true;
          await params.onProgress?.({
            phase: "completed",
            itemId: compactionItemId || progress.itemId,
            usage: latestUsage,
          });
          settleSoon();
          return;
        }
        await params.onProgress?.({
          phase: "started",
          itemId: compactionItemId || progress.itemId,
          usage: latestUsage,
        });
      }
      if (methodLower === "turn/failed") {
        const turn = asRecord(asRecord(notificationParams)?.turn);
        const message =
          pickString(asRecord(turn?.error) ?? {}, ["message"]) ?? "Codex thread compaction failed.";
        fail(message);
      }
    });

    try {
      await client.connect();
      await initializeClient({ client, settings: this.settings, sessionKey: params.sessionKey });
      await requestWithFallbacks({
        client,
        methods: ["thread/resume"],
        payloads: buildThreadResumePayloads({ threadId: params.threadId }),
        timeoutMs: this.settings.requestTimeoutMs,
      });
      await requestWithFallbacks({
        client,
        methods: ["thread/compact/start"],
        payloads: [{ threadId: params.threadId }, { thread_id: params.threadId }],
        timeoutMs: this.settings.requestTimeoutMs,
      });
      await completion;
      return { itemId: compactionItemId || undefined, usage: latestUsage };
    } finally {
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
      await requestWithFallbacks({
        client,
        methods: ["thread/unsubscribe"],
        payloads: [{ threadId: params.threadId }, { thread_id: params.threadId }],
        timeoutMs: this.settings.requestTimeoutMs,
      }).catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }

  async readThreadContext(params: {
    sessionKey?: string;
    threadId: string;
  }): Promise<ThreadReplay> {
    return await withInitializedClient(
      { settings: this.settings, sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        const result = await requestWithFallbacks({
          client,
          methods: ["thread/read"],
          payloads: [
            { threadId: params.threadId, includeTurns: true },
            { thread_id: params.threadId, include_turns: true },
          ],
          timeoutMs: settings.requestTimeoutMs,
        });
        return extractThreadReplayFromReadResult(result);
      },
    );
  }

  startReview(params: {
    sessionKey?: string;
    workspaceDir: string;
    threadId: string;
    runId: string;
    target: ReviewTarget;
    onPendingInput?: (state: PendingInputState | null) => Promise<void> | void;
    onInterrupted?: () => Promise<void> | void;
  }): ActiveCodexRun {
    const client = createJsonRpcClient(this.settings);
    let reviewThreadId = params.threadId.trim();
    let turnId = "";
    let reviewText = "";
    let assistantText = "";
    let awaitingInput = false;
    let interrupted = false;
    let completed = false;
    let notificationQueue = Promise.resolve();
    let pendingInput:
      | {
          state: PendingInputState;
          options: string[];
          actions: PendingInputAction[];
          methodLower: string;
          resolve: (value: unknown) => void;
        }
      | null = null;
    let completeTurn: (() => void) | null = null;
    const completion = new Promise<void>((resolve) => {
      completeTurn = () => {
        if (completed) {
          return;
        }
        completed = true;
        resolve();
      };
    });

    const handleResult = (async () => {
      try {
        await client.connect();
        await initializeClient({ client, settings: this.settings, sessionKey: params.sessionKey });
        await requestWithFallbacks({
          client,
          methods: ["thread/resume"],
          payloads: [{ threadId: reviewThreadId }, { thread_id: reviewThreadId }],
          timeoutMs: this.settings.requestTimeoutMs,
        }).catch(() => undefined);
        const result = await requestWithFallbacks({
          client,
          methods: ["review/start"],
          payloads: [
            { threadId: reviewThreadId, target: params.target, delivery: "inline" },
            { thread_id: reviewThreadId, target: params.target, delivery: "inline" },
          ],
          timeoutMs: this.settings.requestTimeoutMs,
        });
        const resultRecord = asRecord(result);
        reviewThreadId =
          pickString(resultRecord ?? {}, ["reviewThreadId", "review_thread_id"]) ?? reviewThreadId;
        turnId ||= extractIds(result)?.runId ?? "";
        await completion;
        if (completed && !interrupted) {
          await new Promise<void>((resolve) => setTimeout(resolve, TRAILING_NOTIFICATION_SETTLE_MS));
          await notificationQueue;
        }
        const resolvedReviewText = reviewText || assistantText;
        return {
          reviewText: resolvedReviewText.trim(),
          reviewThreadId: reviewThreadId || undefined,
          turnId: turnId || undefined,
          aborted: interrupted,
        } satisfies ReviewResult;
      } finally {
        if (reviewThreadId) {
          await requestWithFallbacks({
            client,
            methods: ["thread/unsubscribe"],
            payloads: [{ threadId: reviewThreadId }, { thread_id: reviewThreadId }],
            timeoutMs: this.settings.requestTimeoutMs,
          }).catch(() => undefined);
        }
        await client.close().catch(() => undefined);
      }
    })();

    client.setNotificationHandler((method, notificationParams) => {
      const next = notificationQueue.then(async () => {
        const ids = extractIds(notificationParams);
        reviewThreadId ||= ids.threadId ?? "";
        turnId ||= ids.runId ?? "";
        const methodLower = method.trim().toLowerCase();
        if (methodLower === "serverrequest/resolved") {
          pendingInput = null;
          awaitingInput = false;
          await params.onPendingInput?.(null);
          return;
        }
        const maybeReviewText = extractReviewTextFromNotification(method, notificationParams);
        if (maybeReviewText?.trim()) {
          reviewText = maybeReviewText.trim();
        }
        const assistantNotification = extractAssistantNotificationText(methodLower, notificationParams);
        if (assistantNotification.mode === "snapshot" && assistantNotification.text.trim()) {
          assistantText = assistantNotification.text.trim();
        }
        if (
          methodLower === "turn/completed" ||
          methodLower === "turn/failed" ||
          methodLower === "turn/cancelled"
        ) {
          completeTurn?.();
        }
      });
      notificationQueue = next.catch((error: unknown) => {
        this.logger.debug(`codex review notification handling failed: ${String(error)}`);
      });
      return next;
    });

    client.setRequestHandler(async (method, requestParams) => {
      const methodLower = method.trim().toLowerCase();
      if (!isInteractiveServerRequest(method)) {
        return {};
      }
      const ids = extractIds(requestParams);
      reviewThreadId ||= ids.threadId ?? "";
      turnId ||= ids.runId ?? "";
      const options = extractOptionValues(requestParams);
      const requestId = ids.requestId ?? `${params.runId}-${Date.now().toString(36)}`;
      const expiresAt = Date.now() + this.settings.inputTimeoutMs;
      const state = createPendingInputState({
        method,
        requestId,
        requestParams,
        options,
        expiresAt,
      });
      awaitingInput = true;
      await params.onPendingInput?.(state);
      let timedOut = false;
      const response = await new Promise<unknown>((resolve) => {
        pendingInput = {
          state,
          options,
          actions: state.actions ?? [],
          methodLower,
          resolve,
        };
        setTimeout(() => {
          if (!pendingInput || pendingInput.state.requestId !== requestId) {
            return;
          }
          timedOut = true;
          pendingInput = null;
          resolve({ text: "" });
        }, this.settings.inputTimeoutMs);
      });
      awaitingInput = false;
      pendingInput = null;
      await params.onPendingInput?.(null);
      const mappedResponse = mapPendingInputResponse({
        methodLower,
        requestParams,
        response,
        options,
        actions: state.actions ?? [],
        timedOut,
      });
      const responseRecord = asRecord(response);
      const steerText =
        methodLower.includes("requestapproval") && typeof responseRecord?.steerText === "string"
          ? responseRecord.steerText.trim()
          : "";
      if (steerText && reviewThreadId) {
        await requestWithFallbacks({
          client,
          methods: [...TURN_STEER_METHODS],
          payloads: [
            { threadId: reviewThreadId, turnId: turnId || undefined, text: steerText },
            { thread_id: reviewThreadId, turn_id: turnId || undefined, text: steerText },
          ],
          timeoutMs: this.settings.requestTimeoutMs,
        });
      }
      return mappedResponse;
    });

    return {
      result: handleResult,
      queueMessage: async (text) => {
        const trimmed = text.trim();
        if (!trimmed || !pendingInput) {
          return false;
        }
        const actionSelectionCount =
          pendingInput.actions.filter((action) => action.kind !== "steer").length ||
          pendingInput.options.length;
        const parsed = parseCodexUserInput(trimmed, actionSelectionCount);
        if (parsed.kind === "option") {
          pendingInput.resolve({
            index: parsed.index,
            option: pendingInput.options[parsed.index] ?? "",
          });
        } else if (pendingInput.methodLower.includes("requestapproval")) {
          pendingInput.resolve({ steerText: parsed.text });
        } else {
          pendingInput.resolve({ text: parsed.text });
        }
        return true;
      },
      submitPendingInput: async (actionIndex) => {
        if (!pendingInput) {
          return false;
        }
        const action = pendingInput.actions[actionIndex];
        if (!action || action.kind === "steer") {
          return false;
        }
        pendingInput.resolve({
          index: actionIndex,
          option: pendingInput.options[actionIndex] ?? "",
        });
        return true;
      },
      interrupt: async () => {
        interrupted = true;
        await params.onInterrupted?.();
        if (reviewThreadId) {
          await requestWithFallbacks({
            client,
            methods: [...TURN_INTERRUPT_METHODS],
            payloads: [
              { threadId: reviewThreadId, turnId: turnId || undefined },
              { thread_id: reviewThreadId, turn_id: turnId || undefined },
            ],
            timeoutMs: this.settings.requestTimeoutMs,
          }).catch(() => undefined);
        }
        completeTurn?.();
      },
      isAwaitingInput: () => awaitingInput,
      getThreadId: () => reviewThreadId || undefined,
    };
  }

  startTurn(params: {
    sessionKey?: string;
    prompt: string;
    workspaceDir: string;
    runId: string;
    existingThreadId?: string;
    model?: string;
    onPendingInput?: (state: PendingInputState | null) => Promise<void> | void;
    onInterrupted?: () => Promise<void> | void;
  }): ActiveCodexRun {
    const client = createJsonRpcClient(this.settings);
    let threadId = params.existingThreadId?.trim() || "";
    let turnId = "";
    let assistantText = "";
    let assistantItemId = "";
    let planExplanation = "";
    let planSteps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }> = [];
    const planDraftByItemId = new Map<string, string>();
    let finalPlanMarkdown = "";
    let awaitingInput = false;
    let interrupted = false;
    let completed = false;
    let latestContextUsage: ContextUsageSnapshot | undefined;
    let notificationQueue = Promise.resolve();
    let pendingInput:
      | {
          state: PendingInputState;
          options: string[];
          actions: PendingInputAction[];
          methodLower: string;
          resolve: (value: unknown) => void;
        }
      | null = null;
    let completeTurn: (() => void) | null = null;
    const completion = new Promise<void>((resolve) => {
      completeTurn = () => {
        if (completed) {
          return;
        }
        completed = true;
        resolve();
      };
    });

    client.setNotificationHandler((method, notificationParams) => {
      const next = notificationQueue.then(async () => {
        const methodLower = method.trim().toLowerCase();
        const ids = extractIds(notificationParams);
        threadId ||= ids.threadId ?? "";
        turnId ||= ids.runId ?? "";
        const tokenUsage = extractThreadTokenUsageSnapshot(notificationParams);
        if (tokenUsage) {
          latestContextUsage = tokenUsage;
        }
        if (methodLower === "serverrequest/resolved") {
          pendingInput = null;
          awaitingInput = false;
          await params.onPendingInput?.(null);
          return;
        }
        if (methodLower === "turn/plan/updated") {
          const planUpdate = extractTurnPlanUpdate(notificationParams);
          planExplanation = planUpdate.explanation?.trim() ?? planExplanation;
          if (planUpdate.steps.length > 0) {
            planSteps = planUpdate.steps;
          }
        }
        if (methodLower === "item/plan/delta") {
          const planDelta = extractPlanDeltaNotification(notificationParams);
          if (planDelta.itemId && planDelta.delta) {
            const existing = planDraftByItemId.get(planDelta.itemId) ?? "";
            planDraftByItemId.set(planDelta.itemId, `${existing}${planDelta.delta}`);
          }
          return;
        }
        if (methodLower === "item/completed") {
          const completedPlan = extractCompletedPlanText(notificationParams);
          if (completedPlan.text?.trim()) {
            finalPlanMarkdown = completedPlan.text.trim();
            if (completedPlan.itemId) {
              planDraftByItemId.set(completedPlan.itemId, finalPlanMarkdown);
            }
            return;
          }
        }
        const assistantNotification = extractAssistantNotificationText(methodLower, notificationParams);
        if (
          assistantNotification.itemId &&
          assistantItemId &&
          assistantNotification.itemId !== assistantItemId
        ) {
          assistantText = "";
        }
        if (assistantNotification.itemId) {
          assistantItemId = assistantNotification.itemId;
        }
        if (assistantNotification.mode === "delta" && assistantNotification.text) {
          assistantText =
            assistantText && assistantNotification.text.startsWith(assistantText)
              ? assistantNotification.text
              : `${assistantText}${assistantNotification.text}`;
        } else if (assistantNotification.mode === "snapshot" && assistantNotification.text) {
          const snapshotText = assistantNotification.text.trim();
          if (snapshotText) {
            assistantText = snapshotText;
          }
        }
        if (
          methodLower === "turn/completed" ||
          methodLower === "turn/failed" ||
          methodLower === "turn/cancelled"
        ) {
          completeTurn?.();
        }
      });
      notificationQueue = next.catch((error: unknown) => {
        this.logger.debug(`codex turn notification handling failed: ${String(error)}`);
      });
      return next;
    });

    client.setRequestHandler(async (method, requestParams) => {
      const methodLower = method.trim().toLowerCase();
      if (!isInteractiveServerRequest(method)) {
        return {};
      }
      const ids = extractIds(requestParams);
      threadId ||= ids.threadId ?? "";
      turnId ||= ids.runId ?? "";
      const options = extractOptionValues(requestParams);
      const requestId = ids.requestId ?? `${params.runId}-${Date.now().toString(36)}`;
      const expiresAt = Date.now() + this.settings.inputTimeoutMs;
      const state = createPendingInputState({
        method,
        requestId,
        requestParams,
        options,
        expiresAt,
      });
      awaitingInput = true;
      assistantText = "";
      assistantItemId = "";
      await params.onPendingInput?.(state);
      let timedOut = false;
      const response = await new Promise<unknown>((resolve) => {
        pendingInput = {
          state,
          options,
          actions: state.actions ?? [],
          methodLower,
          resolve,
        };
        setTimeout(() => {
          if (!pendingInput || pendingInput.state.requestId !== requestId) {
            return;
          }
          timedOut = true;
          pendingInput = null;
          resolve({ text: "" });
        }, this.settings.inputTimeoutMs);
      });
      awaitingInput = false;
      pendingInput = null;
      await params.onPendingInput?.(null);
      const mappedResponse = mapPendingInputResponse({
        methodLower,
        requestParams,
        response,
        options,
        actions: state.actions ?? [],
        timedOut,
      });
      const responseRecord = asRecord(response);
      const steerText =
        methodLower.includes("requestapproval") && typeof responseRecord?.steerText === "string"
          ? responseRecord.steerText.trim()
          : "";
      if (steerText && threadId) {
        await requestWithFallbacks({
          client,
          methods: [...TURN_STEER_METHODS],
          payloads: [
            { threadId, turnId: turnId || undefined, text: steerText },
            { thread_id: threadId, turn_id: turnId || undefined, text: steerText },
          ],
          timeoutMs: this.settings.requestTimeoutMs,
        });
      }
      return mappedResponse;
    });

    const handleResult = (async () => {
      try {
        await client.connect();
        await initializeClient({ client, settings: this.settings, sessionKey: params.sessionKey });
        if (!threadId) {
          const created = await requestWithFallbacks({
            client,
            methods: ["thread/new", "thread/start"],
            payloads: [
              { cwd: params.workspaceDir, model: params.model },
              { cwd: params.workspaceDir },
              {},
            ],
            timeoutMs: this.settings.requestTimeoutMs,
          });
          threadId = extractIds(created).threadId ?? "";
          if (!threadId) {
            throw new Error("Codex App Server did not return a thread id.");
          }
        } else {
          await requestWithFallbacks({
            client,
            methods: ["thread/resume"],
            payloads: [{ threadId }, { thread_id: threadId }],
            timeoutMs: this.settings.requestTimeoutMs,
          }).catch(() => undefined);
        }
        const started = await requestWithFallbacks({
          client,
          methods: ["turn/start"],
          payloads: buildTurnStartPayloads({
            threadId,
            prompt: params.prompt,
            model: params.model,
          }),
          timeoutMs: this.settings.requestTimeoutMs,
        });
        const startedIds = extractIds(started);
        threadId ||= startedIds.threadId ?? "";
        turnId ||= startedIds.runId ?? "";
        await completion;
        if (completed && !interrupted) {
          await new Promise<void>((resolve) => setTimeout(resolve, TRAILING_NOTIFICATION_SETTLE_MS));
          await notificationQueue;
        }
        return {
          threadId,
          text:
            finalPlanMarkdown || planDraftByItemId.size > 0 || planSteps.length > 0
              ? undefined
              : assistantText || undefined,
          planArtifact: finalPlanMarkdown
            ? {
                explanation: planExplanation || undefined,
                steps: planSteps,
                markdown: finalPlanMarkdown,
              }
            : undefined,
          aborted: interrupted,
          usage: latestContextUsage,
        } satisfies TurnResult;
      } finally {
        if (threadId) {
          await requestWithFallbacks({
            client,
            methods: ["thread/unsubscribe"],
            payloads: [{ threadId }, { thread_id: threadId }],
            timeoutMs: this.settings.requestTimeoutMs,
          }).catch(() => undefined);
        }
        await client.close().catch(() => undefined);
      }
    })();

    return {
      result: handleResult,
      queueMessage: async (text) => {
        const trimmed = text.trim();
        if (!trimmed) {
          return false;
        }
        if (pendingInput) {
          const actionSelectionCount =
            pendingInput.actions.filter((action) => action.kind !== "steer").length ||
            pendingInput.options.length;
          const parsed = parseCodexUserInput(trimmed, actionSelectionCount);
          if (parsed.kind === "option") {
            const action = pendingInput.actions[parsed.index];
            if (action?.kind === "steer") {
              pendingInput.resolve({ steerText: "" });
            } else {
              pendingInput.resolve({
                index: parsed.index,
                option: pendingInput.options[parsed.index] ?? "",
              });
            }
          } else if (pendingInput.methodLower.includes("requestapproval")) {
            pendingInput.resolve({ steerText: parsed.text });
          } else {
            pendingInput.resolve({ text: parsed.text });
          }
          return true;
        }
        if (!threadId) {
          return false;
        }
        await requestWithFallbacks({
          client,
          methods: [...TURN_STEER_METHODS],
          payloads: [
            { threadId, turnId: turnId || undefined, text: trimmed },
            { thread_id: threadId, turn_id: turnId || undefined, text: trimmed },
          ],
          timeoutMs: this.settings.requestTimeoutMs,
        });
        return true;
      },
      submitPendingInput: async (actionIndex) => {
        if (!pendingInput) {
          return false;
        }
        const action = pendingInput.actions[actionIndex];
        if (!action || action.kind === "steer") {
          return false;
        }
        pendingInput.resolve({
          index: actionIndex,
          option: pendingInput.options[actionIndex] ?? "",
        });
        return true;
      },
      interrupt: async () => {
        if (!threadId) {
          return;
        }
        interrupted = true;
        await params.onInterrupted?.();
        await requestWithFallbacks({
          client,
          methods: [...TURN_INTERRUPT_METHODS],
          payloads: [
            { threadId, turnId: turnId || undefined },
            { thread_id: threadId, turn_id: turnId || undefined },
          ],
          timeoutMs: this.settings.requestTimeoutMs,
        }).catch(() => undefined);
        completeTurn?.();
      },
      isAwaitingInput: () => awaitingInput,
      getThreadId: () => threadId || undefined,
    };
  }
}
