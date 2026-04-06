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

    const registerInternalHook = (
      api as OpenClawPluginApi & {
        registerHook?: (
          events: string | string[],
          handler: (event: unknown) => Promise<void> | void,
          opts?: { name?: string; description?: string },
        ) => void;
      }
    ).registerHook;
    if (typeof registerInternalHook === "function") {
      registerInternalHook(
        "message:transcribed",
        async (event) => {
          await controller.handleMessageTranscribed(event as {
            type?: string;
            action?: string;
            sessionKey?: string;
            context?: Record<string, unknown>;
          });
        },
        {
          name: "codex-transcribed-handoff",
          description: "Send transcribed inbound audio to the bound Codex thread as text.",
        },
      );

      registerInternalHook(
        "message:preprocessed",
        async (event) => {
          await controller.handleMessagePreprocessed(event as {
            type?: string;
            action?: string;
            sessionKey?: string;
            context?: Record<string, unknown>;
          });
        },
        {
          name: "codex-preprocessed-audio-fallback",
          description: "Fallback: transcribe bound inbound audio from mediaPath when transcript events do not arrive.",
        },
      );
    }

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
