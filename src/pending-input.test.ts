import { describe, expect, it } from "vitest";
import {
  addQuestionnaireResponseNote,
  buildPendingQuestionnaireResponse,
  buildPendingPromptText,
  buildPendingUserInputActions,
  createPendingInputState,
  formatPendingQuestionnairePrompt,
  parseCodexUserInput,
  parsePendingQuestionnaire,
  questionnaireCurrentQuestionHasAnswer,
  questionnaireIsComplete,
  requestToken,
  stripShellLauncher,
  extractCommandFromActions,
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

  it("defaults file change approvals to approve and decline actions", () => {
    const actions = buildPendingUserInputActions({
      method: "item/fileChange/requestApproval",
      requestParams: {
        threadId: "019cd368-7eda-7863-86ba-6586598bc5a3",
        turnId: "turn-1",
        itemId: "item-1",
      },
    });
    expect(actions.map((action) => action.label)).toEqual([
      "Approve File Changes",
      "Decline",
      "Tell Codex What To Do",
    ]);
  });

  it("does not treat ids as shell commands for file change approvals", () => {
    const text = buildPendingPromptText({
      method: "item/fileChange/requestApproval",
      requestId: "req-file-1",
      requestParams: {
        threadId: "019cd368-7eda-7863-86ba-6586598bc5a3",
        turnId: "turn-1",
        itemId: "item-1",
        reason: "Codex wants to apply the proposed patch.",
      },
      options: [],
      actions: buildPendingUserInputActions({
        method: "item/fileChange/requestApproval",
        requestParams: {
          threadId: "019cd368-7eda-7863-86ba-6586598bc5a3",
          turnId: "turn-1",
          itemId: "item-1",
          reason: "Codex wants to apply the proposed patch.",
        },
      }),
      expiresAt: Date.now() + 60_000,
    });

    expect(text).toContain("Codex file change approval requested");
    expect(text).toContain("Codex wants to apply the proposed patch.");
    expect(text).not.toContain("Command:");
    expect(text).not.toContain("019cd368-7eda-7863-86ba-6586598bc5a3");
  });

  it("lists changed files for file change approvals", () => {
    const text = buildPendingPromptText({
      method: "item/fileChange/requestApproval",
      requestId: "req-file-2",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        filePaths: ["src/app.ts", "README.md", "/tmp/outside.txt"],
      },
      options: [],
      actions: buildPendingUserInputActions({
        method: "item/fileChange/requestApproval",
        requestParams: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
        },
      }),
      expiresAt: Date.now() + 60_000,
    });

    expect(text).toContain("Files:");
    expect(text).toContain("`src/app.ts`");
    expect(text).toContain("`README.md`");
    expect(text).toContain("`/tmp/outside.txt`");
  });

  it("includes writable-root context for file change approvals that request broader access", () => {
    const text = buildPendingPromptText({
      method: "item/fileChange/requestApproval",
      requestId: "req-file-3",
      requestParams: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        reason: "Codex needs write access outside the workspace.",
        grantRoot: "/Users/huntharo/github/codex",
      },
      options: [],
      actions: buildPendingUserInputActions({
        method: "item/fileChange/requestApproval",
        requestParams: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
        },
      }),
      expiresAt: Date.now() + 60_000,
    });

    expect(text).toContain("Codex file change approval requested");
    expect(text).toContain("Codex needs write access outside the workspace.");
    expect(text).toContain("Requested writable root: `/Users/huntharo/github/codex`");
    expect(text).not.toContain("Command:");
  });

  it("uses explicit approval decision labels when command approvals provide them", () => {
    const actions = buildPendingUserInputActions({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        availableDecisions: [
          { decision: "accept", label: "Allow once" },
          {
            decision: "acceptForSession",
            label: "Always allow `pnpm typecheck`",
            proposedExecpolicyAmendment: { prefix: ["pnpm", "typecheck"] },
          },
          { decision: "decline", label: "Deny" },
        ],
      },
    });

    expect(actions.map((action) => action.label)).toEqual([
      "Allow once",
      "Always allow `pnpm typecheck`",
      "Deny",
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

  it("truncates oversized pending request prompts for chat delivery", () => {
    const text = buildPendingPromptText({
      method: "item/tool/requestUserInput",
      requestId: "req-2",
      requestParams: {
        prompt: "A".repeat(5000),
      },
      options: ["A", "B"],
      actions: [],
      expiresAt: Date.now() + 60_000,
    });
    expect(text.length).toBeLessThan(2400);
    expect(text).toContain("[Request details truncated.");
  });

  it("parses multi-question plan prompts into a questionnaire state", () => {
    const questionnaire = parsePendingQuestionnaire(`
1. What do you want the final artifact to be?

• A Single static binary
• B Normal runtime-managed CLI

Guidance:
• A points toward Go or Rust.

2. What do you care about more: delivery speed or long-term rigor?

• A Fastest rewrite
• B Balanced
    `);

    expect(questionnaire?.questions).toHaveLength(2);
    expect(questionnaire?.questions[0]).toMatchObject({
      id: "q1",
      prompt: "What do you want the final artifact to be?",
      options: [
        { key: "A", label: "Single static binary" },
        { key: "B", label: "Normal runtime-managed CLI" },
      ],
    });
    expect(formatPendingQuestionnairePrompt(questionnaire!)).toContain("Codex plan question 1 of 2");
  });

  it("renders a compact questionnaire reply once all answers are filled in", () => {
    const questionnaire = parsePendingQuestionnaire(`
1. What do you want the final artifact to be?
• A Single static binary
• B Normal runtime-managed CLI

2. What do you care about more?
• A Fastest rewrite
• B Balanced
    `)!;
    questionnaire.answers[0] = {
      kind: "option",
      optionKey: "A",
      optionLabel: "Single static binary",
    };
    questionnaire.answers[1] = {
      kind: "text",
      text: "Balanced, but only if we keep the migration simple.",
    };
    expect(questionnaireIsComplete(questionnaire)).toBe(true);
    expect(buildPendingQuestionnaireResponse(questionnaire)).toBe(
      "1A 2: Balanced, but only if we keep the migration simple.",
    );
  });

  it("adds a user note to the first structured questionnaire answer", () => {
    const response = addQuestionnaireResponseNote(
      {
        answers: {
          runtime: { answers: ["Long-lived service (Recommended)"] },
          db: { answers: ["Postgres (Recommended)"] },
        },
      },
      "This answer was selected by the user in chat after 52 minutes; it was not auto-selected.",
    );

    expect(response).toEqual({
      answers: {
        runtime: {
          answers: [
            "Long-lived service (Recommended)",
            "user_note: This answer was selected by the user in chat after 52 minutes; it was not auto-selected.",
          ],
        },
        db: { answers: ["Postgres (Recommended)"] },
      },
    });
  });

  it("leaves compact questionnaire replies unchanged when adding a note", () => {
    expect(
      addQuestionnaireResponseNote("1A 2B", "This answer was selected by the user in chat."),
    ).toBe("1A 2B");
  });

  it("requires an answer before advancing to the next questionnaire question", () => {
    const questionnaire = parsePendingQuestionnaire(`
1. What do you want the final artifact to be?
• A Single static binary
• B Normal runtime-managed CLI

2. What do you care about more?
• A Fastest rewrite
• B Balanced
    `)!;

    expect(questionnaireCurrentQuestionHasAnswer(questionnaire)).toBe(false);

    questionnaire.answers[0] = {
      kind: "option",
      optionKey: "A",
      optionLabel: "Single static binary",
    };

    expect(questionnaireCurrentQuestionHasAnswer(questionnaire)).toBe(true);
  });

  it("strips shell launcher wrappers from commands for display", () => {
    expect(stripShellLauncher("/bin/zsh -lc 'git status'")).toBe("git status");
    expect(stripShellLauncher("/bin/bash -lc 'npm install'")).toBe("npm install");
    expect(stripShellLauncher("bash -lc 'make build'")).toBe("make build");
    expect(
      stripShellLauncher('zsh -lc \'git add README.md && git commit -m "docs: update"\''),
    ).toBe('git add README.md && git commit -m "docs: update"');
    expect(stripShellLauncher("/usr/bin/zsh -lc 'cargo test'")).toBe("cargo test");
    // Non-launcher commands pass through unchanged
    expect(stripShellLauncher("git status")).toBe("git status");
    expect(stripShellLauncher("npm install")).toBe("npm install");
  });

  it("extracts display command from commandActions array", () => {
    // Single action with type "unknown"
    expect(
      extractCommandFromActions({
        commandActions: [{ type: "unknown", command: "git status" }],
      }),
    ).toBe("git status");

    // Single action with type "read"
    expect(
      extractCommandFromActions({
        commandActions: [{ type: "read", command: "cat README.md", name: "README.md", path: "README.md" }],
      }),
    ).toBe("cat README.md");

    // Multiple actions joined with &&
    expect(
      extractCommandFromActions({
        commandActions: [
          { type: "unknown", command: "git add README.md" },
          { type: "unknown", command: 'git commit -m "docs: update"' },
        ],
      }),
    ).toBe('git add README.md && git commit -m "docs: update"');

    // Empty array returns undefined
    expect(extractCommandFromActions({ commandActions: [] })).toBeUndefined();

    // Missing commandActions returns undefined
    expect(extractCommandFromActions({ command: "/bin/zsh -lc 'git status'" })).toBeUndefined();

    // null/undefined params
    expect(extractCommandFromActions(null)).toBeUndefined();
    expect(extractCommandFromActions(undefined)).toBeUndefined();

    // Actions with missing command field are filtered out
    expect(
      extractCommandFromActions({
        commandActions: [{ type: "unknown" }, { type: "read", command: "cat foo.txt", name: "foo.txt", path: "foo.txt" }],
      }),
    ).toBe("cat foo.txt");

    // All actions missing command field returns undefined
    expect(
      extractCommandFromActions({
        commandActions: [{ type: "unknown" }],
      }),
    ).toBeUndefined();
  });

  it("parses structured request_user_input questions into questionnaire state", () => {
    const state = createPendingInputState({
      method: "item/tool/requestUserInput",
      requestId: "req-3",
      requestParams: {
        questions: [
          {
            id: "runtime",
            header: "Runtime",
            question: "Which runtime shape should we optimize for?",
            isOther: true,
            options: [
              {
                label: "Long-lived service (Recommended)",
                description: "Best fit for stateful flows.",
              },
              {
                label: "Mostly serverless",
                description: "Best fit for stateless handlers.",
              },
            ],
          },
          {
            id: "db",
            header: "DB",
            question: "What kind of database migration do you want from SQLite?",
            options: [{ label: "Postgres (Recommended)" }, { label: "Firestore" }],
          },
        ],
      },
      options: [],
      expiresAt: Date.now() + 60_000,
    });

    expect(state.questionnaire?.questions).toHaveLength(2);
    expect(state.questionnaire?.questions[0]).toMatchObject({
      id: "runtime",
      header: "Runtime",
      prompt: "Which runtime shape should we optimize for?",
      allowFreeform: true,
      options: [
        {
          key: "A",
          label: "Long-lived service (Recommended)",
          description: "Best fit for stateful flows.",
          recommended: true,
        },
        {
          key: "B",
          label: "Mostly serverless",
          description: "Best fit for stateless handlers.",
          recommended: false,
        },
      ],
    });
    expect(formatPendingQuestionnairePrompt(state.questionnaire!)).toContain(
      "Runtime: Which runtime shape should we optimize for?",
    );
    expect(formatPendingQuestionnairePrompt(state.questionnaire!)).toContain(
      "Other: You can reply with free text.",
    );
    state.questionnaire!.answers[0] = {
      kind: "option",
      optionKey: "A",
      optionLabel: "Long-lived service (Recommended)",
    };
    state.questionnaire!.answers[1] = {
      kind: "option",
      optionKey: "A",
      optionLabel: "Postgres (Recommended)",
    };
    expect(buildPendingQuestionnaireResponse(state.questionnaire!)).toEqual({
      answers: {
        runtime: { answers: ["Long-lived service (Recommended)"] },
        db: { answers: ["Postgres (Recommended)"] },
      },
    });
  });
});
