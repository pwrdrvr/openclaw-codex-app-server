import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePluginSettings } from "./config.js";

describe("resolvePluginSettings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("prefers an explicit command from plugin config", () => {
    vi.stubEnv("OPENCLAW_CODEX_COMMAND", "/env/codex");

    const settings = resolvePluginSettings({
      command: "/custom/codex",
    });

    expect(settings.command).toBe("/custom/codex");
  });

  it("uses OPENCLAW_CODEX_COMMAND when config.command is missing", () => {
    vi.stubEnv("OPENCLAW_CODEX_COMMAND", "/env/codex");

    const settings = resolvePluginSettings({});

    expect(settings.command).toBe("/env/codex");
  });

  it("falls back to the bundled Codex app binary when present", () => {
    vi.stubEnv("OPENCLAW_CODEX_COMMAND", "");
    vi.stubEnv("CODEX_COMMAND", "");
    vi
      .spyOn(fs, "existsSync")
      .mockImplementation((candidate) => candidate === "/Applications/Codex.app/Contents/Resources/codex");

    const settings = resolvePluginSettings({});

    expect(settings.command).toBe("/Applications/Codex.app/Contents/Resources/codex");
  });
});
