import { describe, expect, it } from "vitest";
import { normalizeExtractedText, normalizePageText } from "@/integrations/extraction/cleanup";

describe("normalizePageText", () => {
  it("strips control characters except newline and tab", () => {
    expect(normalizePageText("a\u0000b\u0007c\u001fd\u007fe")).toBe("abcde");
    expect(normalizePageText("line\nline\ttab")).toBe("line\nline\ttab");
  });

  it("trims trailing whitespace per line", () => {
    expect(normalizePageText("kept \nalso kept\t\ntrailing   ")).toBe(
      "kept\nalso kept\ntrailing",
    );
  });
});

describe("normalizeExtractedText", () => {
  it("collapses three or more blank lines to one", () => {
    expect(normalizeExtractedText("a\n\n\n\n\nb", "plain")).toBe("a\n\nb");
    expect(normalizeExtractedText("a\n\nb", "plain")).toBe("a\n\nb");
  });

  it("drops leading and trailing markdown page-marker lines", () => {
    expect(normalizeExtractedText("- 3 -\n\nbody text\n\n- 4 -", "markdown")).toBe("body text");
    expect(normalizeExtractedText("body with - 3 - inline", "markdown")).toBe(
      "body with - 3 - inline",
    );
    // Plain format keeps markers: only markdown drops them.
    expect(normalizeExtractedText("- 3 -\nbody", "plain")).toBe("- 3 -\nbody");
  });

  it("passes through clean text unchanged", () => {
    const clean = "# Heading\n\nParagraph one.\n\nParagraph two.\n";
    expect(normalizeExtractedText(clean, "markdown")).toBe("# Heading\n\nParagraph one.\n\nParagraph two.");
  });

  it("returns empty for control-character-only input", () => {
    expect(normalizeExtractedText("\u0000\u0007\u001f", "plain")).toBe("");
  });
});

describe("docling adapter empty verdict", () => {
  it("returns ok:false with the named error when md_content is empty", async () => {
    const { createDoclingDockerProvider } = await import("@/integrations/extraction/docling-docker");
    const fetchMock = async () => new Response(JSON.stringify({ document: { md_content: "", page_count: 1 } }), { status: 200 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const result = await createDoclingDockerProvider("http://docling.fixture").extract({
        bytes: new Uint8Array([1]), filename: "f.pdf", mimeType: "application/pdf",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("docling-serve returned no readable text");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects oversized input before any fetch", async () => {
    const { createDoclingDockerProvider } = await import("@/integrations/extraction/docling-docker");
    const { MAX_UPLOAD_BYTES } = await import("@/lib/file-validation");
    let fetched = false;
    const fetchMock = async () => { fetched = true; throw new Error("should not fetch"); };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const result = await createDoclingDockerProvider("http://docling.fixture").extract({
        bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1), filename: "f.pdf", mimeType: "application/pdf",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("The document is too large to read.");
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
