import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { CodexPluginController } from "./src/controller.js";
import { INTERACTIVE_NAMESPACE } from "./src/types.js";

const COMMANDS = [
  ["codex_resume", "Resume or bind an existing Codex thread."],
  ["codex_detach", "Detach this conversation from the current Codex thread."],
  ["codex_status", "Show the current Codex binding and thread state."],
  ["codex_stop", "Stop the active Codex turn."],
  ["codex_steer", "Send a steer message to the active Codex turn."],
  ["codex_plan", "Ask Codex to produce a plan, or use 'off' to exit plan mode."],
  ["codex_review", "Run Codex review on the current changes."],
  ["codex_compact", "Compact the current Codex thread."],
  ["codex_skills", "List Codex skills."],
  ["codex_experimental", "List Codex experimental features."],
  ["codex_mcp", "List Codex MCP servers."],
  ["codex_fast", "Toggle Codex fast mode."],
  ["codex_model", "List or switch the Codex model."],
  ["codex_permissions", "Show Codex permissions and account status."],
  ["codex_init", "Forward /init to Codex."],
  ["codex_diff", "Forward /diff to Codex."],
  ["codex_rename", "Rename the Codex thread and sync the channel name when possible."],
] as const;

const plugin = {
  id: "openclaw-codex-app-server",
  name: "OpenClaw App Server",
  description: "Codex App Server as an OpenClaw plugin.",
  register(api: OpenClawPluginApi) {
    const controller = new CodexPluginController(api);

    api.registerService(controller.createService());

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
