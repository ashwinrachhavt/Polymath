import { describe, expect, it } from "vitest";
import { chunkBlocks, markdownToBlocks, richTextParts } from "@/integrations/notion/blocks";
import { appendPreview, contentHash } from "@/domains/knowledge/notion-proposals";
import { collectRecords, recordPath } from "@/components/chat/record-links";
import { safeHref } from "@/components/markdown-inline";

/*
 * What must hold before a Notion proposal can be approved (ASH-283): the hash
 * the owner reviewed is the hash that executes, the markdown becomes blocks
 * without losing a line, and the preview shows the addition rather than a
 * merge this path cannot perform.
 */

describe("notion block conversion", () => {
  it("keeps every non-blank line, in order", () => {
    const blocks = markdownToBlocks("# Title\n\nA paragraph\ncontinued here.\n\n- one\n- two\n\n> quoted\n");
    expect(blocks.map((block) => block.type)).toEqual([
      "heading_1",
      "paragraph",
      "bulleted_list_item",
      "bulleted_list_item",
      "quote",
    ]);
  });

  it("joins a wrapped paragraph into one block rather than one block per line", () => {
    const [block] = markdownToBlocks("The lease runs\nfor two years.");
    expect(block.type).toBe("paragraph");
    expect((block.paragraph as { rich_text: { text: { content: string } }[] }).rich_text[0].text.content).toBe(
      "The lease runs for two years.",
    );
  });

  it("turns an inline link into a linked rich-text run", () => {
    const parts = richTextParts("See [the lease](https://example.com/lease) for terms.");
    const linked = parts.find((part) => part.text.link);
    expect(linked?.text.content).toBe("the lease");
    expect(linked?.text.link?.url).toBe("https://example.com/lease");
  });

  it("splits a run over Notion's 2000-char limit instead of dropping the tail", () => {
    const parts = richTextParts("x".repeat(4500));
    expect(parts).toHaveLength(3);
    expect(parts.map((part) => part.text.content.length)).toEqual([2000, 2000, 500]);
  });

  it("chunks over 100 blocks into appendable batches", () => {
    const blocks = markdownToBlocks(Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n\n"));
    expect(blocks.length).toBe(250);
    expect(chunkBlocks(blocks).map((chunk) => chunk.length)).toEqual([100, 100, 50]);
  });
});

describe("notion proposal integrity", () => {
  it("hashes the exact markdown, so an edited payload no longer matches", () => {
    const approved = contentHash("# Note\nBody.");
    expect(contentHash("# Note\nBody.")).toBe(approved);
    expect(contentHash("# Note\nBody!")).not.toBe(approved);
  });

  it("previews the addition, not a merge the append path cannot perform", () => {
    const preview = appendPreview("Existing page\nSecond line", "## New section\nAdded line");
    expect(preview).toContain(" Second line");
    expect(preview).toContain("+## New section");
    expect(preview).toContain("+Added line");
    // The existing text is context only: it must never read as a removal.
    expect(preview).not.toMatch(/^-/m);
  });
});

describe("record cards", () => {
  it("maps a kind to its real route and refuses to invent one", () => {
    expect(recordPath("document", "abc")).toBe("/alfred/library/abc");
    expect(recordPath("artifact", "abc")).toBe("/artifacts/abc");
    expect(recordPath("notathing" as never, "abc")).toBeNull();
  });

  it("infers the record kind from the list key a tool returned", () => {
    const records = collectRecords({ ok: true, tasks: [{ id: "1", title: "Renew the lease", dueAt: "2026-11-01" }] });
    expect(records).toEqual([{ kind: "task", id: "1", title: "Renew the lease", subtitle: "2026-11-01" }]);
  });

  it("caps what one tool result can put in the thread", () => {
    const records = collectRecords({ notes: Array.from({ length: 20 }, (_, i) => ({ id: String(i), title: `Note ${i}` })) }, 3);
    expect(records).toHaveLength(3);
  });

  it("returns nothing for an output with no recognisable record list", () => {
    expect(collectRecords({ ok: true, text: "just prose" })).toEqual([]);
    expect(collectRecords(null)).toEqual([]);
  });

  it("turns document-search results into one card per document", () => {
    const records = collectRecords({
      ok: true,
      // Document search returns `documentId`, not `id`; a web hit has a url and
      // no document, so it must not become a record card.
      results: [
        { documentId: "d1", title: "Lease", text: "a", span: { start: 0 } },
        { documentId: "d1", title: "Lease", text: "b", span: { start: 40 } },
        { title: "Some web page", url: "https://example.com", snippet: "x" },
      ],
    });
    expect(records).toEqual([{ kind: "document", id: "d1", title: "Lease" }]);
  });
});

describe("markdown link safety", () => {
  it("allows same-origin and http(s) only", () => {
    expect(safeHref("/alfred/notes")).toBe("/alfred/notes");
    expect(safeHref("https://example.com")).toBe("https://example.com");
    // A model-written answer is untrusted: these must never become anchors.
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeHref("//evil.example.com")).toBeNull();
  });
});
