import { accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginSettings } from "./types.js";
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "./types.js";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readHeaders(record: Record<string, unknown>): Record<string, string> | undefined {
  const value = record.headers;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const headers = Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, entryValue]) => [key, entryValue.trim()])
      .filter((entry) => entry[0].trim() && entry[1]),
  );
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
): number {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(minimum, Math.round(value));
  }
  return fallback;
}

function listExecutableNames(command: string): string[] {
  if (process.platform !== "win32") {
    return [command];
  }
  if (path.extname(command)) {
    return [command];
  }
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutableInDir(dir: string, command: string): string | undefined {
  for (const executableName of listExecutableNames(command)) {
    const candidate = path.join(dir, executableName);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function uniqueDirs(entries: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const entry of entries) {
    const trimmed = entry?.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = path.resolve(trimmed);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    dirs.push(resolved);
  }
  return dirs;
}

function resolveDefaultStdioCommand(): string | undefined {
  const command = "codex";
  const homeDir = os.homedir().trim();
  const pathDirs = (process.env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const homePathDirs = homeDir
    ? pathDirs.filter((entry) => {
        const resolved = path.resolve(entry);
        return resolved === homeDir || resolved.startsWith(`${homeDir}${path.sep}`);
      })
    : [];
  const candidateDirs = uniqueDirs([
    ...homePathDirs,
    process.env.XDG_BIN_HOME,
    homeDir ? path.join(homeDir, ".local", "bin") : undefined,
    homeDir ? path.join(homeDir, "bin") : undefined,
  ]);
  for (const dir of candidateDirs) {
    const resolved = resolveExecutableInDir(dir, command);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

export function resolvePluginSettings(rawConfig: unknown): PluginSettings {
  const record = asRecord(rawConfig);
  const transport = record.transport === "websocket" ? "websocket" : "stdio";
  const authToken = readString(record, "authToken");
  const configuredCommand = readString(record, "command");
  const configuredHeaders = readHeaders(record);
  const headers = {
    ...(configuredHeaders ?? {}),
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
  };

  return {
    enabled: record.enabled !== false,
    transport,
    command: configuredCommand ?? resolveDefaultStdioCommand() ?? "codex",
    args: readStringArray(record, "args"),
    url: readString(record, "url"),
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    requestTimeoutMs: readNumber(
      record,
      "requestTimeoutMs",
      DEFAULT_REQUEST_TIMEOUT_MS,
      100,
    ),
    defaultWorkspaceDir: readString(record, "defaultWorkspaceDir"),
    defaultModel: readString(record, "defaultModel"),
    defaultServiceTier: readString(record, "defaultServiceTier"),
  };
}

export function resolveWorkspaceDir(params: {
  requested?: string;
  bindingWorkspaceDir?: string;
  configuredWorkspaceDir?: string;
  serviceWorkspaceDir?: string;
}): string {
  return (
    params.requested?.trim() ||
    params.bindingWorkspaceDir?.trim() ||
    params.configuredWorkspaceDir?.trim() ||
    params.serviceWorkspaceDir?.trim() ||
    process.cwd()
  );
}
