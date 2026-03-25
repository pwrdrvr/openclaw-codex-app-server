import { describe, expect, it } from "vitest";
import {
  getProjectName,
  listProjects,
  paginateItems,
} from "./thread-picker.js";

describe("thread picker helpers", () => {
  it("derives the project name from a worktree path", () => {
    expect(getProjectName("/workspace/.codex/worktrees/cb00/openclaw")).toBe("openclaw");
  });

  it("groups multiple worktrees under the same project name", () => {
    expect(
      listProjects([
        {
          threadId: "1",
          title: "One",
          projectKey: "/workspace/.codex/worktrees/cb00/openclaw",
          updatedAt: 10,
        },
        {
          threadId: "2",
          title: "Two",
          projectKey: "/workspace/.codex/worktrees/cb01/openclaw",
          updatedAt: 20,
        },
        {
          threadId: "3",
          title: "Three",
          projectKey: "/workspace/gitcrawl",
          updatedAt: 5,
        },
      ]),
    ).toEqual([
      { name: "openclaw", threadCount: 2, latestUpdatedAt: 20 },
      { name: "gitcrawl", threadCount: 1, latestUpdatedAt: 5 },
    ]);
  });

  it("paginates thread pickers without skipping items", () => {
    const page = paginateItems(["a", "b", "c", "d", "e"], 1, 2);
    expect(page.items).toEqual(["c", "d"]);
    expect(page.page).toBe(1);
    expect(page.totalPages).toBe(3);
  });
});
