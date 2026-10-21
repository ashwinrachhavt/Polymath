import { describe, expect, it } from "vitest";
import { isCategory } from "@/domains/knowledge/transaction-rules";
import { CATEGORY_CRITERIA } from "@/domains/knowledge/transaction-classify";

/*
 * Value: protects=a correction can only name a real category, so a typo or a
 * client-supplied string never becomes a stored rule; fails_when=isCategory
 * accepts an inherited property ("constructor") or an unlisted name;
 * why_new=corrections are stored as text, not an enum; seam=isCategory;
 * no_claim=the database upsert (covered by the e2e run, not here).
 */
describe("isCategory", () => {
  it("accepts every taxonomy key", () => {
    for (const key of Object.keys(CATEGORY_CRITERIA)) expect(isCategory(key)).toBe(true);
  });
  it("rejects anything else, including inherited object properties", () => {
    for (const value of ["", "Dining", "constructor", "__proto__", "toString", "groceriess"]) {
      expect(isCategory(value)).toBe(false);
    }
  });
});
