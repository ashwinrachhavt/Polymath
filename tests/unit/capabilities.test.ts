import { describe, expect, it } from "vitest";
import { CAPABILITIES, CAPABILITY_CATALOG_VERSION, FIXED_ROLE_CAPABILITIES, validateRoleCapabilities } from "@/domains/identity/capabilities";

/*
 * ASH-121 AC03: the catalog is the boundary custom roles cannot cross. These
 * tests pin that validation is deterministic and that the fixed-role
 * projection stays a strict subset ladder - a regression here would let a
 * custom role invent a permission.
 */

describe("capability catalog", () => {
  it("has a version and unique entries", () => {
    expect(CAPABILITY_CATALOG_VERSION).toBe(1);
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
  });

  it("covers the families AC03 names", () => {
    const joined = CAPABILITIES.join(" ");
    for (const family of ["person.", "document.", "member.", "role.", "integration.", "agent.", "action.", "billing.", "audit.", "ownership."]) {
      expect(joined).toContain(family);
    }
    // Approval is deliberately separate from preparation and execution.
    expect(CAPABILITIES).toContain("action.approve");
    expect(CAPABILITIES).toContain("action.prepare");
    expect(CAPABILITIES).toContain("action.execute");
  });
});

describe("validateRoleCapabilities", () => {
  it("accepts catalog capabilities, deduped", () => {
    const result = validateRoleCapabilities(["person.read", "person.read", " audit.read "]);
    expect(result).toEqual({ ok: true, capabilities: ["person.read", "audit.read"] });
  });

  it("rejects invented capabilities by name", () => {
    const result = validateRoleCapabilities(["person.read", "person.annihilate"]);
    expect(result).toEqual({ ok: false, invalid: ["person.annihilate"] });
  });

  it("rejects an empty role instead of granting nothing silently", () => {
    expect(validateRoleCapabilities([]).ok).toBe(false);
  });
});

describe("fixed-role projection", () => {
  it("is a strict ladder: viewer < member < admin < owner", () => {
    const tiers = ["viewer", "member", "admin", "owner"] as const;
    for (let i = 1; i < tiers.length; i += 1) {
      const lower = new Set(FIXED_ROLE_CAPABILITIES[tiers[i - 1]]);
      const upper = new Set(FIXED_ROLE_CAPABILITIES[tiers[i]]);
      for (const cap of lower) expect(upper.has(cap)).toBe(true);
      expect(upper.size).toBeGreaterThan(lower.size);
    }
  });

  it("keeps ownership transfer and role definition owner-only", () => {
    for (const role of ["viewer", "member", "admin"] as const) {
      expect(FIXED_ROLE_CAPABILITIES[role]).not.toContain("ownership.transfer");
      expect(FIXED_ROLE_CAPABILITIES[role]).not.toContain("role.define");
    }
  });

  it("projects only real catalog entries", () => {
    const known = new Set<string>(CAPABILITIES);
    for (const caps of Object.values(FIXED_ROLE_CAPABILITIES)) {
      for (const cap of caps) expect(known.has(cap)).toBe(true);
    }
  });
});
