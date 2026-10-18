import { describe, expect, it } from "vitest";
import { documentStatus } from "@/domains/knowledge/status";

/*
 * The inbox's status vocabulary is the one place database enums become human
 * words (ASH-127). The mapping is pinned so no enum value can leak to the
 * screen and no state can silently lose its tone.
 */

describe("documentStatus", () => {
  it("a document with no extraction is Added", () => {
    expect(documentStatus(null, 0)).toEqual({ label: "Added", tone: "neutral" });
    expect(documentStatus(undefined, 0)).toEqual({ label: "Added", tone: "neutral" });
  });

  it("pending and skipped extractions are Reading", () => {
    expect(documentStatus({ status: "pending" }, 0)).toEqual({ label: "Reading", tone: "progress" });
    expect(documentStatus({ status: "skipped" }, 0)).toEqual({ label: "Reading", tone: "progress" });
  });

  it("a failed extraction is Could not read, regardless of proposals", () => {
    expect(documentStatus({ status: "failed", error: "bad pdf" }, 3)).toEqual({
      label: "Could not read",
      tone: "error",
    });
  });

  it("a succeeded extraction with undecided proposals needs your check", () => {
    expect(documentStatus({ status: "succeeded" }, 2)).toEqual({
      label: "Needs your check",
      tone: "attention",
    });
  });

  it("a succeeded extraction with every proposal decided is Filed", () => {
    expect(documentStatus({ status: "succeeded" }, 0)).toEqual({ label: "Filed", tone: "done" });
  });

  it("no raw enum value ever reaches the label", () => {
    for (const status of [null, { status: "pending" }, { status: "succeeded" }, { status: "failed" }]) {
      const { label } = documentStatus(status, 0);
      expect(label).not.toMatch(/^(pending|succeeded|failed|skipped)$/);
    }
  });
});
