import { describe, expect, it } from "vitest";
import { AgentPrincipalError, validatePrincipalKey } from "@/domains/agents/principals";

/*
 * GA01 key discipline, DB-free: a principal key is the immutable machine
 * identity every grant and audit row references, so its shape rule lives in
 * one exported validator and gets direct coverage.
 */
describe("validatePrincipalKey", () => {
  it("accepts lowercase machine keys and trims whitespace", () => {
    expect(validatePrincipalKey("alfred")).toBe("alfred");
    expect(validatePrincipalKey("  nightly_briefing_2 ")).toBe("nightly_briefing_2");
  });
  it("rejects empty, uppercase-led, symbol and overlong keys", () => {
    for (const key of ["", "Alfred", "_alfred", "al fred", "al-fred", `a${"b".repeat(50)}`]) {
      expect(() => validatePrincipalKey(key)).toThrow(AgentPrincipalError);
    }
  });
});
