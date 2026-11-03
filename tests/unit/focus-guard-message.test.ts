import { describe, expect, it } from "vitest";

import { deepFocusGuardMessage } from "@/domains/focus/commands";

/*
 * Value card:
 * - protects: §1's early-finish guard sentence reads correctly for every
 *   plan length a person can pick.
 * - fails_when: a one-minute plan renders "the full 1 minutes" (the reported
 *   defect), or a one-minute remainder renders "1 minutes".
 * - why_new: the drive caught the singular case pluralizing wrong; the inline
 *   template had one pluralizer for two counts.
 * - seam: the guard message builder (pure).
 * - no_claim: does not claim on guard semantics (when the guard fires) -
 *   the transition guard's conditions live in the command layer and the
 *   e2e spec owns the visible path.
 */
describe("deepFocusGuardMessage", () => {
  it("singularizes both counts", () => {
    expect(deepFocusGuardMessage(1, 1)).toBe("Deep focus holds for the full 1 minute - about 1 minute left.");
  });

  it("pluralizes both counts", () => {
    expect(deepFocusGuardMessage(5, 3)).toBe("Deep focus holds for the full 5 minutes - about 3 minutes left.");
  });

  it("mixes a plural plan with a singular remainder", () => {
    expect(deepFocusGuardMessage(25, 1)).toBe("Deep focus holds for the full 25 minutes - about 1 minute left.");
  });
});
