import { describe, expect, it } from "vitest";
import {
  flattenFolders,
  folderCounts,
  inFolder,
  kindLabel,
  matchesQuery,
  rangeIds,
  tagCounts,
  sortRows,
  statusLabel,
  type BrowserRow,
} from "@/domains/knowledge/file-browser";

const row = (over: Partial<BrowserRow>): BrowserRow => ({
  id: "a",
  title: "Invoice",
  filename: "inv.pdf",
  mimeType: "application/pdf",
  createdAt: "2026-10-01T00:00:00.000Z",
  sourceUrl: null,
  kind: "file",
  extractionStatus: "succeeded",
  undecidedProposals: 0,
  partyNames: [],
  folderId: null,
  version: 1,
  tags: [],
  ...over,
});

describe("file browser", () => {
  const rows = [
    row({ id: "1", title: "Zeta lease", undecidedProposals: 2, partyNames: ["Acme Corp"] }),
    row({ id: "2", title: "alpha page", kind: "web_page", sourceUrl: "https://x.test/a", mimeType: null, extractionStatus: null, createdAt: "2026-10-03T00:00:00.000Z" }),
    row({ id: "3", title: "Beta scan", mimeType: "image/png", extractionStatus: "failed", createdAt: "2026-10-02T00:00:00.000Z" }),
  ];

  it("derives folder membership from the document", () => {
    expect(inFolder(rows[0]!, "review")).toBe(true);
    expect(inFolder(rows[1]!, "pages")).toBe(true);
    expect(inFolder(rows[1]!, "unread")).toBe(true);
    expect(inFolder(rows[2]!, "failed")).toBe(true);
    expect(folderCounts(rows)).toEqual({ all: 3, files: 2, pages: 1, review: 1, unread: 1, failed: 1, unfiled: 3 });
  });

  it("derives owner folders and unfiled from the folder id", () => {
    const filed = row({ id: "9", folderId: "f1" });
    expect(inFolder(filed, "folder:f1")).toBe(true);
    expect(inFolder(filed, "folder:f2")).toBe(false);
    expect(inFolder(filed, "unfiled")).toBe(false);
    expect(inFolder(row({}), "unfiled")).toBe(true);
    expect(inFolder(filed, "folder:")).toBe(false);
  });

  it("derives tag views and searches tags", () => {
    const tagged = row({ id: "t", tags: ["tax", "2026"] });
    expect(inFolder(tagged, "tag:tax")).toBe(true);
    expect(inFolder(tagged, "tag:other")).toBe(false);
    expect(matchesQuery(tagged, "2026")).toBe(true);
    expect(tagCounts([tagged, row({ id: "u", tags: ["tax"] })])).toEqual([
      { tag: "tax", count: 2 },
      { tag: "2026", count: 1 },
    ]);
  });

  it("flattens the folder tree depth-first by name and surfaces orphans at the root", () => {
    const node = (id: string, name: string, parentId: string | null) => ({ id, name, parentId, version: 1, documentCount: 0 });
    const flat = flattenFolders([node("c", "Zed", "a"), node("a", "Alpha", null), node("b", "Beta", null), node("o", "Orphan", "gone"), node("d", "Deep", "c")]);
    expect(flat.map((f) => `${f.depth}:${f.name}`)).toEqual(["0:Alpha", "1:Zed", "2:Deep", "0:Beta", "0:Orphan"]);
  });

  it("searches title, filename, url and parties with every term", () => {
    expect(matchesQuery(rows[0]!, "acme lease")).toBe(true);
    expect(matchesQuery(rows[0]!, "acme nope")).toBe(false);
    expect(matchesQuery(rows[1]!, "x.test")).toBe(true);
    expect(matchesQuery(rows[1]!, "  ")).toBe(true);
  });

  it("sorts by recency, name (case-insensitive) and review load", () => {
    expect(sortRows(rows, "recent").map((r) => r.id)).toEqual(["2", "3", "1"]);
    expect(sortRows(rows, "name").map((r) => r.id)).toEqual(["2", "3", "1"]);
    expect(sortRows(rows, "status")[0]!.id).toBe("1");
  });

  it("labels kind and status honestly", () => {
    expect(kindLabel(rows[0]!)).toBe("PDF");
    expect(kindLabel(rows[1]!)).toBe("Web page");
    expect(kindLabel(rows[2]!)).toBe("Image");
    expect(statusLabel(rows[0]!)).toBe("2 to review");
    expect(statusLabel(rows[1]!)).toBe("Not read");
    expect(statusLabel(rows[2]!)).toBe("Failed");
  });

  it("selects shift-click ranges in either direction", () => {
    expect(rangeIds(["1", "2", "3", "4"], "2", "4")).toEqual(["2", "3", "4"]);
    expect(rangeIds(["1", "2", "3", "4"], "4", "2")).toEqual(["2", "3", "4"]);
    expect(rangeIds(["1"], "x", "1")).toEqual(["1"]);
  });
});
