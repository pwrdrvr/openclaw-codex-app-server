import { describe, expect, it } from "vitest";
import {
  buildPendingUserInputActions,
  createPendingInputState,
  parseCodexUserInput,
  requestToken,
} from "./pending-input.js";

describe("pending-input helpers", () => {
  it("parses numeric option replies", () => {
    expect(parseCodexUserInput("2", 3)).toEqual({ kind: "option", index: 1 });
    expect(parseCodexUserInput("option 1", 3)).toEqual({ kind: "option", index: 0 });
    expect(parseCodexUserInput("hello", 3)).toEqual({ kind: "text", text: "hello" });
  });

  it("builds approval actions from request decisions", () => {
    const actions = buildPendingUserInputActions({
      method: "turn/requestApproval",
      requestParams: {
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
    });
    expect(actions.map((action) => action.label)).toEqual([
      "Approve Once",
      "Approve for Session",
      "Decline",
      "Cancel",
      "Tell Codex What To Do",
    ]);
  });

  it("creates a stable request token", () => {
    expect(requestToken("abc")).toBe(requestToken("abc"));
    expect(requestToken("abc")).not.toBe(requestToken("def"));
  });

  it("creates a prompt text for pending input", () => {
    const state = createPendingInputState({
      method: "item/tool/requestUserInput",
      requestId: "req-1",
      requestParams: {
        question: "Pick one",
      },
      options: ["A", "B"],
      expiresAt: Date.now() + 60_000,
    });
    expect(state.promptText).toContain("Codex input requested");
    expect(state.promptText).toContain("Choices:");
  });
});
