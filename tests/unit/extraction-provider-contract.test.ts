import { afterEach, describe, expect, it, vi } from "vitest";
import { createLlamaParseProvider } from "@/integrations/extraction/llamaparse";

/*
 * Provider contract, pinned with sanitized fixtures over a mocked fetch — no
 * live provider calls in CI, per engineering.md. The contract points worth
 * locking: the markdown result yields text plus the single honest span, and
 * carries no structured fields (LlamaParse's markdown endpoint does not
 * produce them; the domain normalizes its own).
 */

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("llamaparse adapter (sanitized fixture)", () => {
  it("maps a successful job to text plus the single span, with no fabricated fields", async () => {
    const fetchMock = vi
      .fn()
      // upload
      .mockResolvedValueOnce(jsonResponse({ id: "job-1", polling_url: "https://llama.test/job/1" }))
      // first poll: still running
      .mockResolvedValueOnce(jsonResponse({ status: "PENDING" }))
      // second poll: done
      .mockResolvedValueOnce(jsonResponse({ status: "SUCCESS" }))
      // result markdown
      .mockResolvedValueOnce(new Response("# Invoice\n\nTotal: $1,200.00", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createLlamaParseProvider("test-key");
    const result = await provider.extract({
      bytes: PDF_BYTES,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    });

    expect(result).toMatchObject({
      ok: true,
      text: "# Invoice\n\nTotal: $1,200.00",
      extractor: "llamaparse@hosted",
    });
    expect(result.ok && result.spans).toEqual([{ page: 1, start: 0, end: 27 }]);
    // No structured output exists in this response; the adapter must not invent any.
    expect(result.ok && result.fields).toBeUndefined();
  });

  it("returns a failed result when the upload is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("unauthorized", { status: 401 })),
    );

    const provider = createLlamaParseProvider("bad-key");
    const result = await provider.extract({
      bytes: PDF_BYTES,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    });

    expect(result).toMatchObject({ ok: false, extractor: "llamaparse@hosted" });
    if (!result.ok) expect(result.error).toContain("401");
  });
});
