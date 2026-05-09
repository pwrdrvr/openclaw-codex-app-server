import { Type } from "@sinclair/typebox";
import type { CodexPluginController } from "./controller.js";

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: `codex_worker_error: ${message}` }],
    structuredContent: {
      ok: false,
      error: {
        message,
      },
    },
    isError: true,
  };
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readToolExecContext(ctx: {
  runtimeConfig?: {
    tools?: {
      exec?: {
        host?: string;
        node?: string;
      };
    };
  };
} | undefined): { host?: string; node?: string } | undefined {
  const exec = ctx?.runtimeConfig?.tools?.exec;
  const host = readString(exec?.host);
  const node = readString(exec?.node);
  if (!host && !node) {
    return undefined;
  }
  return {
    host,
    node,
  };
}

function readInputItems(value: unknown):
  | Array<{ type: "text"; text: string } | { type: "image"; url: string } | { type: "localImage"; path: string }>
  | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: Array<{ type: "text"; text: string } | { type: "image"; url: string } | { type: "localImage"; path: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const type = readString(record.type);
    if (type === "text") {
      const text = readString(record.text);
      if (text) {
        out.push({ type, text });
      }
    } else if (type === "image") {
      const url = readString(record.url);
      if (url) {
        out.push({ type, url });
      }
    } else if (type === "localImage") {
      const path = readString(record.path);
      if (path) {
        out.push({ type, path });
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

export function createAgentTools(controller: CodexPluginController) {
  type ToolCtx = {
    sessionKey?: string;
    runtimeConfig?: {
      tools?: {
        exec?: {
          host?: string;
          node?: string;
        };
      };
    };
  } | undefined;

  return [
    {
      name: "codex_workers_describe_endpoints",
      description: "Describe the configured Codex app-server worker endpoints available to OpenClaw.",
      parameters: Type.Object({}),
      async execute() {
        try {
          return jsonResult({
            ok: true,
            ...(await controller.describeAgentEndpoints()),
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    },
    {
      name: "codex_workers_list_threads",
      description: "List Codex threads on a worker endpoint. Use this before reusing an existing thread.",
      parameters: Type.Object({
        endpointId: Type.Optional(Type.String({ description: "Configured worker endpoint id, such as `context-worker` or `implementation-worker`." })),
        workspaceDir: Type.Optional(Type.String({ description: "Workspace/project directory on the remote worker. Omit to use the endpoint default." })),
        includeAllWorkspaces: Type.Optional(Type.Boolean({ description: "When true, do not scope thread discovery to a workspace directory." })),
        filter: Type.Optional(Type.String({ description: "Optional search string for thread discovery." })),
        permissionsMode: Type.Optional(Type.Union([
          Type.Literal("default"),
          Type.Literal("full-access"),
        ], { description: "Profile to use for the worker connection." })),
      }),
      async execute(
        _toolCallId: string,
        params: unknown,
        _signal: AbortSignal,
        _onUpdate: unknown,
        ctx: ToolCtx,
      ) {
        try {
          const record = (params ?? {}) as Record<string, unknown>;
          return jsonResult({
            ok: true,
            ...(await controller.listAgentThreads({
              sessionKey: ctx?.sessionKey,
              endpointId: readString(record.endpointId),
              execContext: readToolExecContext(ctx),
              workspaceDir: readString(record.workspaceDir),
              includeAllWorkspaces: readBoolean(record.includeAllWorkspaces),
              filter: readString(record.filter),
              permissionsMode: readString(record.permissionsMode) === "full-access" ? "full-access" : "default",
            })),
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    },
    {
      name: "codex_workers_run_task",
      description: "Run a prompt on a Codex worker via app-server, optionally continuing or naming a persistent thread.",
      parameters: Type.Object({
        endpointId: Type.Optional(Type.String({ description: "Configured worker endpoint id, such as `context-worker` or `implementation-worker`." })),
        prompt: Type.String({ description: "Prompt to send to the remote Codex worker." }),
        workspaceDir: Type.Optional(Type.String({ description: "Workspace/project directory on the remote worker. Omit to use the endpoint default." })),
        threadId: Type.Optional(Type.String({ description: "Existing Codex thread id to continue." })),
        threadName: Type.Optional(Type.String({ description: "Optional stable thread name for new work, e.g. job/JIRA-123/browser-worker." })),
        reuseThreadByName: Type.Optional(Type.Boolean({ description: "When true and threadName is set, try to reuse an existing thread with the same title before creating a new one." })),
        permissionsMode: Type.Optional(Type.Union([
          Type.Literal("default"),
          Type.Literal("full-access"),
        ], { description: "Profile to use for the worker connection." })),
        model: Type.Optional(Type.String({ description: "Optional model override for the worker thread/turn." })),
        reasoningEffort: Type.Optional(Type.String({ description: "Optional reasoning effort override." })),
        serviceTier: Type.Optional(Type.String({ description: "Optional Codex service tier override." })),
        collaborationMode: Type.Optional(Type.Object({
          mode: Type.String({ description: "Codex collaboration mode." }),
          settings: Type.Optional(Type.Object({
            model: Type.Optional(Type.String()),
            reasoningEffort: Type.Optional(Type.String()),
            developerInstructions: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          })),
        })),
        input: Type.Optional(Type.Array(Type.Object({
          type: Type.Union([
            Type.Literal("text"),
            Type.Literal("image"),
            Type.Literal("localImage"),
          ]),
          text: Type.Optional(Type.String()),
          url: Type.Optional(Type.String()),
          path: Type.Optional(Type.String()),
        }), { description: "Optional multimodal input items." })),
      }),
      async execute(
        _toolCallId: string,
        params: unknown,
        _signal: AbortSignal,
        _onUpdate: unknown,
        ctx: ToolCtx,
      ) {
        try {
          const record = (params ?? {}) as Record<string, unknown>;
          const prompt = readString(record.prompt);
          if (!prompt) {
            throw new Error("prompt is required");
          }
          return jsonResult({
            ok: true,
            ...(await controller.runAgentTask({
              sessionKey: ctx?.sessionKey,
              endpointId: readString(record.endpointId),
              execContext: readToolExecContext(ctx),
              prompt,
              workspaceDir: readString(record.workspaceDir),
              threadId: readString(record.threadId),
              threadName: readString(record.threadName),
              reuseThreadByName: readBoolean(record.reuseThreadByName),
              permissionsMode: readString(record.permissionsMode) === "full-access" ? "full-access" : "default",
              model: readString(record.model),
              reasoningEffort: readString(record.reasoningEffort),
              serviceTier: readString(record.serviceTier),
              collaborationMode:
                record.collaborationMode && typeof record.collaborationMode === "object" && !Array.isArray(record.collaborationMode)
                  ? {
                      mode: readString((record.collaborationMode as Record<string, unknown>).mode) || "default",
                      settings:
                        (record.collaborationMode as Record<string, unknown>).settings &&
                        typeof (record.collaborationMode as Record<string, unknown>).settings === "object" &&
                        !Array.isArray((record.collaborationMode as Record<string, unknown>).settings)
                          ? {
                              model: readString(((record.collaborationMode as Record<string, unknown>).settings as Record<string, unknown>).model),
                              reasoningEffort: readString(((record.collaborationMode as Record<string, unknown>).settings as Record<string, unknown>).reasoningEffort),
                              developerInstructions:
                                ((record.collaborationMode as Record<string, unknown>).settings as Record<string, unknown>).developerInstructions === null
                                  ? null
                                  : readString(((record.collaborationMode as Record<string, unknown>).settings as Record<string, unknown>).developerInstructions),
                            }
                          : undefined,
                    }
                  : undefined,
              input: readInputItems(record.input),
            })),
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    },
    {
      name: "codex_workers_read_thread_context",
      description: "Read the current state and replay summary for a Codex worker thread.",
      parameters: Type.Object({
        endpointId: Type.Optional(Type.String({ description: "Configured worker endpoint id, such as `context-worker` or `implementation-worker`." })),
        threadId: Type.String({ description: "Codex thread id to inspect." }),
        permissionsMode: Type.Optional(Type.Union([
          Type.Literal("default"),
          Type.Literal("full-access"),
        ], { description: "Profile to use for the worker connection." })),
      }),
      async execute(
        _toolCallId: string,
        params: unknown,
        _signal: AbortSignal,
        _onUpdate: unknown,
        ctx: ToolCtx,
      ) {
        try {
          const record = (params ?? {}) as Record<string, unknown>;
          const threadId = readString(record.threadId);
          if (!threadId) {
            throw new Error("threadId is required");
          }
          return jsonResult({
            ok: true,
            ...(await controller.readAgentThreadContext({
              sessionKey: ctx?.sessionKey,
              endpointId: readString(record.endpointId),
              execContext: readToolExecContext(ctx),
              threadId,
              permissionsMode: readString(record.permissionsMode) === "full-access" ? "full-access" : "default",
            })),
          });
        } catch (error) {
          return errorResult(error);
        }
      },
    },
  ];
}
