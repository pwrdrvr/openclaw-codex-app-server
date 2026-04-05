import { describe, expect, it, vi } from "vitest";
import {
  isMissingPluginSdkSubpathError,
  loadOpenClawCompatModule,
  resolveCompatFallbackPath,
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

  it("resolves fallback paths from the OpenClaw entrypoint", () => {
    expect(
      resolveCompatFallbackPath(
        "/tmp/node_modules/openclaw/dist/index.js",
        "dist/plugin-sdk/discord.js",
      ),
    ).toBe("/tmp/node_modules/openclaw/dist/plugin-sdk/discord.js");
  });

  it("falls back to the dist facade when the public subpath is gone", async () => {
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
      pathExists: () => true,
      cache: new Map(),
    });

    expect(result).toEqual({
      ok: true,
      specifier: "file:///tmp/node_modules/openclaw/dist/plugin-sdk/discord.js",
    });
    expect(importer).toHaveBeenCalledTimes(2);
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
