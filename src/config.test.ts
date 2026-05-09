import { describe, expect, it } from "vitest";
import { resolvePluginSettings, resolveWorkspaceDir } from "./config.js";


describe("config resolution", () => {
  it("supports endpoint-specific default workspace directories", () => {
    const settings = resolvePluginSettings({
      defaultWorkspaceDir: "/local/workspace",
      endpoints: [
        {
          id: "default",
          transport: "stdio",
        },
        {
          id: "remote",
          transport: "websocket",
          url: "ws://remote:8765",
          defaultWorkspaceDir: " /home/agent/workspace ",
        },
      ],
    });

    expect(settings.defaultWorkspaceDir).toBe("/local/workspace");
    expect(settings.endpoints[1]?.defaultWorkspaceDir).toBe("/home/agent/workspace");
  });

  it("prefers requested and binding workspaces before endpoint defaults", () => {
    expect(
      resolveWorkspaceDir({
        requested: " /requested ",
        bindingWorkspaceDir: "/binding",
        endpointWorkspaceDir: "/endpoint",
        configuredWorkspaceDir: "/global",
      }),
    ).toBe("/requested");

    expect(
      resolveWorkspaceDir({
        bindingWorkspaceDir: " /binding ",
        endpointWorkspaceDir: "/endpoint",
        configuredWorkspaceDir: "/global",
      }),
    ).toBe("/binding");
  });

  it("uses endpoint workspace defaults before global defaults", () => {
    expect(
      resolveWorkspaceDir({
        endpointWorkspaceDir: " /endpoint ",
        configuredWorkspaceDir: "/global",
      }),
    ).toBe("/endpoint");
  });
});
