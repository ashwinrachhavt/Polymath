import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RichEditor from "@/components/products/alfred/rich-editor";
import { markdownEditorMode, markdownSourceReason } from "@/components/products/alfred/markdown-preservation";
import { createAlfredPreview } from "@/components/products/alfred/preview-state";
import { artifactHref, taskHref } from "@/components/products/alfred/artifact-controls";
import type { ArtifactKind } from "@/components/workspace/types";

describe("Alfred canonical artifact routing", () => {
  it.each<[ArtifactKind, string]>([["source", "library"], ["document", "library"], ["zettel", "zettels"], ["note", "notebook"], ["dossier", "dossiers"], ["canvas", "canvas"]])("routes a %s to its canonical %s view without changing identity", (kind, screen) => {
    const id = "record id/with spaces";
    const url = new URL(artifactHref({ id, kind, tags: [] }), "https://axiom.example.test");
    expect(url.pathname).toBe(`/apps/alfred/${screen}`);
    expect(url.searchParams.get("id")).toBe(id);
  });
  it("routes authored blog notes to the blog studio while preserving their note identity", () => {
    const url = new URL(artifactHref({ id: "note-blog", kind: "note", tags: ["Blog draft", "Research"] }), "https://axiom.example.test");
    expect(url.pathname).toBe("/apps/alfred/blogs");
    expect(url.searchParams.get("id")).toBe("note-blog");
  });
  it("uses NeuralFlow's task inspector query rather than an ignored id parameter", () => {
    const id = "task/id with spaces";
    const url = new URL(taskHref(id), "https://axiom.example.test");
    expect(url.pathname).toBe("/apps/neuralflow/tasks");
    expect(url.searchParams.get("task")).toBe(id);
    expect(url.searchParams.has("id")).toBe(false);
  });
});

const privateMetadata = { pins: { dossier: [{ id: "private-source", title: "Owner one source", body: "Private evidence", version: 2, at: "2026-10-11" }] }, annotations: { "canonical:record": "Owner one annotation" }, attempts: [{ id: "attempt-one", mode: "quiz" as const, result: "Owner one result", at: "2026-10-11" }] };
const emptyMetadata = { pins: {}, annotations: {}, attempts: [] };

describe("Alfred preview owner isolation", () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("isolates snapshots, listeners and persisted pins, annotations and attempts by owner", () => {
    const first = createAlfredPreview("authscope-owner-one");
    const second = createAlfredPreview("authscope-owner-two");
    const firstListener = vi.fn();
    const secondListener = vi.fn();
    first.subscribe(firstListener);
    second.subscribe(secondListener);
    first.update(() => privateMetadata);
    expect(first.getSnapshot()).toEqual(privateMetadata);
    expect(second.getSnapshot()).toEqual(emptyMetadata);
    expect(firstListener).toHaveBeenCalledOnce();
    expect(secondListener).not.toHaveBeenCalled();
    expect(storage.get("axiom-alfred-preview-v1:authscope-owner-one")).toBe(JSON.stringify(privateMetadata));
    expect(storage.has("axiom-alfred-preview-v1:authscope-owner-two")).toBe(false);
    expect(createAlfredPreview("authscope-owner-one").getSnapshot()).toEqual(privateMetadata);
    expect(createAlfredPreview("authscope-owner-two").getSnapshot()).toEqual(emptyMetadata);
  });

  it("never adopts potentially private legacy unscoped data, including in anonymous mode", () => {
    storage.set("axiom-alfred-preview-v1", JSON.stringify(privateMetadata));
    expect(createAlfredPreview("anonymous").getSnapshot()).toEqual(emptyMetadata);
    expect(createAlfredPreview("authscope-new-owner").getSnapshot()).toEqual(emptyMetadata);
  });

  it("keeps storage failure notifications scoped to their owner", () => {
    const first = createAlfredPreview("authscope-owner-one");
    const second = createAlfredPreview("authscope-owner-two");
    storage.set("axiom-alfred-preview-v1:authscope-owner-one", "not valid JSON");
    first.getSnapshot();
    second.getSnapshot();
    expect(first.getStorageWarning()).toContain("unavailable");
    expect(second.getStorageWarning()).toBe("");
    first.getSnapshot();
    expect(first.getStorageWarning()).toContain("unavailable");
  });

  it("retains only the current owner's in-memory changes when persistence fails", () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => { throw new Error("Storage unavailable"); } });
    const first = createAlfredPreview("authscope-owner-one");
    const second = createAlfredPreview("authscope-owner-two");
    first.update(() => privateMetadata);
    expect(first.getSnapshot()).toEqual(privateMetadata);
    expect(first.getStorageWarning()).toContain("could not be saved");
    expect(second.getSnapshot()).toEqual(emptyMetadata);
    expect(second.getStorageWarning()).toBe("");
  });

  it("never includes hydrated private browser metadata in the server snapshot", () => {
    const first = createAlfredPreview("authscope-owner-one");
    first.update(() => privateMetadata);
    expect(first.getServerSnapshot()).toEqual(emptyMetadata);
  });
});

describe("shared rich editor Markdown preservation", () => {
  beforeEach(() => vi.stubGlobal("React", React));
  afterEach(() => vi.unstubAllGlobals());
  const cases = [
    { kind: "tables", body: "Before\n\n| Name | Value |\n| --- | --- |\n| Secret | retained? |\n\nAfter", retained: "Secret | retained?" },
    { kind: "images", body: "Before\n\n![Evidence](https://example.test/retained-image.png)\n\nAfter", retained: "https://example.test/retained-image.png" },
    { kind: "task checkbox states", body: "- [x] Completed commitment\n- [ ] Still pending", retained: "[x] Completed commitment" },
    { kind: "raw HTML", body: "Before\n\n<div data-source=\"preserve\">Raw evidence</div>\n\nAfter", retained: "Raw evidence" },
    { kind: "reference links, images or footnotes", body: "[Retained source][origin]\n\n[origin]: https://example.test/original", retained: "https://example.test/original" },
  ];
  it.each(cases)("preserves $kind in the source editor before and after a one-character edit", ({ kind, body, retained }) => {
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
  });
  it("allows rich editing for supported prose, headings, links, lists and code", () => {
    const content = "## A heading\n\n**An idea** with [evidence](https://example.test/source).\n\n- One item\n- Another item\n\n```ts\nconst version = 1;\n```";
    expect(markdownSourceReason(content)).toBeUndefined();
    expect(markdownEditorMode(content)).toBe("rich");
    expect(markdownEditorMode(content, "source")).toBe("source");
  });
});
