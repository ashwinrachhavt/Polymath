import { describe, expect, it } from "vitest";
import { pickPin } from "@/domains/knowledge/exports";
import { validateFolderName, wouldCreateCycle } from "@/domains/knowledge/folders";
import { decodeCursor, encodeCursor, libraryStateOf } from "@/domains/knowledge/library";
import { documentStatus } from "@/domains/knowledge/status";

/*
 * The library's pure parts: cursor round-trips, the state-key mapping that
 * must stay pinned to status.ts's vocabulary, folder-name rules, cycle
 * detection, and the export pin's "latest succeeded or honest null".
 */

describe("library cursors", () => {
  it("round-trips a cursor", () => {
    const cursor = encodeCursor({ v: "2026-10-19T07:00:00.000Z", id: "abc-123" });
    expect(decodeCursor(cursor)).toEqual({ v: "2026-10-19T07:00:00.000Z", id: "abc-123" });
  });

  it("round-trips a numeric sort key", () => {
    expect(decodeCursor(encodeCursor({ v: 4096, id: "doc-1" }))).toEqual({ v: 4096, id: "doc-1" });
  });

  it("rejects garbage, never throws", () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor("")).toBeNull();
    expect(decodeCursor(encodeCursor({ v: null, id: "" } as never))).toBeNull();
  });
});

describe("libraryStateOf", () => {
  it("stays pinned to the status.ts vocabulary", () => {
    expect(libraryStateOf("added")).toMatchObject(documentStatus(null, 0));
    expect(libraryStateOf("reading")).toMatchObject(documentStatus({ status: "pending" }, 0));
    expect(libraryStateOf("could_not_read")).toMatchObject(documentStatus({ status: "failed" }, 0));
    expect(libraryStateOf("fields_not_read")).toMatchObject(documentStatus({ status: "succeeded", proposalStatus: "failed" }, 0));
    expect(libraryStateOf("fields_not_proposed")).toMatchObject(documentStatus({ status: "succeeded", proposalStatus: null }, 0));
    expect(libraryStateOf("needs_check")).toMatchObject(documentStatus({ status: "succeeded", proposalStatus: "succeeded" }, 1));
    expect(libraryStateOf("filed")).toMatchObject(documentStatus({ status: "succeeded", proposalStatus: "succeeded" }, 0));
  });
});

describe("validateFolderName", () => {
  it("trims and collapses whitespace", () => {
    expect(validateFolderName("  Tax   2026 ")).toBe("Tax 2026");
  });

  it("refuses an empty name", () => {
    expect(() => validateFolderName("   ")).toThrowError(/needs a name/);
  });
});

describe("wouldCreateCycle", () => {
  it("a folder under its own descendant is a cycle", () => {
    expect(wouldCreateCycle("a", ["c", "b", "a"])).toBe(true);
  });

  it("a folder under a sibling is fine", () => {
    expect(wouldCreateCycle("a", ["c", "b"])).toBe(false);
  });
});

describe("pickPin", () => {
  const at = (s: string) => new Date(s);

  it("pins the latest succeeded extraction", () => {
    const pin = pickPin([
      { id: "old", contentHash: "h1", status: "succeeded", createdAt: at("2026-10-01T00:00:00Z") },
      { id: "new", contentHash: "h2", status: "succeeded", createdAt: at("2026-10-02T00:00:00Z") },
      { id: "failed", contentHash: "h3", status: "failed", createdAt: at("2026-10-03T00:00:00Z") },
    ]);
    expect(pin).toEqual({ extractionId: "new", extractionContentHash: "h2" });
  });

  it("a failed re-read never becomes the pin", () => {
    const pin = pickPin([
      { id: "ok", contentHash: "h1", status: "succeeded", createdAt: at("2026-10-01T00:00:00Z") },
      { id: "bad", contentHash: "h2", status: "failed", createdAt: at("2026-10-02T00:00:00Z") },
    ]);
    expect(pin).toEqual({ extractionId: "ok", extractionContentHash: "h1" });
  });

  it("no succeeded extraction is an honest null, not a pretend version", () => {
    expect(pickPin([{ id: "x", contentHash: "h", status: "pending", createdAt: at("2026-10-01T00:00:00Z") }])).toBeNull();
    expect(pickPin([])).toBeNull();
  });
});

describe("normalizeTag", () => {
  it("lowercases, trims, and collapses whitespace", async () => {
    const { normalizeTag } = await import("@/domains/knowledge/tags");
    expect(normalizeTag("  Tax   2026 ")).toBe("tax 2026");
    expect(normalizeTag("URGENT")).toBe("urgent");
  });
});
