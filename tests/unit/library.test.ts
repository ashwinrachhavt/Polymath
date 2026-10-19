import { describe, expect, it } from "vitest";
import { pickPin } from "@/domains/knowledge/exports";
import { canRestore } from "@/domains/knowledge/versions";
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

describe("canRestore", () => {
  it("only a succeeded version of the same document is a restore target", () => {
    expect(canRestore({ documentId: "d1", status: "succeeded" }, "d1")).toBe(true);
    expect(canRestore({ documentId: "d1", status: "failed" }, "d1")).toBe(false);
    expect(canRestore({ documentId: "d1", status: "pending" }, "d1")).toBe(false);
    expect(canRestore({ documentId: "other", status: "succeeded" }, "d1")).toBe(false);
  });
});

describe("pickPin with a restore pin", () => {
  const older = { id: "v1", documentId: "d1", contentHash: "hash-1", status: "succeeded", createdAt: new Date("2026-01-01") };
  const newer = { id: "v2", documentId: "d1", contentHash: "hash-2", status: "succeeded", createdAt: new Date("2026-02-01") };

  it("the restore pin wins over recency", () => {
    expect(pickPin([older, newer], "v1")).toEqual({ extractionId: "v1", extractionContentHash: "hash-1" });
  });

  it("a pin at a failed version falls back to the newest succeeded", () => {
    const failed = { ...newer, id: "v3", status: "failed", createdAt: new Date("2026-03-01") };
    expect(pickPin([older, failed], "v3")).toEqual({ extractionId: "v1", extractionContentHash: "hash-1" });
  });

  it("no pin means the newest succeeded, as before", () => {
    expect(pickPin([older, newer])).toEqual({ extractionId: "v2", extractionContentHash: "hash-2" });
  });
});
