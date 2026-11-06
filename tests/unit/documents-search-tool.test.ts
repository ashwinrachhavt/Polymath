import { describe, expect, it } from "vitest";
import tool from "../../eve/polymath/agent/tools/documents_search";

describe("documents_search description", () => {
  it("tells the model an empty result is a retrieval miss, not proof the library holds nothing (issue #533 finding 7)", () => {
    expect(tool.description).toMatch(/empty results mean no indexed extraction matched/i);
    expect(tool.description).toMatch(/retrieval miss/i);
    // The repaired description must NOT equate empty with "nothing relevant
    // exists" without the degraded/indexing qualifiers.
    expect(tool.description).not.toMatch(/Empty results mean nothing matched/);
  });
  it("scopes coverage truthfully: document extractions, not notes or captured sources (finding 7)", () => {
    expect(tool.description).toMatch(/extracted text/i);
    expect(tool.description).toMatch(/notes and captured sources are NOT covered/i);
  });
});
