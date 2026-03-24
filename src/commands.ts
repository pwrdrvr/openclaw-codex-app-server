export const COMMANDS = [
  ["cas_resume", "Resume a Codex thread, or create a new one with --new."],
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

export type CommandName = (typeof COMMANDS)[number][0];

export const COMMAND_SUMMARY = Object.fromEntries(COMMANDS) as Record<CommandName, string>;
