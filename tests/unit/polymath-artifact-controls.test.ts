import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RichEditor from "@/components/products/polymath/rich-editor";
import { markdownEditorMode, markdownSourceReason } from "@/components/products/polymath/markdown-preservation";
import { artifactHref } from "@/components/products/polymath/artifact-controls";
import type { ArtifactKind } from "@/components/workspace/types";

describe("Alfred canonical artifact routing", () => {
  it.each<[ArtifactKind, string]>([
    ["source", "library"],
    ["document", "library"],
    ["zettel", "zettels"],
    ["note", "notebook"],
    ["dossier", "dossiers"],
    ["canvas", "canvas"],
  ])("routes a %s to its canonical %s view without changing identity", (kind, screen) => {
    const id = "record id/with spaces";
    const url = new URL(artifactHref({ id, kind, tags: [] }), "https://axiom.example.test");
    expect(url.pathname).toBe(`/apps/polymath/${screen}`);
    expect(url.searchParams.get("id")).toBe(id);
  });
  it("routes authored blog notes to the blog studio while preserving their note identity", () => {
    const url = new URL(
      artifactHref({ id: "note-blog", kind: "note", tags: ["Blog draft", "Research"] }),
      "https://axiom.example.test",
    );
    expect(url.pathname).toBe("/apps/polymath/blogs");
    expect(url.searchParams.get("id")).toBe("note-blog");
  });
});

describe("shared rich editor Markdown preservation", () => {
  beforeEach(() => vi.stubGlobal("React", React));
  afterEach(() => vi.unstubAllGlobals());
  const cases = [
    {
      kind: "tables",
      body: "Before\n\n| Name | Value |\n| --- | --- |\n| Secret | retained? |\n\nAfter",
      retained: "Secret | retained?",
    },
    {
      kind: "images",
      body: "Before\n\n![Evidence](https://example.test/retained-image.png)\n\nAfter",
      retained: "https://example.test/retained-image.png",
    },
    {
      kind: "raw HTML",
      body: 'Before\n\n<div data-source="preserve">Raw evidence</div>\n\nAfter',
      retained: "Raw evidence",
    },
    {
      kind: "reference links, images or footnotes",
      body: "[Retained source][origin]\n\n[origin]: https://example.test/original",
      retained: "https://example.test/original",
    },
  ];
  it.each(cases)(
    "preserves $kind in the source editor before and after a one-character edit",
    ({ kind, body, retained }) => {
      expect(markdownSourceReason(body)).toBe(kind);
      expect(markdownEditorMode(body, "rich")).toBe("source");
      const onChange = vi.fn();
      for (const content of [body, `${body}!`]) {
        const markup = renderToStaticMarkup(React.createElement(RichEditor, { content, onChange }));
        expect(markup).toContain("<textarea");
        expect(markup).toContain('aria-label="Markdown source"');
        expect(markup).toContain(retained);
        expect(markup).toContain("Rich editing is disabled");
        expect(markup).not.toContain('aria-label="Rich note content"');
      }
      expect(onChange).not.toHaveBeenCalled();
    },
  );
  it("allows rich editing for supported prose, headings, links, lists, task checkboxes and code", () => {
    const content =
      "## A heading\n\n**An idea** with [evidence](https://example.test/source).\n\n- One item\n- Another item\n\n- [x] Completed commitment\n- [ ] Still pending\n\n```ts\nconst version = 1;\n```";
    expect(markdownSourceReason(content)).toBeUndefined();
    expect(markdownEditorMode(content)).toBe("rich");
    expect(markdownEditorMode(content, "source")).toBe("source");
  });
});
