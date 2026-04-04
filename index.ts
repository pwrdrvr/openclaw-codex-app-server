import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { CodexPluginController } from "./src/controller.js";
import { COMMANDS } from "./src/commands.js";
import { INTERACTIVE_NAMESPACE } from "./src/types.js";
const plugin = {
  id: "openclaw-codex-app-server",
  name: "OpenClaw Plugin For Codex App Server",
  description: "Independent OpenClaw plugin for the Codex App Server protocol.",
  register(api: OpenClawPluginApi) {
    const controller = new CodexPluginController(api);
    const hookApi = api as OpenClawPluginApi & {
      on?: (
        hookName: string,
        handler: (event: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<unknown> | unknown,
      ) => void;
    };

    api.registerService(controller.createService());

    const bindingResolvedHook = (
      api as OpenClawPluginApi & {
        onConversationBindingResolved?: OpenClawPluginApi["onConversationBindingResolved"];
      }
    ).onConversationBindingResolved;
    if (typeof bindingResolvedHook === "function") {
      bindingResolvedHook(async (event) => {
        await controller.handleConversationBindingResolved(event);
      });
    }

    api.on("inbound_claim", async (event) => {
      return await controller.handleInboundClaim(event);
    });

    hookApi.on?.("before_dispatch", async (event, ctx) => {
      return await controller.handleBeforeDispatch(event, ctx);
    });
    (api as OpenClawPluginApi & { logger?: { warn?: (text: string) => void } }).logger?.warn?.(
      "codex plugin registered before_dispatch hook",
    );

    api.registerInteractiveHandler({
      channel: "telegram",
      namespace: INTERACTIVE_NAMESPACE,
      handler: async (ctx) => {
        await controller.handleTelegramInteractive(ctx);
        return { handled: true };
      },
    });

    api.registerInteractiveHandler({
      channel: "discord",
      namespace: INTERACTIVE_NAMESPACE,
      handler: async (ctx) => {
        await controller.handleDiscordInteractive(ctx);
        return { handled: true };
      },
    });

    for (const [name, description] of COMMANDS) {
      api.registerCommand({
        name,
        description,
        acceptsArgs: true,
        handler: async (ctx) => {
          return await controller.handleCommand(name, ctx);
        },
      });
    }

    // Internal Feishu card callback command.
    // This must be registered so `/cas_click <token>` is routed to command handling
    // instead of falling through to a normal LLM turn.
    api.registerCommand({
      name: "cas_click",
      description: "Internal command for Feishu card callbacks.",
      acceptsArgs: true,
      handler: async (ctx) => {
        return await controller.handleCommand("cas_click", ctx);
      },
    });
  },
};

export default plugin;
