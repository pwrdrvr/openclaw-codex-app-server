import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import WebSocket from "ws";
import type { PluginLogger } from "openclaw/plugin-sdk";
import { createPendingInputState, parseCodexUserInput } from "./pending-input.js";
import {
  CALLBACK_TTL_MS,
  PENDING_INPUT_TTL_MS,
  type AccountSummary,
  type CollaborationMode,
  type CompactProgress,
  type CompactResult,
  type ContextUsageSnapshot,
  type ExperimentalFeatureSummary,
  type McpServerSummary,
  type ModelSummary,
  type PendingInputAction,
  type PendingInputState,
  type PluginSettings,
  type RateLimitSummary,
  type ReviewResult,
  type ReviewTarget,
  type SkillSummary,
  type ThreadReplay,
  type ThreadState,
  type ThreadSummary,
  type TurnTerminalError,
  type TurnResult,
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
type JsonRpcCloseHandler = () => void;

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
  submitPendingInputPayload: (payload: unknown) => Promise<boolean>;
  interrupt: () => Promise<void>;
  isAwaitingInput: () => boolean;
  getThreadId: () => string | undefined;
};

const DEFAULT_PROTOCOL_VERSION = "1.0";
const TRAILING_NOTIFICATION_SETTLE_MS = 250;
const TURN_STEER_METHODS = ["turn/steer"] as const;
const TURN_INTERRUPT_METHODS = ["turn/interrupt"] as const;
const execFileAsync = promisify(execFile);

type StartupProbeInfo = {
  transport: PluginSettings["transport"];
  command?: string;
  args?: string[];
  resolvedCommandPath?: string;
  cliVersion?: string;
  serverName?: string;
  serverVersion?: string;
};

type FileEditSummary = {
  path: string;
  verb: "Added" | "Deleted" | "Edited";
  added: number;
  removed: number;
};

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

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
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

function findFirstNestedNumber(value: unknown, keys: readonly string[], depth = 0): number | undefined {
  if (depth > 6) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findFirstNestedNumber(entry, keys, depth + 1);
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
    const parsed = parseFiniteNumber(record[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  for (const nested of Object.values(record)) {
    const match = findFirstNestedNumber(nested, keys, depth + 1);
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

function extractIds(value: unknown): {
  threadId?: string;
  runId?: string;
  requestId?: string;
  itemId?: string;
} {
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
    itemId:
      pickString(record, ["itemId", "item_id"]) ??
      pickString(asRecord(record.item) ?? {}, ["id", "itemId", "item_id"]),
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
    private readonly onClose?: JsonRpcCloseHandler,
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
      this.onClose?.();
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
    private readonly logger?: PluginLogger,
    private readonly onClose?: JsonRpcCloseHandler,
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
    this.logger?.debug(
      formatStdioProcessLog("spawned", {
        pid: child.pid,
        command: this.command,
        args: ["app-server", ...this.args],
      }),
    );
    const lineReader = readline.createInterface({ input: child.stdout });
    lineReader.on("line", (line) => {
      void this.handleLine(line);
    });
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => {
      this.logger?.warn(
        `codex app server process error pid=${child.pid ?? "<unknown>"} command=${this.command}: ${error.message}`,
      );
    });
    child.on("close", (code, signal) => {
      this.logger?.debug(
        formatStdioProcessLog("exited", {
          pid: child.pid,
          code,
          signal,
        }),
      );
      this.flushPending(new Error("codex app server stdio closed"));
      this.process = null;
      this.onClose?.();
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

function createJsonRpcClient(
  settings: PluginSettings,
  logger?: PluginLogger,
  onClose?: JsonRpcCloseHandler,
): JsonRpcClient {
  if (settings.transport === "websocket") {
    if (!settings.url) {
      throw new Error("Codex websocket transport requires a url.");
    }
    return new WsJsonRpcClient(settings.url, settings.headers, settings.requestTimeoutMs, onClose);
  }
  return new StdioJsonRpcClient(
    settings.command,
    settings.args,
    settings.requestTimeoutMs,
    logger,
    onClose,
  );
}

async function initializeClient(params: {
  client: JsonRpcClient;
}): Promise<unknown> {
  const initializeResult = await params.client.request("initialize", {
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    clientInfo: { name: "openclaw-codex-app-server", version: "0.0.0" },
    capabilities: { experimentalApi: true },
  });
  await params.client.notify("initialized", {});
  return initializeResult;
}

function extractStartupProbeInfo(
  initializeResult: unknown,
  base: StartupProbeInfo,
): StartupProbeInfo {
  const record = asRecord(initializeResult) ?? {};
  const serverInfo = asRecord(record.serverInfo) ?? asRecord(record.server_info) ?? record;
  return {
    ...base,
    serverName:
      pickString(serverInfo, ["name", "serverName", "server_name"]) ?? base.serverName,
    serverVersion:
      pickString(serverInfo, ["version", "serverVersion", "server_version"]) ?? base.serverVersion,
  };
}

async function resolveCommandPath(command: string): Promise<string | undefined> {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes(path.sep)) {
    return path.resolve(trimmed);
  }
  const locator = process.platform === "win32" ? "where" : "which";
  try {
    const { stdout } = await execFileAsync(locator, [trimmed], { timeout: 5_000 });
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return first || undefined;
  } catch {
    return undefined;
  }
}

async function probeStdioVersion(settings: PluginSettings): Promise<{
  resolvedCommandPath?: string;
  cliVersion?: string;
}> {
  const resolvedCommandPath = await resolveCommandPath(settings.command);
  const commandPath = resolvedCommandPath ?? settings.command;
  try {
    const { stdout, stderr } = await execFileAsync(
      commandPath,
      [...settings.args, "--version"],
      { timeout: Math.min(settings.requestTimeoutMs, 10_000) },
    );
    const combined = `${stdout}\n${stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return {
      resolvedCommandPath,
      cliVersion: combined || undefined,
    };
  } catch {
    return { resolvedCommandPath };
  }
}

function formatStartupProbeLog(info: StartupProbeInfo): string {
  return [
    `transport=${info.transport}`,
    info.command ? `command=${info.command}` : undefined,
    info.args ? `args=${JSON.stringify(info.args)}` : undefined,
    info.resolvedCommandPath ? `resolved=${info.resolvedCommandPath}` : undefined,
    info.cliVersion ? `cliVersion=${info.cliVersion}` : undefined,
    info.serverName ? `serverName=${info.serverName}` : undefined,
    info.serverVersion ? `serverVersion=${info.serverVersion}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

function formatStdioProcessLog(
  event: "spawned" | "exited",
  params: {
    pid?: number;
    command?: string;
    args?: string[];
    code?: number | null;
    signal?: NodeJS.Signals | null;
  },
): string {
  return [
    `codex app server process ${event}`,
    `pid=${params.pid ?? "<unknown>"}`,
    params.command ? `command=${params.command}` : undefined,
    params.args ? `args=${JSON.stringify(params.args)}` : undefined,
    event === "exited" ? `code=${params.code ?? "<none>"}` : undefined,
    event === "exited" ? `signal=${params.signal ?? "<none>"}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

async function requestWithFallbacks(params: {
  client: JsonRpcClient;
  methods: string[];
  payloads: unknown[];
  timeoutMs: number;
}): Promise<unknown> {
  if (params.payloads.length === 0) {
    throw new Error(
      `codex app server request skipped: no payloads for ${params.methods.join(", ") || "<none>"}`,
    );
  }
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
  return [base];
}

function buildTurnInput(prompt: string): Array<Record<string, unknown>> {
  return [{ type: "text", text: prompt }];
}

function buildCollaborationModePayloads(
  collaborationMode: CollaborationMode,
  fallbackModel?: string,
): Array<{ camel: Record<string, unknown>; snake: Record<string, unknown> }> {
  const normalizedModel = collaborationMode.settings?.model?.trim() || fallbackModel?.trim() || "";
  if (!normalizedModel) {
    return [];
  }
  const hasDeveloperInstructions = Object.hasOwn(
    collaborationMode.settings ?? {},
    "developerInstructions",
  );
  const camelSettings: Record<string, unknown> = {
    model: normalizedModel,
    ...(collaborationMode.settings?.reasoningEffort
      ? { reasoningEffort: collaborationMode.settings.reasoningEffort }
      : {}),
    ...(typeof collaborationMode.settings?.developerInstructions === "string"
      ? collaborationMode.settings.developerInstructions.trim()
        ? { developerInstructions: collaborationMode.settings.developerInstructions.trim() }
        : {}
      : {}),
    ...(hasDeveloperInstructions &&
    (collaborationMode.settings?.developerInstructions == null ||
      collaborationMode.settings?.developerInstructions === "")
      ? { developerInstructions: null }
      : {}),
  };
  const snakeSettings: Record<string, unknown> = {
    model: normalizedModel,
    ...(typeof camelSettings.reasoningEffort === "string"
      ? { reasoning_effort: camelSettings.reasoningEffort }
      : {}),
    ...(typeof camelSettings.developerInstructions === "string" ||
    camelSettings.developerInstructions == null
      ? { developer_instructions: camelSettings.developerInstructions }
      : {}),
  };
  return [
    {
      camel: {
        mode: collaborationMode.mode,
        settings: camelSettings,
      },
      snake: {
        mode: collaborationMode.mode,
        settings: snakeSettings,
      },
    },
  ];
}

function buildTurnStartPayloads(params: {
  threadId: string;
  prompt: string;
  model?: string;
  collaborationMode?: CollaborationMode;
  collaborationFallbackModel?: string;
}): unknown[] {
  const base: Record<string, unknown> = {
    threadId: params.threadId,
    input: buildTurnInput(params.prompt),
  };
  if (params.model?.trim()) {
    base.model = params.model.trim();
  }
  if (!params.collaborationMode) {
    return [base];
  }
  const collaborationPayloads = buildCollaborationModePayloads(
    params.collaborationMode,
    params.collaborationFallbackModel ?? params.model,
  ).flatMap((variant) => [
    {
      ...base,
      collaborationMode: variant.camel,
    },
    {
      ...base,
      collaboration_mode: variant.snake,
    },
  ]);
  return [...collaborationPayloads, base];
}

function buildDefaultCollaborationMode(settings: {
  model?: string;
  reasoningEffort?: string;
}): CollaborationMode | undefined {
  const model = settings.model?.trim();
  if (!model) {
    return undefined;
  }
  return {
    mode: "default",
    settings: {
      model,
      ...(settings.reasoningEffort?.trim()
        ? { reasoningEffort: settings.reasoningEffort.trim() }
        : {}),
      developerInstructions: null,
    },
  };
}

function payloadHasCollaborationMode(payload: unknown): boolean {
  const record = asRecord(payload);
  return Boolean(
    record &&
      (Object.hasOwn(record, "collaborationMode") || Object.hasOwn(record, "collaboration_mode")),
  );
}

function buildTurnSteerPayloads(params: {
  threadId: string;
  turnId: string;
  text: string;
}): Array<Record<string, unknown>> {
  const trimmed = params.text.trim();
  if (!trimmed) {
    return [];
  }
  return [
    {
      threadId: params.threadId,
      expectedTurnId: params.turnId,
      input: buildTurnInput(trimmed),
    },
  ];
}

function buildTurnInterruptPayloads(params: {
  threadId: string;
  turnId: string;
}): Array<Record<string, unknown>> {
  return [{ threadId: params.threadId, turnId: params.turnId }];
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

function normalizeApprovalFilePath(rawPath: string, workspaceDir?: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return "";
  }
  if (!path.isAbsolute(trimmed)) {
    return trimmed.replace(/\\/g, "/");
  }
  const root = workspaceDir?.trim();
  if (root && path.isAbsolute(root)) {
    const relative = path.relative(root, trimmed);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative.replace(/\\/g, "/");
    }
  }
  return trimmed;
}

function countTextLines(text: string): number {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized) {
    return 0;
  }
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

function calculateAddRemoveFromDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function extractFileEditSummariesFromNotification(
  value: unknown,
  workspaceDir?: string,
): FileEditSummary[] {
  const item = asRecord(asRecord(value)?.item);
  if (!item) {
    return [];
  }
  const itemType = pickString(item, ["type"])?.trim().toLowerCase();
  if (itemType !== "filechange") {
    return [];
  }
  const rawChanges = Array.isArray(item.changes) ? item.changes : [];
  return rawChanges
    .map((entry) => {
      const change = asRecord(entry);
      if (!change) {
        return null;
      }
      const rawPath = pickString(change, ["path"]);
      if (!rawPath) {
        return null;
      }
      const diff = pickString(change, ["diff"], { trim: false }) ?? "";
      const kind = pickString(change, ["kind"])?.trim().toLowerCase();
      const stats =
        kind === "add"
          ? { added: countTextLines(diff), removed: 0 }
          : kind === "delete"
            ? { added: 0, removed: countTextLines(diff) }
            : calculateAddRemoveFromDiff(diff);
      return {
        path: normalizeApprovalFilePath(rawPath, workspaceDir),
        verb:
          kind === "add" ? "Added" : kind === "delete" ? "Deleted" : "Edited",
        added: stats.added,
        removed: stats.removed,
      } satisfies FileEditSummary;
    })
    .filter((entry): entry is FileEditSummary => Boolean(entry?.path));
}

function mergeFileEditSummary(
  current: FileEditSummary | undefined,
  incoming: FileEditSummary,
): FileEditSummary {
  if (!current) {
    return incoming;
  }
  return {
    path: incoming.path,
    verb:
      current.verb === incoming.verb && current.verb !== "Edited" ? current.verb : "Edited",
    added: current.added + incoming.added,
    removed: current.removed + incoming.removed,
  };
}

function formatFileEditNotice(summaries: FileEditSummary[]): string {
  if (summaries.length === 0) {
    return "";
  }
  const ordered = [...summaries].sort((left, right) => left.path.localeCompare(right.path));
  if (ordered.length === 1) {
    const [entry] = ordered;
    return `${entry.verb} \`${entry.path}\` (+${entry.added} -${entry.removed})`;
  }
  const totalAdded = ordered.reduce((sum, entry) => sum + entry.added, 0);
  const totalRemoved = ordered.reduce((sum, entry) => sum + entry.removed, 0);
  const noun = ordered.length === 1 ? "file" : "files";
  const lines = [
    `Edited ${ordered.length} ${noun} (+${totalAdded} -${totalRemoved})`,
    ...ordered.map(
      (entry) => `- ${entry.verb} \`${entry.path}\` (+${entry.added} -${entry.removed})`,
    ),
  ];
  return lines.join("\n");
}

function createFileEditNoticeBatcher(params: {
  onFlush?: (text: string) => Promise<void> | void;
}) {
  const summaries = new Map<string, FileEditSummary>();

  return {
    add(entries: FileEditSummary[]) {
      for (const entry of entries) {
        summaries.set(entry.path, mergeFileEditSummary(summaries.get(entry.path), entry));
      }
    },
    hasPending() {
      return summaries.size > 0;
    },
    async flush() {
      if (summaries.size === 0) {
        return;
      }
      const text = formatFileEditNotice([...summaries.values()]);
      summaries.clear();
      if (text) {
        await params.onFlush?.(text);
      }
    },
  };
}

function extractFileChangePathsFromReadResult(
  value: unknown,
  itemId: string,
  workspaceDir?: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const targetId = itemId.trim();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry));
      return;
    }
    const record = asRecord(node);
    if (!record) {
      return;
    }
    const item = asRecord(record.item) ?? record;
    const type = pickString(item, ["type"])?.trim().toLowerCase();
    const id = pickString(item, ["id", "itemId", "item_id"])?.trim();
    if (type === "filechange" && id === targetId) {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      for (const changeValue of changes) {
        const change = asRecord(changeValue);
        const rawPath = pickString(change ?? {}, ["path"]);
        if (!rawPath) {
          continue;
        }
        const formatted = normalizeApprovalFilePath(rawPath, workspaceDir);
        if (!formatted || seen.has(formatted)) {
          continue;
        }
        seen.add(formatted);
        out.push(formatted);
      }
      return;
    }
    for (const key of ["turns", "items", "data", "results", "thread", "response", "result"]) {
      visit(record[key]);
    }
  };
  visit(value);
  return out;
}

async function readFileChangePathsWithClient(params: {
  client: JsonRpcClient;
  settings: PluginSettings;
  threadId: string;
  itemId: string;
  workspaceDir?: string;
}): Promise<string[]> {
  const result = await requestWithFallbacks({
    client: params.client,
    methods: ["thread/read"],
    payloads: [{ threadId: params.threadId, includeTurns: true }],
    timeoutMs: params.settings.requestTimeoutMs,
  });
  return extractFileChangePathsFromReadResult(result, params.itemId, params.workspaceDir);
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

function formatRateLimitWindowName(params: {
  limitId?: string;
  limitName?: string;
  windowKey: "primary" | "secondary";
  windowMinutes?: number;
}): string {
  const rawId = params.limitId?.trim();
  const rawName = params.limitName?.trim();
  const minutes = params.windowMinutes;
  let windowLabel: string;
  if (minutes === 300) {
    windowLabel = "5h limit";
  } else if (minutes === 10080) {
    windowLabel = "Weekly limit";
  } else if (minutes === 43200) {
    windowLabel = "Monthly limit";
  } else if (typeof minutes === "number" && minutes > 0) {
    if (minutes % 1440 === 0) {
      windowLabel = `${Math.round(minutes / 1440)}d limit`;
    } else if (minutes % 60 === 0) {
      windowLabel = `${Math.round(minutes / 60)}h limit`;
    } else {
      windowLabel = `${minutes}m limit`;
    }
  } else {
    windowLabel = params.windowKey === "primary" ? "Primary limit" : "Secondary limit";
  }
  if (!rawId || rawId.toLowerCase() === "codex") {
    return windowLabel;
  }
  return `${rawName ?? rawId} ${windowLabel}`.trim();
}

function extractRateLimitSummaries(value: unknown): RateLimitSummary[] {
  const out = new Map<string, RateLimitSummary>();
  const addWindow = (
    windowValue: unknown,
    params: { limitId?: string; limitName?: string; windowKey: "primary" | "secondary" },
  ) => {
    const window = asRecord(windowValue);
    if (!window) {
      return;
    }
    const usedPercent = pickFiniteNumber(window, ["usedPercent", "used_percent"]);
    const windowMinutes = pickFiniteNumber(window, [
      "windowDurationMins",
      "window_duration_mins",
      "windowMinutes",
      "window_minutes",
    ]);
    const name = formatRateLimitWindowName({
      limitId: params.limitId,
      limitName: params.limitName,
      windowKey: params.windowKey,
      windowMinutes,
    });
    out.set(name, {
      name,
      limitId: params.limitId,
      usedPercent,
      remaining:
        typeof usedPercent === "number" ? Math.max(0, Math.round(100 - usedPercent)) : undefined,
      resetAt: normalizeEpochMilliseconds(
        pickNumber(window, ["resetsAt", "resets_at", "resetAt", "reset_at"]),
      ),
      windowSeconds: typeof windowMinutes === "number" ? Math.round(windowMinutes * 60) : undefined,
      windowMinutes,
    });
  };
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry));
      return;
    }
    const record = asRecord(node);
    if (!record) {
      return;
    }
    if ("primary" in record || "secondary" in record) {
      const limitId = pickString(record, ["limitId", "limit_id", "id"]);
      const limitName = pickString(record, ["limitName", "limit_name", "name", "label"]);
      addWindow(record.primary, { limitId, limitName, windowKey: "primary" });
      addWindow(record.secondary, { limitId, limitName, windowKey: "secondary" });
    }
    if (record.rateLimitsByLimitId && typeof record.rateLimitsByLimitId === "object") {
      for (const [limitId, snapshot] of Object.entries(record.rateLimitsByLimitId)) {
        const snapshotRecord = asRecord(snapshot);
        if (!snapshotRecord) {
          continue;
        }
        const limitName = pickString(snapshotRecord, ["limitName", "limit_name", "name", "label"]);
        addWindow(snapshotRecord.primary, { limitId, limitName, windowKey: "primary" });
        addWindow(snapshotRecord.secondary, { limitId, limitName, windowKey: "secondary" });
      }
    }
    const remaining = pickFiniteNumber(record, [
      "remaining",
      "remainingCount",
      "remaining_count",
      "available",
    ]);
    const limit = pickFiniteNumber(record, ["limit", "max", "quota", "capacity"]);
    const used = pickFiniteNumber(record, ["used", "consumed", "count"]);
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
      const existing = out.get(name);
      out.set(name, {
        name,
        limitId: existing?.limitId,
        remaining: remaining ?? existing?.remaining,
        limit: limit ?? existing?.limit,
        used: used ?? existing?.used,
        usedPercent: existing?.usedPercent,
        resetAt: normalizeEpochMilliseconds(resetAt) ?? existing?.resetAt,
        windowSeconds: windowSeconds ?? existing?.windowSeconds,
        windowMinutes: existing?.windowMinutes,
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
      "rateLimitsByLimitId",
      "rate_limits_by_limit_id",
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

function normalizeTurnTerminalStatus(
  value: string | undefined,
): TurnResult["terminalStatus"] | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "completed":
      return "completed";
    case "interrupted":
    case "cancelled":
    case "canceled":
      return "interrupted";
    case "failed":
    case "error":
      return "failed";
    default:
      return undefined;
  }
}

function summarizeCodexErrorInfo(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const [key, nested] of Object.entries(record)) {
    const nestedRecord = asRecord(nested);
    const httpStatusCode = nestedRecord
      ? pickFiniteNumber(nestedRecord, ["httpStatusCode", "http_status_code"])
      : undefined;
    if (httpStatusCode !== undefined) {
      return `${key}:${httpStatusCode}`;
    }
    const nestedSummary = summarizeCodexErrorInfo(nested);
    if (nestedSummary) {
      return `${key}:${nestedSummary}`;
    }
    return key;
  }
  return undefined;
}

function extractTurnTerminalState(
  method: string,
  params: unknown,
): { status?: TurnResult["terminalStatus"]; error?: TurnTerminalError } | undefined {
  const methodLower = method.trim().toLowerCase();
  if (
    methodLower !== "turn/completed" &&
    methodLower !== "turn/failed" &&
    methodLower !== "turn/cancelled"
  ) {
    return undefined;
  }
  const record = asRecord(params) ?? {};
  const turn = asRecord(record.turn) ?? record;
  const errorRecord = asRecord(turn.error) ?? asRecord(record.error) ?? null;
  const status =
    normalizeTurnTerminalStatus(
      pickString(turn, ["status"]) ??
        (methodLower === "turn/failed"
          ? "failed"
          : methodLower === "turn/cancelled"
            ? "interrupted"
            : "completed"),
    ) ??
    (methodLower === "turn/failed"
      ? "failed"
      : methodLower === "turn/cancelled"
        ? "interrupted"
        : undefined);
  if (!errorRecord) {
    return { status };
  }
  const codexErrorInfoValue =
    errorRecord.codexErrorInfo ?? errorRecord.codex_error_info ?? errorRecord.type;
  const error: TurnTerminalError = {
    message:
      pickString(errorRecord, ["message", "text", "summary", "reason"], { trim: true }) ??
      undefined,
    codexErrorInfo: summarizeCodexErrorInfo(codexErrorInfoValue),
    httpStatusCode: findFirstNestedNumber(codexErrorInfoValue, ["httpStatusCode", "http_status_code"]),
  };
  return {
    status,
    error:
      error.message || error.codexErrorInfo || error.httpStatusCode !== undefined ? error : undefined,
  };
}

function mapPendingInputResponse(params: {
  methodLower: string;
  requestParams: unknown;
  response: unknown;
  options: string[];
  actions: PendingInputAction[];
}): unknown {
  const { methodLower, response, options, actions } = params;
  if (methodLower.includes("requestapproval")) {
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
  return response;
}

function extractApprovalDecision(value: unknown): string | undefined {
  const record = asRecord(value);
  return record ? pickString(record, ["decision"]) : undefined;
}

function resolveTurnStoppedReason(params: {
  interrupted: boolean;
  terminalStatus?: TurnResult["terminalStatus"];
  approvalCancelled: boolean;
  assistantText: string;
  hasPlanArtifact: boolean;
}): TurnResult["stoppedReason"] | undefined {
  if (params.interrupted) {
    return "interrupt";
  }
  if (params.terminalStatus === "interrupted") {
    return "cancelled";
  }
  if (params.approvalCancelled && !params.assistantText.trim() && !params.hasPlanArtifact) {
    return "approval";
  }
  return undefined;
}

type PendingInputQueueEntry = {
  state: PendingInputState;
  options: string[];
  actions: PendingInputAction[];
  methodLower: string;
  response: Promise<unknown>;
  resolveResponse: (value: unknown) => void;
};

function createPendingInputCoordinator(params: {
  onPendingInput?: (state: PendingInputState | null) => Promise<void> | void;
  onActivated?: () => void;
  onCleared?: () => void;
}) {
  let current: PendingInputQueueEntry | null = null;
  const queued: PendingInputQueueEntry[] = [];

  const presentNext = async () => {
    if (current || queued.length === 0) {
      return;
    }
    const next = queued.shift();
    if (!next) {
      return;
    }
    current = next;
    params.onActivated?.();
    await params.onPendingInput?.(next.state);
  };

  const clearCurrent = async () => {
    const active = current;
    if (!active) {
      return;
    }
    current = null;
    params.onCleared?.();
    await params.onPendingInput?.(null);
    await presentNext();
  };

  const settleCurrent = async (value: unknown) => {
    const active = current;
    if (!active) {
      return false;
    }
    current = null;
    params.onCleared?.();
    await params.onPendingInput?.(null);
    active.resolveResponse(value);
    await presentNext();
    return true;
  };

  return {
    enqueue(
      entry: Omit<
        PendingInputQueueEntry,
        "response" | "resolveResponse"
      >,
    ) {
      let resolveResponse: (value: unknown) => void = () => undefined;
      const queuedEntry: PendingInputQueueEntry = {
        ...entry,
        response: new Promise<unknown>((resolve) => {
          resolveResponse = resolve;
        }),
        resolveResponse: (value) => resolveResponse(value),
      };
      queued.push(queuedEntry);
      void presentNext();
      return queuedEntry;
    },
    current() {
      return current;
    },
    async settleCurrent(value: unknown) {
      return settleCurrent(value);
    },
    async clearCurrent() {
      await clearCurrent();
    },
  };
}

const UNHANDLED_REQUEST = Symbol("codex.unhandledRequest");
type RequestListener = (method: string, params: unknown) => Promise<unknown | typeof UNHANDLED_REQUEST>;

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
  private connectionPromise:
    | Promise<{
        client: JsonRpcClient;
        initializeResult: unknown;
      }>
    | undefined;
  private startupProbePromise: Promise<void> | undefined;
  private readonly notificationListeners = new Set<JsonRpcNotificationHandler>();
  private readonly requestListeners = new Set<RequestListener>();

  constructor(
    private readonly settings: PluginSettings,
    private readonly logger: PluginLogger,
  ) {}

  private clearConnectionState(): void {
    this.connectionPromise = undefined;
  }

  private async dispatchNotification(method: string, params: unknown): Promise<void> {
    for (const listener of [...this.notificationListeners]) {
      try {
        await listener(method, params);
      } catch (error) {
        this.logger.debug(`codex notification dispatch failed: ${String(error)}`);
      }
    }
  }

  private async dispatchRequest(method: string, params: unknown): Promise<unknown> {
    for (const listener of [...this.requestListeners]) {
      const result = await listener(method, params);
      if (result !== UNHANDLED_REQUEST) {
        return result;
      }
    }
    return {};
  }

  private addNotificationListener(listener: JsonRpcNotificationHandler): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  private addRequestListener(listener: RequestListener): () => void {
    this.requestListeners.add(listener);
    return () => {
      this.requestListeners.delete(listener);
    };
  }

  private async getConnection(): Promise<{
    client: JsonRpcClient;
    initializeResult: unknown;
  }> {
    if (this.connectionPromise) {
      return await this.connectionPromise;
    }

    let connectionPromise:
      | Promise<{
          client: JsonRpcClient;
          initializeResult: unknown;
        }>
      | undefined;
    const handleClose = () => {
      if (this.connectionPromise === connectionPromise) {
        this.logger.debug("codex app server transport closed");
        this.clearConnectionState();
      }
    };
    const client = createJsonRpcClient(this.settings, this.logger, handleClose);
    client.setNotificationHandler((method, params) => this.dispatchNotification(method, params));
    client.setRequestHandler((method, params) => this.dispatchRequest(method, params));
    connectionPromise = (async () => {
      await client.connect();
      const initializeResult = await initializeClient({
        client,
      });
      return { client, initializeResult };
    })().catch(async (error) => {
      if (this.connectionPromise === connectionPromise) {
        this.clearConnectionState();
      }
      await client.close().catch(() => undefined);
      throw error;
    });
    this.connectionPromise = connectionPromise;
    return await connectionPromise;
  }

  private async ensureConnected(): Promise<{
    client: JsonRpcClient;
    initializeResult: unknown;
  }> {
    return await this.getConnection();
  }

  private async withClient<T>(
    params: { sessionKey?: string },
    callback: (args: {
      client: JsonRpcClient;
      settings: PluginSettings;
      initializeResult: unknown;
    }) => Promise<T>,
  ): Promise<T> {
    const connection = await this.ensureConnected();
    try {
      return await callback({
        client: connection.client,
        settings: this.settings,
        initializeResult: connection.initializeResult,
      });
    } catch (error) {
      if (isTransportClosedError(error)) {
        this.clearConnectionState();
      }
      throw error;
    }
  }

  async logStartupProbe(params: { sessionKey?: string } = {}): Promise<void> {
    if (this.startupProbePromise) {
      return await this.startupProbePromise;
    }
    const base: StartupProbeInfo = {
      transport: this.settings.transport,
      command: this.settings.transport === "stdio" ? this.settings.command : undefined,
      args: this.settings.transport === "stdio" ? this.settings.args : undefined,
    };
    const stdioProbe =
      this.settings.transport === "stdio" ? await probeStdioVersion(this.settings) : {};
    const probePromise = this.ensureConnected()
      .then(async ({ initializeResult }) => {
        const info = extractStartupProbeInfo(initializeResult, {
          ...base,
          ...stdioProbe,
        });
        this.logger.info(`codex startup probe ${formatStartupProbeLog(info)}`);
      })
      .catch((error) => {
        this.startupProbePromise = undefined;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `codex startup probe failed transport=${this.settings.transport}${this.settings.transport === "stdio" ? ` command=${this.settings.command}` : ""}: ${message}`,
        );
      });
    this.startupProbePromise = probePromise;
    await probePromise;
  }

  async close(): Promise<void> {
    const connectionPromise = this.connectionPromise;
    this.clearConnectionState();
    const connection = await connectionPromise?.catch(() => undefined);
    await connection?.client.close().catch(() => undefined);
  }

  async listThreads(params: {
    sessionKey?: string;
    workspaceDir?: string;
    filter?: string;
  }): Promise<ThreadSummary[]> {
    return await this.withClient(
      { sessionKey: params.sessionKey },
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
    return await this.withClient(
      { sessionKey: params.sessionKey },
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
    return await this.withClient(
      { sessionKey: params.sessionKey },
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
    return await this.withClient(
      { sessionKey: params.sessionKey },
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
    return await this.withClient(
      { sessionKey: params.sessionKey },
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
    return await this.withClient(
      { sessionKey: params.sessionKey },
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

  async readAccount(params: {
    sessionKey?: string;
    refreshToken?: boolean;
  }): Promise<AccountSummary> {
    return await this.withClient(
      { sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        const refreshToken = params.refreshToken ?? false;
        const result = await requestWithFallbacks({
          client,
          methods: ["account/read"],
          payloads: [{ refreshToken }, { refresh_token: refreshToken }, {}],
          timeoutMs: settings.requestTimeoutMs,
        });
        return extractAccountSummary(result);
      },
    );
  }

  async readThreadState(params: { sessionKey?: string; threadId: string }): Promise<ThreadState> {
    return await this.withClient(
      { sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        const result = await requestWithFallbacks({
          client,
          methods: ["thread/resume"],
          payloads: buildThreadResumePayloads({ threadId: params.threadId }),
          timeoutMs: settings.requestTimeoutMs,
        });
        return extractThreadState(result);
      },
    );
  }

  async setThreadName(params: {
    sessionKey?: string;
    threadId: string;
    name: string;
  }): Promise<void> {
    await this.withClient(
      { sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        await requestWithFallbacks({
          client,
          methods: ["thread/name/set"],
          payloads: [{ threadId: params.threadId, name: params.name }],
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
    return await this.withClient(
      { sessionKey: params.sessionKey },
      async ({ client, settings }) => {
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
      },
    );
  }

  async setThreadServiceTier(params: {
    sessionKey?: string;
    threadId: string;
    serviceTier: string | null;
  }): Promise<ThreadState> {
    return await this.withClient(
      { sessionKey: params.sessionKey },
      async ({ client, settings }) => {
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
      },
    );
  }

  async compactThread(params: {
    sessionKey?: string;
    threadId: string;
    onProgress?: (progress: CompactProgress) => Promise<void> | void;
  }): Promise<CompactResult> {
    const connectionPromise = this.ensureConnected();
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

    const removeNotificationListener = this.addNotificationListener(async (method, notificationParams) => {
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
      const { client } = await connectionPromise;
      await requestWithFallbacks({
        client,
        methods: ["thread/resume"],
        payloads: buildThreadResumePayloads({ threadId: params.threadId }),
        timeoutMs: this.settings.requestTimeoutMs,
      });
      await requestWithFallbacks({
        client,
        methods: ["thread/compact/start"],
        payloads: [{ threadId: params.threadId }],
        timeoutMs: this.settings.requestTimeoutMs,
      });
      await completion;
      return { itemId: compactionItemId || undefined, usage: latestUsage };
    } finally {
      removeNotificationListener();
      if (settleTimer) {
        clearTimeout(settleTimer);
      }
    }
  }

  async readThreadContext(params: {
    sessionKey?: string;
    threadId: string;
  }): Promise<ThreadReplay> {
    return await this.withClient(
      { sessionKey: params.sessionKey },
      async ({ client, settings }) => {
        const result = await requestWithFallbacks({
          client,
          methods: ["thread/read"],
          payloads: [{ threadId: params.threadId, includeTurns: true }],
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
    let reviewThreadId = params.threadId.trim();
    let turnId = "";
    let reviewText = "";
    let assistantText = "";
    let awaitingInput = false;
    let interrupted = false;
    let completed = false;
    let notificationQueue = Promise.resolve();
    const pendingInputCoordinator = createPendingInputCoordinator({
      onPendingInput: params.onPendingInput,
      onActivated: () => {
        awaitingInput = true;
      },
      onCleared: () => {
        awaitingInput = false;
      },
    });
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

    const connectionPromise = this.ensureConnected();
    const getClient = async () => (await connectionPromise).client;

    const handleResult = (async () => {
      try {
        const client = await getClient();
        await requestWithFallbacks({
          client,
          methods: ["thread/resume"],
          payloads: [{ threadId: reviewThreadId }],
          timeoutMs: this.settings.requestTimeoutMs,
        }).catch(() => undefined);
        const result = await requestWithFallbacks({
          client,
          methods: ["review/start"],
          payloads: [{ threadId: reviewThreadId, target: params.target, delivery: "inline" }],
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
      } catch (error) {
        if (isTransportClosedError(error)) {
          this.clearConnectionState();
        }
        throw error;
      }
    })();

    const removeNotificationListener = this.addNotificationListener((method, notificationParams) => {
      const next = notificationQueue.then(async () => {
        const ids = extractIds(notificationParams);
        reviewThreadId ||= ids.threadId ?? "";
        turnId ||= ids.runId ?? "";
        const methodLower = method.trim().toLowerCase();
        if (methodLower === "serverrequest/resolved") {
          await pendingInputCoordinator.clearCurrent();
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

    const removeRequestListener = this.addRequestListener(async (method, requestParams) => {
      const methodLower = method.trim().toLowerCase();
      if (!isInteractiveServerRequest(method)) {
        return UNHANDLED_REQUEST;
      }
      const ids = extractIds(requestParams);
      if (ids.threadId && reviewThreadId && ids.threadId !== reviewThreadId) {
        return UNHANDLED_REQUEST;
      }
      reviewThreadId ||= ids.threadId ?? "";
      turnId ||= ids.runId ?? "";
      const options = extractOptionValues(requestParams);
      const requestId = ids.requestId ?? `${params.runId}-${Date.now().toString(36)}`;
      const expiresAt = Date.now() + PENDING_INPUT_TTL_MS;
      const client = await getClient();
      const enrichedRequestParams =
        methodLower.includes("filechange/requestapproval") && ids.threadId && ids.itemId
          ? {
              ...(asRecord(requestParams) ?? {}),
              filePaths: await readFileChangePathsWithClient({
                client,
                settings: this.settings,
                threadId: ids.threadId,
                itemId: ids.itemId,
                workspaceDir: params.workspaceDir,
              }).catch(() => []),
            }
          : requestParams;
      const state = createPendingInputState({
        method,
        requestId,
        requestParams: enrichedRequestParams,
        options,
        expiresAt,
      });
      this.logger.debug(
        `codex review interactive request ${method} (questionnaire=${state.questionnaire ? "yes" : "no"})`,
      );
      const pendingEntry = pendingInputCoordinator.enqueue({
        state,
        options,
        actions: state.actions ?? [],
        methodLower,
      });
      const response = await pendingEntry.response;
      const mappedResponse = mapPendingInputResponse({
        methodLower,
        requestParams,
        response,
        options,
        actions: state.actions ?? [],
      });
      const responseRecord = asRecord(response);
      const steerText =
        methodLower.includes("requestapproval") && typeof responseRecord?.steerText === "string"
          ? responseRecord.steerText.trim()
          : "";
      if (steerText && reviewThreadId && turnId) {
        await requestWithFallbacks({
          client,
          methods: [...TURN_STEER_METHODS],
          payloads: buildTurnSteerPayloads({
            threadId: reviewThreadId,
            turnId,
            text: steerText,
          }),
          timeoutMs: this.settings.requestTimeoutMs,
        });
      } else if (steerText && reviewThreadId) {
        this.logger.warn(
          `codex review interactive steer dropped without active turn reviewThread=${reviewThreadId}`,
        );
      }
      return mappedResponse;
    });

    return {
      result: handleResult.finally(() => {
        removeNotificationListener();
        removeRequestListener();
      }),
      queueMessage: async (text) => {
        const trimmed = text.trim();
        const pendingInput = pendingInputCoordinator.current();
        if (!trimmed || !pendingInput) {
          return false;
        }
        const actionSelectionCount =
          pendingInput.actions.filter((action) => action.kind !== "steer").length ||
          pendingInput.options.length;
        const parsed = parseCodexUserInput(trimmed, actionSelectionCount);
        if (parsed.kind === "option") {
          await pendingInputCoordinator.settleCurrent({
            index: parsed.index,
            option: pendingInput.options[parsed.index] ?? "",
          });
        } else if (pendingInput.methodLower.includes("requestapproval")) {
          await pendingInputCoordinator.settleCurrent({ steerText: parsed.text });
        } else {
          await pendingInputCoordinator.settleCurrent({ text: parsed.text });
        }
        return true;
      },
      submitPendingInput: async (actionIndex) => {
        const pendingInput = pendingInputCoordinator.current();
        if (!pendingInput) {
          return false;
        }
        const action = pendingInput.actions[actionIndex];
        if (!action || action.kind === "steer") {
          return false;
        }
        await pendingInputCoordinator.settleCurrent({
          index: actionIndex,
          option: pendingInput.options[actionIndex] ?? "",
        });
        return true;
      },
      submitPendingInputPayload: async (payload) => {
        const pendingInput = pendingInputCoordinator.current();
        if (!pendingInput) {
          return false;
        }
        await pendingInputCoordinator.settleCurrent(payload);
        return true;
      },
      interrupt: async () => {
        interrupted = true;
        await params.onInterrupted?.();
        const client = await getClient().catch(() => null);
        if (reviewThreadId && turnId && client) {
          await requestWithFallbacks({
            client,
            methods: [...TURN_INTERRUPT_METHODS],
            payloads: buildTurnInterruptPayloads({ threadId: reviewThreadId, turnId }),
            timeoutMs: this.settings.requestTimeoutMs,
          }).catch(() => undefined);
        } else if (reviewThreadId) {
          this.logger.debug(
            `codex review interrupt ignored without active turn reviewThread=${reviewThreadId}`,
          );
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
    collaborationMode?: CollaborationMode;
    onPendingInput?: (state: PendingInputState | null) => Promise<void> | void;
    onFileEdits?: (text: string) => Promise<void> | void;
    onInterrupted?: () => Promise<void> | void;
  }): ActiveCodexRun {
    let threadId = params.existingThreadId?.trim() || "";
    let turnId = "";
    let threadModel = "";
    let threadReasoningEffort = "";
    let assistantText = "";
    let sawAssistantOutput = false;
    let assistantItemId = "";
    let planExplanation = "";
    let planSteps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }> = [];
    const planDraftByItemId = new Map<string, string>();
    let finalPlanMarkdown = "";
    let awaitingInput = false;
    let interrupted = false;
    let completed = false;
    let latestContextUsage: ContextUsageSnapshot | undefined;
    let terminalStatus: TurnResult["terminalStatus"] | undefined;
    let terminalError: TurnTerminalError | undefined;
    let approvalCancelled = false;
    let notificationQueue = Promise.resolve();
    const pendingInputCoordinator = createPendingInputCoordinator({
      onPendingInput: params.onPendingInput,
      onActivated: () => {
        awaitingInput = true;
        assistantText = "";
        assistantItemId = "";
      },
      onCleared: () => {
        awaitingInput = false;
      },
    });
    const fileEditNoticeBatcher = createFileEditNoticeBatcher({
      onFlush: params.onFileEdits,
    });
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

    const connectionPromise = this.ensureConnected();
    const getClient = async () => (await connectionPromise).client;

    const removeNotificationListener = this.addNotificationListener((method, notificationParams) => {
      const next = notificationQueue.then(async () => {
        const methodLower = method.trim().toLowerCase();
        const ids = extractIds(notificationParams);
        if (ids.threadId && threadId && ids.threadId !== threadId) {
          return;
        }
        threadId ||= ids.threadId ?? "";
        turnId ||= ids.runId ?? "";
        const tokenUsage = extractThreadTokenUsageSnapshot(notificationParams);
        if (tokenUsage) {
          latestContextUsage = tokenUsage;
        }
        if (methodLower === "item/started") {
          const fileEditSummaries = extractFileEditSummariesFromNotification(
            notificationParams,
            params.workspaceDir,
          );
          if (fileEditSummaries.length > 0) {
            fileEditNoticeBatcher.add(fileEditSummaries);
            return;
          }
        }
        if (methodLower === "serverrequest/resolved") {
          await pendingInputCoordinator.clearCurrent();
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
        const assistantPreview = assistantNotification.text.trim();
        if (assistantPreview && !sawAssistantOutput) {
          sawAssistantOutput = true;
          this.logger.debug(
            `codex turn first assistant output run=${params.runId} thread=${threadId || "<pending>"} turn=${turnId || "<pending>"} method=${methodLower} chars=${assistantPreview.length} preview="${summarizeTextForLog(assistantPreview, 80)}"`,
          );
        }
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
          const terminalState = extractTurnTerminalState(method, notificationParams);
          terminalStatus = terminalState?.status ?? terminalStatus;
          terminalError = terminalState?.error ?? terminalError;
          await fileEditNoticeBatcher.flush();
          this.logger.debug(
            `codex turn terminal notification run=${params.runId} thread=${threadId || "<pending>"} turn=${turnId || "<pending>"} method=${methodLower}`,
          );
          completeTurn?.();
        }
      });
      notificationQueue = next.catch((error: unknown) => {
        this.logger.debug(`codex turn notification handling failed: ${String(error)}`);
      });
      return next;
    });

    const removeRequestListener = this.addRequestListener(async (method, requestParams) => {
      const methodLower = method.trim().toLowerCase();
      if (!isInteractiveServerRequest(method)) {
        return UNHANDLED_REQUEST;
      }
      const ids = extractIds(requestParams);
      if (ids.threadId && threadId && ids.threadId !== threadId) {
        return UNHANDLED_REQUEST;
      }
      threadId ||= ids.threadId ?? "";
      turnId ||= ids.runId ?? "";
      const options = extractOptionValues(requestParams);
      const requestId = ids.requestId ?? `${params.runId}-${Date.now().toString(36)}`;
      const expiresAt = Date.now() + PENDING_INPUT_TTL_MS;
      const client = await getClient();
      await fileEditNoticeBatcher.flush();
      const enrichedRequestParams =
        methodLower.includes("filechange/requestapproval") && ids.threadId && ids.itemId
          ? {
              ...(asRecord(requestParams) ?? {}),
              filePaths: await readFileChangePathsWithClient({
                client,
                settings: this.settings,
                threadId: ids.threadId,
                itemId: ids.itemId,
                workspaceDir: params.workspaceDir,
              }).catch(() => []),
            }
          : requestParams;
      const state = createPendingInputState({
        method,
        requestId,
        requestParams: enrichedRequestParams,
        options,
        expiresAt,
      });
      this.logger.debug(
        `codex turn interactive request ${method} (questionnaire=${state.questionnaire ? "yes" : "no"})`,
      );
      const pendingEntry = pendingInputCoordinator.enqueue({
        state,
        options,
        actions: state.actions ?? [],
        methodLower,
      });
      const response = await pendingEntry.response;
      const mappedResponse = mapPendingInputResponse({
        methodLower,
        requestParams,
        response,
        options,
        actions: state.actions ?? [],
      });
      const approvalDecision = extractApprovalDecision(mappedResponse)?.toLowerCase();
      if (approvalDecision === "cancel") {
        approvalCancelled = true;
        this.logger.debug(
          `codex turn approval cancelled by user run=${params.runId} thread=${threadId || "<none>"} turn=${turnId || "<none>"} method=${methodLower}`,
        );
      }
      const responseRecord = asRecord(response);
      const steerText =
        methodLower.includes("requestapproval") && typeof responseRecord?.steerText === "string"
          ? responseRecord.steerText.trim()
          : "";
      if (steerText && threadId && turnId) {
        await requestWithFallbacks({
          client,
          methods: [...TURN_STEER_METHODS],
          payloads: buildTurnSteerPayloads({ threadId, turnId, text: steerText }),
          timeoutMs: this.settings.requestTimeoutMs,
        });
      } else if (steerText && threadId) {
        this.logger.warn(
          `codex turn interactive steer dropped without active turn run=${params.runId} thread=${threadId}`,
        );
      }
      return mappedResponse;
    });

    const handleResult = (async () => {
      try {
        this.logger.debug(
          `codex turn attaching to shared app-server connection run=${params.runId} existingThread=${threadId || "<none>"} workspace=${params.workspaceDir} mode=${params.collaborationMode?.mode ?? "default"} prompt="${summarizeTextForLog(params.prompt)}"`,
        );
        this.logger.debug(`codex turn shared app-server connection ready run=${params.runId}`);
        const client = await getClient();
        this.logger.debug(
          `codex turn using shared app-server client run=${params.runId} session=${params.sessionKey ?? "<none>"}`,
        );
        if (!threadId) {
          const created = await requestWithFallbacks({
            client,
            methods: ["thread/start", "thread/new"],
            payloads: [
              { cwd: params.workspaceDir, model: params.model },
              { cwd: params.workspaceDir },
              {},
            ],
            timeoutMs: this.settings.requestTimeoutMs,
          });
          const createdState = extractThreadState(created);
          threadId = extractIds(created).threadId ?? "";
          threadModel = createdState.model?.trim() || threadModel;
          threadReasoningEffort = createdState.reasoningEffort?.trim() || threadReasoningEffort;
          if (!threadId) {
            throw new Error("Codex App Server did not return a thread id.");
          }
          this.logger.debug(
            `codex turn thread created run=${params.runId} thread=${threadId} model=${threadModel || "<none>"} reasoningEffort=${threadReasoningEffort || "<none>"}`,
          );
        } else {
          const resumed = await requestWithFallbacks({
            client,
            methods: ["thread/resume"],
            payloads: [{ threadId }],
            timeoutMs: this.settings.requestTimeoutMs,
          }).catch(() => undefined);
          const resumedState = resumed ? extractThreadState(resumed) : undefined;
          threadModel = resumedState?.model?.trim() || threadModel;
          threadReasoningEffort =
            resumedState?.reasoningEffort?.trim() || threadReasoningEffort;
          this.logger.debug(
            `codex turn thread resumed run=${params.runId} thread=${threadId} model=${threadModel || "<none>"} reasoningEffort=${threadReasoningEffort || "<none>"}`,
          );
        }
        const synthesizedDefaultMode = buildDefaultCollaborationMode({
          model: params.model?.trim() || threadModel,
          reasoningEffort: threadReasoningEffort,
        });
        const collaborationMode = params.collaborationMode ?? synthesizedDefaultMode;
        const turnStartPayloads = buildTurnStartPayloads({
          threadId,
          prompt: params.prompt,
          model: params.model,
          collaborationMode,
          collaborationFallbackModel: params.model?.trim() || threadModel,
        });
        const collaborationPayload = turnStartPayloads.some((payload) =>
          payloadHasCollaborationMode(payload),
        );
        this.logger.debug(
          `codex turn start payload run=${params.runId} thread=${threadId} requestedMode=${params.collaborationMode?.mode ?? "default"} modeSource=${params.collaborationMode ? "explicit" : "synthesized"} requestedModel=${params.model?.trim() || "<none>"} threadModel=${threadModel || "<none>"} collaborationPayload=${collaborationPayload ? "yes" : "no"}`,
        );
        if (collaborationMode && !collaborationPayload) {
          this.logger.warn(
            `codex turn start omitted collaboration mode payload run=${params.runId} thread=${threadId} requestedMode=${collaborationMode.mode} requestedModel=${params.model?.trim() || "<none>"} threadModel=${threadModel || "<none>"}`,
          );
        }
        const started = await requestWithFallbacks({
          client,
          methods: ["turn/start"],
          payloads: turnStartPayloads,
          timeoutMs: this.settings.requestTimeoutMs,
        });
        const startedIds = extractIds(started);
        threadId ||= startedIds.threadId ?? "";
        turnId ||= startedIds.runId ?? "";
        this.logger.debug(
          `codex turn started run=${params.runId} thread=${threadId || "<none>"} turn=${turnId || "<none>"}`,
        );
        await completion;
        if (completed && !interrupted) {
          await new Promise<void>((resolve) => setTimeout(resolve, TRAILING_NOTIFICATION_SETTLE_MS));
          await notificationQueue;
        }
        this.logger.debug(
          `codex turn completion settled run=${params.runId} thread=${threadId || "<none>"} turn=${turnId || "<none>"} interrupted=${interrupted ? "yes" : "no"} assistantChars=${assistantText.length}`,
        );
        const stoppedReason = resolveTurnStoppedReason({
          interrupted,
          terminalStatus,
          approvalCancelled,
          assistantText,
          hasPlanArtifact:
            Boolean(finalPlanMarkdown) || planDraftByItemId.size > 0 || planSteps.length > 0,
        });
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
          aborted: stoppedReason === "interrupt" || stoppedReason === "cancelled",
          stoppedReason,
          terminalStatus,
          terminalError,
          usage: latestContextUsage,
        } satisfies TurnResult;
      } catch (error) {
        if (isTransportClosedError(error)) {
          this.clearConnectionState();
        }
        this.logger.warn(
          `codex turn execution failed run=${params.runId} thread=${threadId || "<none>"} turn=${turnId || "<none>"}: ${String(error)}`,
        );
        throw error;
      }
    })();

    return {
      result: handleResult.finally(() => {
        removeNotificationListener();
        removeRequestListener();
      }),
      queueMessage: async (text) => {
        const trimmed = text.trim();
        if (!trimmed) {
          return false;
        }
        const pendingInput = pendingInputCoordinator.current();
        if (pendingInput) {
          const actionSelectionCount =
            pendingInput.actions.filter((action) => action.kind !== "steer").length ||
            pendingInput.options.length;
          const parsed = parseCodexUserInput(trimmed, actionSelectionCount);
          if (parsed.kind === "option") {
            const action = pendingInput.actions[parsed.index];
            if (action?.kind === "steer") {
              await pendingInputCoordinator.settleCurrent({ steerText: "" });
            } else {
              await pendingInputCoordinator.settleCurrent({
                index: parsed.index,
                option: pendingInput.options[parsed.index] ?? "",
              });
            }
          } else if (pendingInput.methodLower.includes("requestapproval")) {
            await pendingInputCoordinator.settleCurrent({ steerText: parsed.text });
          } else {
            await pendingInputCoordinator.settleCurrent({ text: parsed.text });
          }
          this.logger.debug(
            `codex turn queued interactive response run=${params.runId} thread=${threadId || "<none>"} turn=${turnId || "<none>"} prompt="${summarizeTextForLog(trimmed, 80)}"`,
          );
          return true;
        }
        if (!threadId) {
          this.logger.debug(`codex turn queue rejected before thread assignment run=${params.runId}`);
          return false;
        }
        if (!turnId) {
          this.logger.warn(
            `codex turn queue rejected without active turn run=${params.runId} thread=${threadId}`,
          );
          return false;
        }
        const client = await getClient();
        await requestWithFallbacks({
          client,
          methods: [...TURN_STEER_METHODS],
          payloads: buildTurnSteerPayloads({ threadId, turnId, text: trimmed }),
          timeoutMs: this.settings.requestTimeoutMs,
        });
        this.logger.debug(
          `codex turn queued steer message run=${params.runId} thread=${threadId} turn=${turnId || "<none>"} prompt="${summarizeTextForLog(trimmed, 80)}"`,
        );
        return true;
      },
      submitPendingInput: async (actionIndex) => {
        const pendingInput = pendingInputCoordinator.current();
        if (!pendingInput) {
          return false;
        }
        const action = pendingInput.actions[actionIndex];
        if (!action || action.kind === "steer") {
          return false;
        }
        await pendingInputCoordinator.settleCurrent({
          index: actionIndex,
          option: pendingInput.options[actionIndex] ?? "",
        });
        return true;
      },
      submitPendingInputPayload: async (payload) => {
        const pendingInput = pendingInputCoordinator.current();
        if (!pendingInput) {
          return false;
        }
        await pendingInputCoordinator.settleCurrent(payload);
        return true;
      },
      interrupt: async () => {
        if (!threadId) {
          this.logger.debug(`codex turn interrupt ignored before thread assignment run=${params.runId}`);
          return;
        }
        interrupted = true;
        this.logger.debug(
          `codex turn interrupt requested run=${params.runId} thread=${threadId} turn=${turnId || "<none>"}`,
        );
        await params.onInterrupted?.();
        if (turnId) {
          const client = await getClient().catch(() => null);
          if (!client) {
            completeTurn?.();
            return;
          }
          await requestWithFallbacks({
            client,
            methods: [...TURN_INTERRUPT_METHODS],
            payloads: buildTurnInterruptPayloads({ threadId, turnId }),
            timeoutMs: this.settings.requestTimeoutMs,
          }).catch(() => undefined);
        } else {
          this.logger.debug(
            `codex turn interrupt ignored without active turn run=${params.runId} thread=${threadId}`,
          );
        }
        completeTurn?.();
      },
      isAwaitingInput: () => awaitingInput,
      getThreadId: () => threadId || undefined,
    };
  }
}

export const __testing = {
  buildThreadResumePayloads,
  buildTurnStartPayloads,
  buildTurnSteerPayloads,
  createFileEditNoticeBatcher,
  createPendingInputCoordinator,
  extractApprovalDecision,
  extractTurnTerminalState,
  extractFileEditSummariesFromNotification,
  extractFileChangePathsFromReadResult,
  extractStartupProbeInfo,
  formatFileEditNotice,
  extractThreadTokenUsageSnapshot,
  extractRateLimitSummaries,
  formatStdioProcessLog,
  resolveTurnStoppedReason,
};
