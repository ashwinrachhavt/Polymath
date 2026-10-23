import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  PROVIDER_TIERS,
  capabilityAllowed,
  effectiveCapabilities,
} from "@/domains/integrations/capabilities";
import { nextAlias } from "@/domains/integrations/alias";

/*
 * Fine-grained per-account switches (migration 0237): the tier stays the
 * ceiling, a switch only narrows one account's grant. These pin the two ways
 * the model can rot — a switch silently granting above the tier, and a label
 * drifting from the capability the gateway enforces — plus the auto-naming
 * that replaced the mandatory name field on Connect.
 */

describe("effectiveCapabilities", () => {
  it("is the tier's list when nothing is switched off", () => {
    expect(effectiveCapabilities("gmail", "read_only", [])).toEqual(["gmail.read", "gmail.thread.read"]);
  });

  it("drops the switched-off capability and keeps the rest", () => {
    expect(effectiveCapabilities("gmail", "read_only", ["gmail.thread.read"])).toEqual(["gmail.read"]);
  });

  it("a switch cannot grant above the tier", () => {
    // gmail.send is not in read_only; it cannot appear, whatever the list says.
    expect(effectiveCapabilities("gmail", "read_only", [])).not.toContain("gmail.send");
  });

  it("ignores switches for capabilities the tier does not have", () => {
    expect(effectiveCapabilities("gmail", "read_only", ["gmail.send"])).toEqual(["gmail.read", "gmail.thread.read"]);
  });
});

describe("capabilityAllowed", () => {
  it("denies a switched-off capability that the tier grants", () => {
    expect(capabilityAllowed("gmail", "read_only", ["gmail.thread.read"], "gmail.thread.read")).toBe(false);
    expect(capabilityAllowed("gmail", "read_only", ["gmail.thread.read"], "gmail.read")).toBe(true);
  });

  it("still denies above the tier", () => {
    expect(capabilityAllowed("gmail", "read_only", [], "gmail.send")).toBe(false);
    expect(capabilityAllowed("gmail", "read_send", [], "gmail.send")).toBe(true);
  });

  it("a switched-off proposal capability stays off on the higher tier", () => {
    expect(capabilityAllowed("gmail", "read_send", ["gmail.send"], "gmail.send")).toBe(false);
  });
});

describe("CAPABILITY_LABELS", () => {
  it("names every capability the gateway can route, in plain language", () => {
    for (const capability of Object.keys(CAPABILITIES) as Array<keyof typeof CAPABILITIES>) {
      const label = CAPABILITY_LABELS[capability];
      expect(label, capability).toBeDefined();
      expect(label.length, capability).toBeGreaterThan(0);
      // The id never leaks into the UI as its own label.
      expect(label, capability).not.toBe(capability);
    }
  });

  it("covers every capability every tier names", () => {
    for (const tiers of Object.values(PROVIDER_TIERS)) {
      for (const tier of tiers) {
        for (const capability of tier.capabilities) {
          expect(CAPABILITY_LABELS[capability], capability).toBeDefined();
        }
      }
    }
  });
});

describe("nextAlias", () => {
  it("uses the provider id when nothing is taken", () => {
    expect(nextAlias([], "gmail")).toBe("gmail");
  });

  it("picks the first free suffix, counting revoked aliases as taken", () => {
    expect(nextAlias(["gmail"], "gmail")).toBe("gmail-2");
    expect(nextAlias(["gmail", "gmail-2"], "gmail")).toBe("gmail-3");
  });

  it("fills a gap left by a renamed account", () => {
    expect(nextAlias(["gmail-2"], "gmail")).toBe("gmail");
  });

  it("does not collide with another provider's alias", () => {
    expect(nextAlias(["gmail"], "slack")).toBe("slack");
  });
});
