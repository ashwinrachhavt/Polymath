import { describe, expect, it } from "vitest";
import { messageIdeaTitle } from "@/domains/knowledge/save-message";

describe("messageIdeaTitle", () => {
  it("uses the first sentence of the message, capped at 120 characters", () => {
    expect(
      messageIdeaTitle("Retries are safe only when duplicate effects are controlled. Everything else is hope."),
    ).toBe("Retries are safe only when duplicate effects are controlled.");
  });
  it("falls back to a fixed title for a message with no sentence", () => {
    expect(messageIdeaTitle("   ")).toBe("Saved idea");
  });
  it("caps a long first sentence", () => {
    expect(messageIdeaTitle("x".repeat(400))).toHaveLength(120);
  });
});
