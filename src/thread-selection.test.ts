import { describe, expect, it } from "vitest";
import { parseThreadSelectionArgs } from "./thread-selection.js";

describe("parseThreadSelectionArgs", () => {
  it("normalizes angle-bracket thread ids", () => {
    const parsed = parseThreadSelectionArgs("<019d5133-b02c-73f1-8574-5ddad7f8d0a5>");
    expect(parsed.query).toBe("019d5133-b02c-73f1-8574-5ddad7f8d0a5");
  });

  it("normalizes labeled thread ids wrapped in angle brackets", () => {
    const parsed = parseThreadSelectionArgs("<id: 019d5134-da1d-7301-a247-f3b6fa97f30a>");
    expect(parsed.query).toBe("019d5134-da1d-7301-a247-f3b6fa97f30a");
  });

  it("keeps normal free-text filters unchanged", () => {
    const parsed = parseThreadSelectionArgs("release rollback plan");
    expect(parsed.query).toBe("release rollback plan");
  });
});
