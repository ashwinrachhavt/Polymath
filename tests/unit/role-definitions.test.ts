import { describe, expect, it } from "vitest";
import { RoleDefinitionError, validateRoleKey } from "@/domains/identity/roles";

/* ASH-121 AC03: role keys are the immutable identity of a definition. */
describe("validateRoleKey", () => {
  it("accepts lowercase snake keys and trims", () => {
    expect(validateRoleKey(" billing_clerk ")).toBe("billing_clerk");
    expect(validateRoleKey("a")).toBe("a");
  });

  it("rejects shapes that would be unstable or ambiguous", () => {
    for (const bad of ["", " ", "Billing Clerk", "1st_role", "-lead", "x".repeat(51), "has.dot"]) {
      expect(() => validateRoleKey(bad)).toThrow(RoleDefinitionError);
    }
  });
});
