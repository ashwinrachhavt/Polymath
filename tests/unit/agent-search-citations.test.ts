import { describe, expect, it } from "vitest";
import { collectCitations } from "@/domains/knowledge/agent-search";
import { toolAllowed } from "../../eve/alfred/agent/lib/policy";

const hit = (id: string, start: number) => ({ documentId: id, title: `T${id}`, text: "x", span: { start, end: start + 1, page: 1 } });

describe("collectCitations", () => {
  it("dedupes by document and span, keeps first-seen order, skips junk", () => {
    const out = collectCitations([
      { ok: true, results: [hit("a", 0), hit("b", 5)] },
      { ok: true, results: [hit("a", 0), hit("a", 9)] },
      { ok: false, error: "nope" },
      null,
      { results: [{ documentId: 1 }] },
    ]);
    expect(out.map((c) => `${c.documentId}:${c.span.start}`)).toEqual(["a:0", "b:5", "a:9"]);
  });
});

describe("documents.search policy", () => {
  it("is denied unless the frozen snapshot names it", () => {
    expect(toolAllowed({ allowedTools: ["tasks.read"] }, "documents.search")).toBe(false);
    expect(toolAllowed({ allowedTools: ["documents.search"] }, "documents.search")).toBe(true);
    expect(toolAllowed(null, "documents.search")).toBe(false);
  });
});
