import { describe, expect, it, vi } from "vitest";

const controllerState = vi.hoisted(() => ({
  createService: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  handleConversationBindingResolved: vi.fn(),
  handleInboundClaim: vi.fn(),
  handleTelegramInteractive: vi.fn(),
  handleDiscordInteractive: vi.fn(),
  handleCommand: vi.fn(),
}));

vi.mock("./src/controller.js", () => ({
  CodexPluginController: class {
    createService = controllerState.createService;
    handleConversationBindingResolved = controllerState.handleConversationBindingResolved;
    handleInboundClaim = controllerState.handleInboundClaim;
    handleTelegramInteractive = controllerState.handleTelegramInteractive;
    handleDiscordInteractive = controllerState.handleDiscordInteractive;
    handleCommand = controllerState.handleCommand;
  },
}));

const { default: plugin } = await import("./index.js");

describe("plugin registration", () => {
  it("loads without the binding resolved hook on older OpenClaw cores", () => {
    const api = {
      registerService: vi.fn(),
      registerInteractiveHandler: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
    };

    expect(() => plugin.register(api as never)).not.toThrow();
    expect(api.registerService).toHaveBeenCalledTimes(1);
    expect(api.on).toHaveBeenCalledWith("inbound_claim", expect.any(Function));
    expect(api.registerInteractiveHandler).toHaveBeenCalledTimes(2);
    expect(api.registerCommand).toHaveBeenCalled();
    expect(api.registerCommand.mock.calls.map(([params]) => params.name)).toEqual([
      "cas_new",
      "cas_resume",
      "cas_detach",
      "cas_status",
      "cas_stop",
      "cas_steer",
      "cas_plan",
      "cas_review",
      "cas_compact",
      "cas_skills",
      "cas_experimental",
      "cas_mcp",
      "cas_fast",
      "cas_model",
      "cas_permissions",
      "cas_init",
      "cas_diff",
      "cas_rename",
    ]);
  });

  it("registers the binding resolved hook when available", () => {
    const api = {
      registerService: vi.fn(),
      registerInteractiveHandler: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn(),
      onConversationBindingResolved: vi.fn(),
    };

    plugin.register(api as never);

    expect(api.onConversationBindingResolved).toHaveBeenCalledTimes(1);
  });
});
