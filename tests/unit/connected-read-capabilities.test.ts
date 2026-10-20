import { describe, expect, it } from "vitest";
import { CAPABILITY_RISK, approvalForRisk } from "../../eve/alfred/evals/axiom-policy";
import { AVAILABLE_READ_TOOL } from "../../eve/alfred/agent/tools/connected_read";

/*
 * The capability table is the boundary between "a tool exists" and "a run may
 * use it". A tool whose capability is missing from the table has no risk class,
 * so the approval classifier can never clear it and the run can never be
 * granted it — the tool looks shipped but is permanently dead. This test pins
 * that the read tool's providers all resolve to a risk class.
 */

describe("connected_read capability coverage", () => {
  it("every read provider maps to a capability the risk table knows", () => {
    const capabilities = Object.values(AVAILABLE_READ_TOOL);
    expect(capabilities.length).toBeGreaterThan(0);
    for (const capability of capabilities) {
      expect(CAPABILITY_RISK[capability]).toBe("read");
    }
  });

  it("a read capability is cleared without a person", () => {
    for (const capability of Object.values(AVAILABLE_READ_TOOL)) {
      const risk = CAPABILITY_RISK[capability];
      expect(risk).toBeDefined();
      expect(approvalForRisk(risk)).toBe("approved");
    }
  });
});
