import { describe, expect, it } from "vitest";
import { outcomeLine } from "@/app/(workspace)/reviews/outcome-line";

/*
 * The review card's outcome line renders from the decide response AND from
 * the persisted attempt after reload, so its copy is the contract a person
 * reads at both moments. Pins the capability-aware wording: an async import
 * is never a "send", a persisted failure never invites a repeat, and stored
 * machine codes are translated for a person.
 */
describe("outcomeLine", () => {
  it("a settled Canva import says imported, never sent", () => {
    expect(outcomeLine("canva.design.import", { status: "sent", providerId: "design-1", at: "2026-10-25T00:00:00Z" })).toBe(
      "Imported to Canva.",
    );
  });

  it("an accepted Canva job is named as waiting, distinct from a lost creation", () => {
    expect(outcomeLine("canva.design.import", { status: "unknown", reconciliationId: "a", note: "import_started" })).toBe(
      "Import job created; Polymath is waiting for Canva's terminal result.",
    );
    expect(outcomeLine("canva.design.import", { status: "unknown", reconciliationId: "a" })).toBe(
      "Outcome unconfirmed; Polymath checks with Canva before anything runs again.",
    );
  });

  it("a persisted Canva failure translates the stored code and invites no repeat", () => {
    const line = outcomeLine("canva.design.import", { status: "failed", reason: "canva_import_failed", retryable: false });
    expect(line).toBe("Not imported. Canva reported the import failed.");
    expect(line).not.toMatch(/retry|again/i);
  });

  it("an unknown failure code passes through rather than guessing", () => {
    expect(outcomeLine("canva.design.import", { status: "failed", reason: "some_other_code", retryable: false })).toBe(
      "Not imported. some_other_code",
    );
  });

  it("gmail wording is byte-preserved", () => {
    expect(outcomeLine("gmail.send", { status: "sent", providerId: "m-1", at: "2026-10-25T00:00:00Z" })).toBe("Sent.");
    expect(outcomeLine("gmail.send", { status: "unknown", reconciliationId: "a" })).toBe("Checking whether this was sent.");
    expect(outcomeLine("gmail.send", { status: "failed", reason: "gmail rejected", retryable: false })).toBe(
      "Not sent. gmail rejected",
    );
  });
});
