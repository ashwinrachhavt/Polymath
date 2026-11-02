import { describe, expect, it } from "vitest";
import { threadBlocks } from "@/domains/agents/stream-contract";

describe("threadBlocks message ids", () => {
  it("copies the stored message id onto its block", () => {
    const blocks = threadBlocks([{ sequence: 1, role: "assistant", text: "Hi", turnId: "t1", messageId: "m1" }]);
    expect(blocks[0].messageId).toBe("m1");
  });
  it("leaves it null when the run has no mirrored message", () => {
    const blocks = threadBlocks([{ sequence: 1, role: "user", text: "Q", messageId: null }]);
    expect(blocks[0].messageId).toBeNull();
  });
});
