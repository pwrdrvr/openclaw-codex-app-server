import { COMMAND_SUMMARY, type CommandName } from "./commands.js";

type CommandHelpFlag = {
  flag: string;
  description: string;
};

type CommandHelpEntry = {
  summary: string;
  usage: string;
  flags?: CommandHelpFlag[];
  examples: string[];
  notes?: string;
};

export const COMMAND_HELP: Record<CommandName, CommandHelpEntry> = {
  cas_resume: {
    summary: COMMAND_SUMMARY.cas_resume,
    usage: "/cas_resume [--projects] [--new [project]] [--all] [--cwd <path>] [--sync] [filter]",
    flags: [
      { flag: "--projects", description: "Browse projects first, then pick a thread." },
      { flag: "--new", description: "Start a new thread; optionally pass a project filter." },
      { flag: "--all", description: "Search recent threads across projects." },
      { flag: "--cwd <path>", description: "Restrict search to one workspace path." },
      { flag: "--sync", description: "Sync the chat/topic name to the selected thread title." },
      { flag: "[filter]", description: "Match by thread title, id, or project text." },
    ],
    examples: [
      "/cas_resume",
      "/cas_resume --projects",
      "/cas_resume --new openclaw",
      "/cas_resume --cwd ~/github/openclaw release-fix",
      "/cas_resume --sync thread-1",
    ],
  },
  cas_detach: {
    summary: COMMAND_SUMMARY.cas_detach,
    usage: "/cas_detach",
    examples: ["/cas_detach"],
  },
  cas_status: {
    summary: COMMAND_SUMMARY.cas_status,
    usage: "/cas_status",
    examples: ["/cas_status"],
  },
  cas_stop: {
    summary: COMMAND_SUMMARY.cas_stop,
    usage: "/cas_stop",
    examples: ["/cas_stop"],
  },
  cas_steer: {
    summary: COMMAND_SUMMARY.cas_steer,
    usage: "/cas_steer <message>",
    flags: [{ flag: "<message>", description: "Follow-up steer text for the active run." }],
    examples: [
      "/cas_steer focus on the failing tests first",
      "/cas_steer explain why this migration is safe",
    ],
  },
  cas_plan: {
    summary: COMMAND_SUMMARY.cas_plan,
    usage: "/cas_plan <goal> | /cas_plan off",
    flags: [
      { flag: "<goal>", description: "Ask Codex to plan the work instead of executing it." },
      { flag: "off", description: "Exit plan mode for this conversation." },
    ],
    examples: [
      "/cas_plan design a rollback-safe migration strategy",
      "/cas_plan off",
    ],
  },
  cas_review: {
    summary: COMMAND_SUMMARY.cas_review,
    usage: "/cas_review [focus]",
    flags: [{ flag: "[focus]", description: "Optional review focus; defaults to uncommitted changes." }],
    examples: [
      "/cas_review",
      "/cas_review focus on auth and permission regressions",
    ],
  },
  cas_compact: {
    summary: COMMAND_SUMMARY.cas_compact,
    usage: "/cas_compact",
    examples: ["/cas_compact"],
  },
  cas_skills: {
    summary: COMMAND_SUMMARY.cas_skills,
    usage: "/cas_skills [filter]",
    flags: [{ flag: "[filter]", description: "Optional text filter for skill name/description/path." }],
    examples: [
      "/cas_skills",
      "/cas_skills release",
    ],
  },
  cas_experimental: {
    summary: COMMAND_SUMMARY.cas_experimental,
    usage: "/cas_experimental",
    examples: ["/cas_experimental"],
  },
  cas_mcp: {
    summary: COMMAND_SUMMARY.cas_mcp,
    usage: "/cas_mcp [filter]",
    flags: [{ flag: "[filter]", description: "Optional text filter for server id, status, or transport." }],
    examples: [
      "/cas_mcp",
      "/cas_mcp github",
    ],
  },
  cas_fast: {
    summary: COMMAND_SUMMARY.cas_fast,
    usage: "/cas_fast [on|off|status]",
    flags: [
      { flag: "on", description: "Enable fast mode for the bound thread." },
      { flag: "off", description: "Disable fast mode for the bound thread." },
      { flag: "status", description: "Show the current fast mode state." },
    ],
    examples: [
      "/cas_fast",
      "/cas_fast on",
      "/cas_fast status",
    ],
    notes: "With no argument, this command toggles fast mode.",
  },
  cas_model: {
    summary: COMMAND_SUMMARY.cas_model,
    usage: "/cas_model [model_name]",
    flags: [{ flag: "[model_name]", description: "Optional model id to set; omit to list available models." }],
    examples: [
      "/cas_model",
      "/cas_model openai/gpt-5.4",
    ],
  },
  cas_permissions: {
    summary: COMMAND_SUMMARY.cas_permissions,
    usage: "/cas_permissions",
    examples: ["/cas_permissions"],
  },
  cas_init: {
    summary: COMMAND_SUMMARY.cas_init,
    usage: "/cas_init [args]",
    flags: [{ flag: "[args]", description: "Arguments forwarded directly to Codex /init." }],
    examples: [
      "/cas_init",
      "/cas_init --help",
    ],
  },
  cas_diff: {
    summary: COMMAND_SUMMARY.cas_diff,
    usage: "/cas_diff [args]",
    flags: [{ flag: "[args]", description: "Arguments forwarded directly to Codex /diff." }],
    examples: [
      "/cas_diff",
      "/cas_diff HEAD~1..HEAD",
    ],
  },
  cas_rename: {
    summary: COMMAND_SUMMARY.cas_rename,
    usage: "/cas_rename [--sync] <new name>",
    flags: [
      { flag: "--sync", description: "Also sync the chat/topic name when supported." },
      { flag: "<new name>", description: "New thread name. If omitted, shows style buttons." },
    ],
    examples: [
      "/cas_rename approval flow cleanup",
      "/cas_rename --sync approval flow cleanup",
      "/cas_rename --sync",
    ],
  },
};

export function formatCommandUsage(commandName: CommandName): string {
  return `Usage: ${COMMAND_HELP[commandName].usage}`;
}

export function renderCommandHelpText(commandName: string): string {
  const entry = COMMAND_HELP[commandName as CommandName];
  if (!entry) {
    return "Help is unavailable for this command.";
  }
  const lines: string[] = [
    `/${commandName}`,
    entry.summary,
    "",
    "Usage:",
    entry.usage,
  ];
  if (entry.flags?.length) {
    lines.push("", "Flags/Args:");
    for (const item of entry.flags) {
      lines.push(`- ${item.flag}: ${item.description}`);
    }
  }
  lines.push("", "Examples:");
  for (const example of entry.examples) {
    lines.push(`- ${example}`);
  }
  if (entry.notes) {
    lines.push("", "Notes:", entry.notes);
  }
  return lines.join("\n");
}
