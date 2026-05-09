export const COMMANDS = [
  ["cas_resume", "Resume or create a Codex thread, with optional model, fast mode, and permissions overrides."],
  ["cas_detach", "Detach this conversation from the current Codex thread."],
  ["cas_reset", "Force-clear Codex binding state for this conversation and detach it."],
  ["cas_status", "Show Codex status and controls, or apply model, fast mode, and permissions overrides."],
  ["cas_stop", "Stop the active Codex turn."],
  ["cas_steer", "Send a steer message to the active Codex turn."],
  ["cas_plan", "Ask Codex to produce a plan, or use 'off' to exit plan mode."],
  ["cas_review", "Run Codex review on the current changes."],
  ["cas_compact", "Compact the current Codex thread."],
  ["cas_skills", "List Codex skills."],
  ["cas_experimental", "List Codex experimental features."],
  ["cas_mcp", "List Codex MCP servers."],
  ["cas_fast", "Toggle or inspect fast mode for the current Codex binding."],
  ["cas_model", "List or switch the Codex model for the current binding."],
  ["cas_endpoints", "List configured Codex endpoints and show the active endpoint policy for this conversation."],
  ["cas_endpoint", "Show or switch the active Codex endpoint for this conversation."],
  ["cas_permissions", "Show Codex permissions and account status."],
  ["cas_init", "Forward /init to Codex."],
  ["cas_diff", "Forward /diff to Codex."],
  ["cas_rename", "Rename the Codex thread and optionally sync the conversation name."],
] as const;

export type CommandName = (typeof COMMANDS)[number][0];

export const COMMAND_SUMMARY = Object.fromEntries(COMMANDS) as Record<CommandName, string>;
