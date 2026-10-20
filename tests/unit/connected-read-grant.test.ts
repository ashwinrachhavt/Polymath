import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWED_TOOLS } from "@/domains/agents/commands";
import { AVAILABLE_READ_TOOL } from "../../eve/alfred/agent/tools/connected_read";
import { CAPABILITY_RISK } from "../../eve/alfred/evals/axiom-policy";

/*
 * The two halves of a capability have to meet.
 *
 * A tool checks its capability against the run's frozen policy snapshot, which
 * is copied from the profile's `allowedTools`. So a capability that is in the
 * risk table (it has a class and can be classified) but missing from
 * DEFAULT_ALLOWED_TOOLS is never granted: the tool exists, is visible to the
 * model, and fails closed on every call. That is exactly what shipped for the
 * connected reads until this test was added — the capability was classified
 * `read` and the tool was written, but no profile could ever allow it.
 *
 * This pins the pairing rather than either list, so adding a tool without
 * granting it fails here instead of in production.
 */

describe("connected read capabilities are reachable", () => {
  const capabilities = Object.values(AVAILABLE_READ_TOOL);

  it("has at least one connected read capability", () => {
    expect(capabilities.length).toBeGreaterThan(0);
  });

  it("grants every connected read capability by default", () => {
    for (const capability of capabilities) {
      expect(DEFAULT_ALLOWED_TOOLS, `${capability} must be in DEFAULT_ALLOWED_TOOLS`).toContain(capability);
    }
  });

  it("classifies every connected read capability as a read", () => {
    for (const capability of capabilities) {
      expect(CAPABILITY_RISK[capability], `${capability} must be in the risk table`).toBe("read");
    }
  });

  it("does not default-grant a write capability", () => {
    // The paired risk: widening the default list must not quietly grant writes.
    const writes = DEFAULT_ALLOWED_TOOLS.filter((capability) => {
      const risk = CAPABILITY_RISK[capability];
      return risk === "external_write" || risk === "sensitive_write" || risk === "prohibited";
    });
    // gmail.send is deliberately default-granted because the tool only ever
    // records a proposal; nothing is sent. Anything else here is a mistake.
    expect(writes).toEqual(["gmail.send"]);
  });
});
