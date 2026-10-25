import { describe, expect, it } from "vitest";
import { accessToggleState, planToggleSteps } from "@/domains/integrations/access-toggles";

/*
 * The two-switch mapping is the owner-facing contract over the tier catalog:
 * these tests are the spec the component and the enforcement model must agree
 * on. The tier stays the ceiling; a switch can only narrow it.
 */
describe("accessToggleState", () => {
  it("gmail read+send tier shows both switches on", () => {
    const s = accessToggleState("gmail", "read_send", []);
    expect(s.read).toEqual({ available: true, on: true });
    expect(s.write).toEqual({ available: true, on: true, label: "Send" });
  });

  it("a switched-off read capability shows read off", () => {
    const s = accessToggleState("gmail", "read_send", ["gmail.read"]);
    expect(s.read.on).toBe(false);
  });

  it("a read-only provider has no write switch", () => {
    const s = accessToggleState("slack", "read_only", []);
    expect(s.write).toBeNull();
    expect(s.read.on).toBe(true);
  });

  it("an unknown tier reads as read-off, write-off", () => {
    const s = accessToggleState("gmail", null, []);
    expect(s.read.on).toBe(false);
    expect(s.write?.on ?? false).toBe(false);
  });

  it("read on for a tier-less account plans a tier raise first", () => {
    const steps = planToggleSteps({ provider: "gmail", currentTier: null, disabled: [], toggle: "read", on: true });
    expect(steps).toEqual([{ kind: "tier", tierId: "read_only", expectedVersion: 0 }]);
  });

  it("read on for a tier-less account with disabled reads re-enables them after the raise", () => {
    const steps = planToggleSteps({ provider: "gmail", currentTier: null, disabled: ["gmail.read"], toggle: "read", on: true });
    expect(steps).toEqual([
      { kind: "tier", tierId: "read_only", expectedVersion: 0 },
      { kind: "capability", capability: "gmail.read", expectedVersion: 1, enabled: true },
    ]);
  });

  it("read on for a tier-less account with nothing disabled is just the tier raise", () => {
    const steps = planToggleSteps({ provider: "gmail", currentTier: null, disabled: [], toggle: "read", on: true });
    expect(steps).toEqual([{ kind: "tier", tierId: "read_only", expectedVersion: 0 }]);
  });

  it("read off plans disables only for the reads the tier grants that are still on", () => {
    const steps = planToggleSteps({ provider: "gmail", currentTier: "read_send", disabled: [], toggle: "read", on: false });
    expect(steps).toEqual([
      { kind: "capability", capability: "gmail.read", expectedVersion: 0, enabled: false },
      { kind: "capability", capability: "gmail.thread.read", expectedVersion: 1, enabled: false },
    ]);
  });

  it("write on from below the write tier raises the tier, then clears the disable", () => {
    const steps = planToggleSteps({ provider: "gmail", currentTier: "read_only", disabled: ["gmail.send"], toggle: "write", on: true });
    expect(steps).toEqual([
      { kind: "tier", tierId: "read_send", expectedVersion: 0 },
      { kind: "capability", capability: "gmail.send", expectedVersion: 1, enabled: true },
    ]);
  });

  it("write on when already on the write tier skips the tier bump", () => {
    const steps = planToggleSteps({ provider: "gmail", currentTier: "read_send", disabled: ["gmail.send"], toggle: "write", on: true });
    expect(steps).toEqual([{ kind: "capability", capability: "gmail.send", expectedVersion: 0, enabled: true }]);
  });

  it("write on for a tier-less account raises to the write tier first", () => {
    const steps = planToggleSteps({ provider: "gmail", currentTier: null, disabled: ["gmail.send"], toggle: "write", on: true });
    expect(steps).toEqual([
      { kind: "tier", tierId: "read_send", expectedVersion: 0 },
      { kind: "capability", capability: "gmail.send", expectedVersion: 1, enabled: true },
    ]);
  });

  it("read off for a tier-less account plans nothing", () => {
    const steps = planToggleSteps({ provider: "gmail", currentTier: null, disabled: [], toggle: "read", on: false });
    expect(steps).toEqual([]);
  });

  it("read on for an unknown tier id behaves like a tier-less account", () => {
    const steps = planToggleSteps({ provider: "gmail", currentTier: "nonexistent", disabled: [], toggle: "read", on: true });
    expect(steps).toEqual([{ kind: "tier", tierId: "read_only", expectedVersion: 0 }]);
  });
});
