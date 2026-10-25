import { describe, expect, it } from "vitest";
import { vaultReview } from "@/domains/knowledge/vault-review";

/*
 * The vault's review lens. The pipeline's own vocabulary lives in status.ts
 * and is right for the workbench; these labels are what a file browser says.
 * A filed row is silent, so the list only shows work when there is work.
 */

describe("vaultReview", () => {
  it("leaves a filed document quiet", () => {
    expect(vaultReview("filed", 0)).toBeNull();
  });

  it("says how much is waiting when proposals are undecided", () => {
    expect(vaultReview("needs_check", 3)).toMatchObject({
      label: "3 to review",
      tone: "attention",
      needsReview: true,
    });
    expect(vaultReview("needs_check", 1)?.detail).toContain("1 field proposal is");
  });

  it("uses Needs review for every proposal pass that needs the owner, never the pipeline words", () => {
    const keys = ["fields_not_proposed", "fields_not_read", "needs_check"] as const;
    for (const key of keys) {
      const review = vaultReview(key, 0);
      expect(review?.label).toBe("Needs review");
      expect(review?.needsReview).toBe(true);
      expect(review?.label).not.toMatch(/fields not/i);
    }
  });

  it("keeps a failed read distinct from a failed proposal pass", () => {
    expect(vaultReview("could_not_read", 0)).toMatchObject({ label: "Couldn't read", tone: "error" });
    expect(vaultReview("fields_not_read", 0)).toMatchObject({ label: "Needs review", tone: "error" });
  });

  it("does not call an unread or reading document a review", () => {
    expect(vaultReview("added", 0)).toMatchObject({ label: "Not read yet", needsReview: false });
    expect(vaultReview("reading", 0)).toMatchObject({ label: "Reading…", needsReview: false });
  });
});
