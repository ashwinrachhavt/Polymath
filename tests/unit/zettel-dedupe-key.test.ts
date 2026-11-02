import { describe, expect, it } from "vitest";
import { zettelDedupeKey } from "@/domains/knowledge/zettels";

describe("zettelDedupeKey", () => {
  it("names the document path", () => {
    expect(zettelDedupeKey("doc", "d1", 0, 20)).toBe("zettel:doc:d1:0-20");
  });
  it("names the artifact path", () => {
    expect(zettelDedupeKey("artifact", "a1", 40, 90)).toBe("zettel:artifact:a1:40-90");
  });
});
