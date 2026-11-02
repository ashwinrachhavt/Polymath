import { describe, expect, it } from "vitest";
import tool from "../../eve/polymath/agent/tools/documents_search";

describe("documents_search description", () => {
  it("tells the model that an empty result means nothing matched", () => {
    expect(tool.description).toMatch(/empty results/i);
    expect(tool.description).toMatch(/nothing .*matched|no relevant/i);
  });
});
