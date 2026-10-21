import { describe, expect, it } from "vitest";
import { makePending, stillPending } from "@/components/chat/pending-messages";

describe("pending chat messages", () => {
  it("stays pending until the server echoes the text", () => {
    const p = makePending("1", "hello", []);
    expect(stillPending([p], [])).toHaveLength(1);
    expect(stillPending([p], ["hello"])).toHaveLength(0);
  });

  it("does not treat an earlier identical question as the echo", () => {
    const p = makePending("2", "again", ["again"]);
    expect(stillPending([p], ["again"])).toHaveLength(1);
    expect(stillPending([p], ["again", "again"])).toHaveLength(0);
  });

  it("matches two quick identical sends to two echoes in order", () => {
    const first = makePending("a", "same", []);
    const second = makePending("b", "same", []);
    expect(stillPending([first, second], ["same"]).map((x) => x.id)).toEqual(["b"]);
    expect(stillPending([first, second], ["same", "same"])).toHaveLength(0);
  });
});
