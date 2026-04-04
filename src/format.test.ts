import { describe, expect, it } from "vitest";
import { formatThreadButtonLabel, formatThreadPicker } from "./format.js";

describe("thread title fallbacks", () => {
  it("uses thread summary for button labels when title is missing", () => {
    const label = formatThreadButtonLabel({
      thread: {
        threadId: "019d527d-6d72-7f11-81bb-2c2351705e10",
        summary: "本项目最近一次提交的摘要",
      },
      includeProjectSuffix: false,
    });

    expect(label).toContain("本项目最近一次提交的摘要");
    expect(label).not.toContain("019d527d-6d72-7f11-81bb-2c2351705e10");
  });

  it("uses thread summary in plain-text picker rows when title is missing", () => {
    const text = formatThreadPicker([
      {
        threadId: "019d5133-b02c-73f1-8574-5ddad7f8d0a5",
        summary: "检查 MCP 状态与 skill",
      },
    ]);

    expect(text).toContain("1. 检查 MCP 状态与 skill");
    expect(text).not.toContain("1. 019d5133-b02c-73f1-8574-5ddad7f8d0a5");
  });
});
