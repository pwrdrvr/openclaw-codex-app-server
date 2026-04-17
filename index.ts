import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createAgentTools } from "./src/agent-tools.js";
import { CodexPluginController } from "./src/controller.js";
import { COMMANDS } from "./src/commands.js";
import { INTERACTIVE_NAMESPACE } from "./src/types.js";
const plugin = {
  id: "openclaw-codex-app-server",
  name: "OpenClaw Plugin For Codex App Server",
  description: "Independent OpenClaw plugin for the Codex App Server protocol.",
  register(api: OpenClawPluginApi) {
    const controller = new CodexPluginController(api);

    api.registerService(controller.createService());

    const toolRegistrar = (
      api as OpenClawPluginApi & {
        registerTool?: (tool: unknown) => void;
      }
    ).registerTool;
    if (typeof toolRegistrar === "function") {
      for (const tool of createAgentTools(controller)) {
        toolRegistrar(tool);
      }
    }

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
  },
};

export default plugin;
