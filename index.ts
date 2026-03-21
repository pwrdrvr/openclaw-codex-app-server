import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { CodexPluginController } from "./src/controller.js";
import { INTERACTIVE_NAMESPACE } from "./src/types.js";

const COMMANDS = [
  ["cas_resume", "Resume or bind an existing Codex thread."],
  ["cas_detach", "Detach this conversation from the current Codex thread."],
  ["cas_status", "Show the current Codex binding and thread state."],
  ["cas_stop", "Stop the active Codex turn."],
  ["cas_steer", "Send a steer message to the active Codex turn."],
  ["cas_plan", "Ask Codex to produce a plan, or use 'off' to exit plan mode."],
  ["cas_review", "Run Codex review on the current changes."],
  ["cas_compact", "Compact the current Codex thread."],
  ["cas_skills", "List Codex skills."],
  ["cas_experimental", "List Codex experimental features."],
  ["cas_mcp", "List Codex MCP servers."],
  ["cas_fast", "Toggle Codex fast mode."],
  ["cas_model", "List or switch the Codex model."],
  ["cas_permissions", "Show Codex permissions and account status."],
  ["cas_init", "Forward /init to Codex."],
  ["cas_diff", "Forward /diff to Codex."],
  ["cas_rename", "Rename the Codex thread and sync the channel name when possible."],
] as const;

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
