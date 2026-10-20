import { describe, expect, it } from "vitest";
import { documentStatus, STALLED_AFTER_MS } from "@/domains/knowledge/status";

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
    expect(documentStatus({ status: "succeeded", proposalStatus: "succeeded" }, 2)).toEqual({
      label: "Needs your check",
      tone: "attention",
    });
  });

  it("a succeeded extraction with every proposal decided is Filed", () => {
    expect(documentStatus({ status: "succeeded", proposalStatus: "succeeded" }, 0)).toEqual({ label: "Filed", tone: "done" });
  });

  it("read text whose fields were never proposed, or failed to be, is never Filed", () => {
    expect(documentStatus({ status: "succeeded", proposalStatus: null }, 0)).toEqual({
      label: "Fields not proposed",
      tone: "attention",
    });
    expect(documentStatus({ status: "succeeded", proposalStatus: "pending" }, 0)).toEqual({ label: "Reading", tone: "progress" });
    expect(documentStatus({ status: "succeeded", proposalStatus: "failed" }, 0)).toEqual({
      label: "Fields not read",
      tone: "error",
    });
  });

  it("a queued read that has waited too long stops claiming to be reading", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const old = new Date(now.getTime() - STALLED_AFTER_MS - 1_000);
    expect(documentStatus({ status: "pending", createdAt: old }, 0, now)).toEqual({
      label: "Waiting for the queue",
      tone: "attention",
    });
    expect(documentStatus({ status: "pending", createdAt: now }, 0, now)).toEqual({
      label: "Reading",
      tone: "progress",
    });
  });

  it("accepts a Postgres timestamp as an ISO string, which is what a server component gets", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const old = new Date(now.getTime() - STALLED_AFTER_MS - 1_000).toISOString();
    expect(documentStatus({ status: "pending", createdAt: old }, 0, now)).toEqual({
      label: "Waiting for the queue",
      tone: "attention",
    });
  });

  it("an unparseable or absent timestamp reads as in progress, never throws", () => {
    const now = new Date("2026-10-20T12:00:00Z");
    for (const createdAt of [null, undefined, "", "not-a-date"]) {
      expect(documentStatus({ status: "pending", createdAt }, 0, now)).toEqual({ label: "Reading", tone: "progress" });
    }
  });

  it("no raw enum value ever reaches the label", () => {
    for (const status of [null, { status: "pending" }, { status: "succeeded" }, { status: "failed" }]) {
      const { label } = documentStatus(status, 0);
      expect(label).not.toMatch(/^(pending|succeeded|failed|skipped)$/);
    }
  });
});
