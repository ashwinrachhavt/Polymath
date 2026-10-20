import { describe, expect, it } from "vitest";
import { capabilityFamily, diffRoleCapabilities, previewRoleChange } from "@/domains/identity/role-preview";

/* ASH-121 AC03: the preview tells the administrator exactly what changes. */
describe("diffRoleCapabilities", () => {
  it("names grants and revocations exactly", () => {
    const diff = diffRoleCapabilities(["person.read", "audit.read"], ["person.read", "billing.read"]);
    expect(diff.granted).toEqual(["billing.read"]);
    expect(diff.revoked).toEqual(["audit.read"]);
  });

  it("an unchanged set diffs to nothing", () => {
    const diff = diffRoleCapabilities(["person.read"], ["person.read"]);
    expect(diff.granted).toEqual([]);
    expect(diff.revoked).toEqual([]);
  });
});

describe("previewRoleChange", () => {
  it("compares a fixed role against a proposed set, in product language", () => {
    const preview = previewRoleChange({ role: "viewer" }, ["person.read", "document.read", "task.read", "knowledge.read", "member.read", "role.read", "integration.use", "audit.read", "billing.manage"]);
    expect(preview.granted).toEqual(["billing.manage"]);
    expect(preview.revoked).toEqual([]);
    expect(preview.surfacesOpened).toEqual(["Billing administration"]);
    expect(preview.surfacesClosed).toEqual([]);
  });

  it("names a closed surface when the last capability of a family is revoked", () => {
    const preview = previewRoleChange({ role: "viewer" }, ["document.read"]);
    expect(preview.surfacesClosed).toContain("People and company records");
    expect(preview.surfacesClosed).toContain("Audit history");
    expect(preview.surfacesOpened).toEqual([]);
  });

  it("rejects invented capabilities instead of previewing them", () => {
    expect(() => previewRoleChange({ role: "viewer" }, ["person.annihilate"])).toThrow("unknown: person.annihilate");
  });

  it("capabilityFamily splits on the first dot", () => {
    expect(capabilityFamily("ownership.transfer")).toBe("ownership");
  });
});
