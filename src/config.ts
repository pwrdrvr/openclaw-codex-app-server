import type { EndpointSettings, PluginSettings } from "./types.js";
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

function normalizeEndpointId(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.replace(/\s+/g, "-");
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

export function resolvePluginSettings(rawConfig: unknown): PluginSettings {
  const record = asRecord(rawConfig);
  const endpointRecords = Array.isArray(record.endpoints)
    ? record.endpoints
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];

  const parseEndpoint = (entry: Record<string, unknown>, index: number): EndpointSettings => {
    const transport = entry.transport === "websocket" ? "websocket" : "stdio";
    const authToken = readString(entry, "authToken");
    const configuredHeaders = readHeaders(entry);
    const headers = {
      ...(configuredHeaders ?? {}),
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    };
    const fallbackId = index === 0 ? "default" : `endpoint-${index + 1}`;
    return {
      id: normalizeEndpointId(readString(entry, "id"), fallbackId),
      execNodes: readStringArray(entry, "execNodes"),
      transport,
      command: readString(entry, "command") ?? "codex",
      args: readStringArray(entry, "args"),
      url: readString(entry, "url"),
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      requestTimeoutMs: readNumber(entry, "requestTimeoutMs", DEFAULT_REQUEST_TIMEOUT_MS, 100),
    };
  };

  const legacyTransport: EndpointSettings["transport"] =
    record.transport === "websocket" ? "websocket" : "stdio";
  const legacyAuthToken = readString(record, "authToken");
  const legacyConfiguredHeaders = readHeaders(record);
  const legacyHeaders = {
    ...(legacyConfiguredHeaders ?? {}),
    ...(legacyAuthToken ? { Authorization: `Bearer ${legacyAuthToken}` } : {}),
  };

  const endpoints =
    endpointRecords.length > 0
      ? endpointRecords.map(parseEndpoint)
      : [
          {
            id: "default",
            execNodes: readStringArray(record, "execNodes"),
            transport: legacyTransport,
            command: readString(record, "command") ?? "codex",
            args: readStringArray(record, "args"),
            url: readString(record, "url"),
            headers: Object.keys(legacyHeaders).length > 0 ? legacyHeaders : undefined,
            requestTimeoutMs: readNumber(
              record,
              "requestTimeoutMs",
              DEFAULT_REQUEST_TIMEOUT_MS,
              100,
            ),
          },
        ];

  const requestedDefaultEndpoint = readString(record, "defaultEndpoint");
  const defaultEndpoint =
    endpoints.find((entry) => entry.id === requestedDefaultEndpoint)?.id ?? endpoints[0]?.id ?? "default";

  return {
    enabled: record.enabled !== false,
    defaultEndpoint,
    endpoints,
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
