import { describe, expect, it } from "vitest";
import { noteCommentBody } from "@/domains/knowledge/note-comments";

/*
 * The composer's one rule: whitespace is not a comment, and 2000 characters
 * is the ceiling. Everything else about a comment is behavior, and behavior
 * is covered by the integration suite against real Postgres.
 */
describe("noteCommentBody", () => {
  it("trims surrounding whitespace and keeps interior text", () => {
    expect(noteCommentBody.parse("  Expand the rollout section.  ")).toBe("Expand the rollout section.");
  });

  it("refuses blank input after trimming", () => {
    expect(noteCommentBody.safeParse("   ").success).toBe(false);
    expect(noteCommentBody.safeParse("").success).toBe(false);
  });

  it("holds up to 2000 characters and refuses more", () => {
    expect(noteCommentBody.safeParse("x".repeat(2000)).success).toBe(true);
    expect(noteCommentBody.safeParse("x".repeat(2001)).success).toBe(false);
  });
});
