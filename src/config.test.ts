import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePluginSettings } from "./config.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_XDG_BIN_HOME = process.env.XDG_BIN_HOME;

function restoreEnv(key: "HOME" | "PATH" | "XDG_BIN_HOME", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function makeTempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-config-"));
}

function writeExecutable(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(filePath, 0o755);
}

afterEach(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  restoreEnv("PATH", ORIGINAL_PATH);
  restoreEnv("XDG_BIN_HOME", ORIGINAL_XDG_BIN_HOME);
});

describe("resolvePluginSettings", () => {
  it("keeps an explicit command when one is configured", () => {
    const homeDir = makeTempHome();
    writeExecutable(path.join(homeDir, ".local", "bin", "codex"));
    process.env.HOME = homeDir;

    expect(resolvePluginSettings({ command: "/custom/codex" }).command).toBe("/custom/codex");
  });

  it("prefers XDG_BIN_HOME when command is omitted", () => {
    const homeDir = makeTempHome();
    const xdgBinHome = path.join(homeDir, "xdg-bin");
    writeExecutable(path.join(xdgBinHome, "codex"));
    process.env.HOME = homeDir;
    process.env.XDG_BIN_HOME = xdgBinHome;
    process.env.PATH = "/usr/bin";

    expect(resolvePluginSettings({}).command).toBe(path.join(xdgBinHome, "codex"));
  });

  it("prefers a user-local codex binary before falling back to bare codex", () => {
    const homeDir = makeTempHome();
    const localBin = path.join(homeDir, ".local", "bin");
    writeExecutable(path.join(localBin, "codex"));
    process.env.HOME = homeDir;
    process.env.PATH = "/usr/bin";

    expect(resolvePluginSettings({}).command).toBe(path.join(localBin, "codex"));
  });

  it("falls back to bare codex when no preferred user-local binary exists", () => {
    const homeDir = makeTempHome();
    process.env.HOME = homeDir;
    process.env.PATH = "/usr/bin";
    delete process.env.XDG_BIN_HOME;

    expect(resolvePluginSettings({}).command).toBe("codex");
  });
});
