import { describe, expect, it, vi } from "vitest";
import {
  isMissingPluginSdkSubpathError,
  loadOpenClawCompatModule,
  resolveCompatFallbackPath,
  resolveOpenClawEntrypointPath,
} from "./openclaw-sdk-compat.js";

describe("openclaw sdk compat", () => {
  it("detects removed plugin sdk subpath exports", () => {
    const error = Object.assign(
      new Error('Package subpath "./plugin-sdk/discord" is not defined by "exports"'),
      {
        code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
      },
    );

    expect(isMissingPluginSdkSubpathError(error, "openclaw/plugin-sdk/discord")).toBe(true);
  });

  it("detects missing plugin sdk subpaths from object-like jiti errors", () => {
    expect(
      isMissingPluginSdkSubpathError(
        {
          message:
            "Cannot find module '/Users/huntharo/github/openclaw/dist/plugin-sdk/root-alias.cjs/discord'",
        },
        "openclaw/plugin-sdk/discord",
      ),
    ).toBe(true);
  });

  it("resolves fallback paths from the OpenClaw entrypoint", () => {
    expect(
      resolveCompatFallbackPath(
        "/tmp/node_modules/openclaw/dist/index.js",
        "dist/plugin-sdk/discord.js",
      ),
    ).toBe("/tmp/node_modules/openclaw/dist/plugin-sdk/discord.js");
  });

  it("falls back to the dist facade when the public subpath is gone", async () => {
    const files = new Map<string, string>([
      [
        "/tmp/node_modules/openclaw/package.json",
        JSON.stringify({
          name: "openclaw",
          exports: {
            "./plugin-sdk": { default: "./dist/plugin-sdk/index.js" },
            "./cli-entry": { default: "./dist/cli-entry.js" },
          },
        }),
      ],
      ["/tmp/node_modules/openclaw/dist/plugin-sdk/discord.js", ""],
    ]);
    const importer = vi.fn(async (specifier: string) => {
      if (specifier === "openclaw/plugin-sdk/discord") {
        throw Object.assign(
          new Error('Package subpath "./plugin-sdk/discord" is not defined by "exports"'),
          {
            code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
          },
        );
      }
      return { ok: true, specifier };
    });

    const result = await loadOpenClawCompatModule<{ ok: boolean; specifier: string }>({
      specifier: "openclaw/plugin-sdk/discord",
      fallbackRelativePath: "dist/plugin-sdk/discord.js",
      label: "discord",
      importer,
      resolver: () => "/tmp/node_modules/openclaw/dist/index.js",
      pathExists: (targetPath) =>
        targetPath === "/tmp/node_modules/openclaw/dist/index.js" || files.has(targetPath),
      readFile: (targetPath) => {
        const content = files.get(targetPath);
        if (!content) {
          throw new Error(`missing ${targetPath}`);
        }
        return content;
      },
      cache: new Map(),
    });

    expect(result).toEqual({
      ok: true,
      specifier: "file:///tmp/node_modules/openclaw/dist/plugin-sdk/discord.js",
    });
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("prefers the host OpenClaw checkout from argv/cwd over the local dependency", () => {
    const files = new Map<string, string>([
      [
        "/host/openclaw/package.json",
        JSON.stringify({
          name: "openclaw",
          exports: {
            "./plugin-sdk": { default: "./dist/plugin-sdk/index.js" },
            "./cli-entry": { default: "./dist/cli-entry.js" },
          },
        }),
      ],
    ]);

    const result = resolveOpenClawEntrypointPath({
      argv1: "/host/openclaw/openclaw.mjs",
      cwd: "/host/openclaw",
      pathExists: (targetPath) =>
        targetPath === "/host/openclaw/openclaw.mjs" ||
        targetPath === "/host/openclaw/dist/index.js" ||
        files.has(targetPath),
      readFile: (targetPath) => {
        const content = files.get(targetPath);
        if (!content) {
          throw new Error(`missing ${targetPath}`);
        }
        return content;
      },
      resolver: () => "/repo/openclaw-app-server/node_modules/openclaw/dist/index.js",
    });

    expect(result).toBe("/host/openclaw/dist/index.js");
  });

  it("falls back to the host OpenClaw entrypoint from require.main when argv/cwd do not identify it", () => {
    const files = new Map<string, string>([
      [
        "/opt/homebrew/lib/node_modules/openclaw/package.json",
        JSON.stringify({
          name: "openclaw",
          exports: {
            "./plugin-sdk": { default: "./dist/plugin-sdk/index.js" },
            "./cli-entry": { default: "./dist/cli-entry.js" },
          },
        }),
      ],
    ]);

    const result = resolveOpenClawEntrypointPath({
      argv1: "/Users/huntharo/.openclaw/extensions/openclaw-codex-app-server/index.ts",
      cwd: "/Users/huntharo/.openclaw/extensions/openclaw-codex-app-server",
      mainFilename: "/opt/homebrew/lib/node_modules/openclaw/dist/index.js",
      pathExists: (targetPath) =>
        targetPath === "/opt/homebrew/lib/node_modules/openclaw/dist/index.js" ||
        files.has(targetPath),
      readFile: (targetPath) => {
        const content = files.get(targetPath);
        if (!content) {
          throw new Error(`missing ${targetPath}`);
        }
        return content;
      },
      resolver: () =>
        "/Users/huntharo/.openclaw/extensions/openclaw-codex-app-server/node_modules/openclaw/dist/index.js",
    });

    expect(result).toBe("/opt/homebrew/lib/node_modules/openclaw/dist/index.js");
  });

  it("rejects extension-local vendored openclaw fallbacks", () => {
    const files = new Map<string, string>([
      [
        "/Users/huntharo/.openclaw/extensions/openclaw-codex-app-server/node_modules/openclaw/package.json",
        JSON.stringify({
          name: "openclaw",
          exports: {
            "./plugin-sdk": { default: "./dist/plugin-sdk/index.js" },
            "./cli-entry": { default: "./dist/cli-entry.js" },
          },
        }),
      ],
    ]);

    expect(() =>
      resolveOpenClawEntrypointPath({
        argv1: "/Users/huntharo/.openclaw/extensions/openclaw-codex-app-server/index.ts",
        cwd: "/Users/huntharo/.openclaw/extensions/openclaw-codex-app-server",
        pathExists: (targetPath) =>
          targetPath ===
            "/Users/huntharo/.openclaw/extensions/openclaw-codex-app-server/node_modules/openclaw/dist/index.js" ||
          files.has(targetPath),
        readFile: (targetPath) => {
          const content = files.get(targetPath);
          if (!content) {
            throw new Error(`missing ${targetPath}`);
          }
          return content;
        },
        resolver: () =>
          "/Users/huntharo/.openclaw/extensions/openclaw-codex-app-server/node_modules/openclaw/dist/index.js",
      }),
    ).toThrow("Unable to resolve a trusted host OpenClaw installation");
  });

  it("rethrows non-resolution failures from the public import", async () => {
    const importer = vi.fn(async (_specifier: string) => {
      throw new Error("boom");
    });

    await expect(
      loadOpenClawCompatModule({
        specifier: "openclaw/plugin-sdk/discord",
        fallbackRelativePath: "dist/plugin-sdk/discord.js",
        label: "discord",
        importer,
        resolver: () => "/tmp/node_modules/openclaw/dist/index.js",
        pathExists: () => true,
        cache: new Map(),
      }),
    ).rejects.toThrow("boom");
  });
});
