import { afterEach, describe, expect, it, vi } from "vitest";
import { createLlamaParseProvider } from "@/integrations/extraction/llamaparse";

/*
 * Provider contract, pinned with sanitized fixtures over a mocked fetch — no
 * live provider calls in CI, per engineering.md. The contract points worth
 * locking: the v2 endpoints and configuration field, job.status polling, and
 * per-page markdown mapped to text plus page spans with no structured fields
 * (LlamaParse's markdown result does not produce them; the domain's rules do).
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

describe("llamaparse v2 adapter (sanitized fixture)", () => {
  it("uploads with tier+version, polls job.status, and maps per-page markdown to text and page spans", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "job-1", status: "PENDING" }))
      .mockResolvedValueOnce(jsonResponse({ job: { id: "job-1", status: "RUNNING" } }))
      .mockResolvedValueOnce(jsonResponse({ job: { id: "job-1", status: "COMPLETED" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          job: { id: "job-1", status: "COMPLETED" },
          markdown: {
            pages: [
              { page_number: 2, success: true, markdown: "Total: $1,200.00" },
              { page_number: 1, success: true, markdown: "# Invoice" },
            ],
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const provider = createLlamaParseProvider("test-key", 180_000, "https://llama.test");
    const result = await provider.extract({
      bytes: PDF_BYTES,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    });

    expect(result).toMatchObject({
      ok: true,
      text: "# Invoice\n\nTotal: $1,200.00",
      pageCount: 2,
      extractor: "llamaparse-v2@hosted",
    });
    expect(result.ok && result.spans).toEqual([
      { page: 1, start: 0, end: 9 },
      { page: 2, start: 11, end: 27 },
    ]);
    // No structured output exists in this response; the adapter must not invent any.
    expect(result.ok && result.fields).toBeUndefined();

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      "https://llama.test/api/v2/parse/upload",
      "https://llama.test/api/v2/parse/job-1",
      "https://llama.test/api/v2/parse/job-1",
      "https://llama.test/api/v2/parse/job-1?expand=markdown",
    ]);
    const body = fetchMock.mock.calls[0][1]?.body as FormData;
    expect(body.get("file")).toBeInstanceOf(Blob);
    expect(JSON.parse(String(body.get("configuration")))).toEqual({ tier: "fast", version: "latest" });
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).toEqual({ Authorization: "Bearer test-key" });
    }
  });

  it("reports a failed job with the provider's reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ id: "job-2", status: "PENDING" }))
        .mockResolvedValueOnce(jsonResponse({ job: { id: "job-2", status: "FAILED", error_message: "encrypted PDF" } })),
    );
    const result = await createLlamaParseProvider("test-key").extract({
      bytes: PDF_BYTES,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    });
    expect(result).toEqual({ ok: false, error: "llamaparse job ended FAILED: encrypted PDF", extractor: "llamaparse-v2@hosted" });
  });

  it("treats a page the provider could not read as a failed extraction, not a whole document", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ id: "job-3" }))
        .mockResolvedValueOnce(jsonResponse({ job: { id: "job-3", status: "COMPLETED" } }))
        .mockResolvedValueOnce(
          jsonResponse({
            markdown: {
              pages: [
                { page_number: 1, success: true, markdown: "# Invoice" },
                { page_number: 2, success: false, error: "timeout" },
              ],
            },
          }),
        ),
    );
    const result = await createLlamaParseProvider("test-key").extract({
      bytes: PDF_BYTES,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    });
    expect(result).toMatchObject({ ok: false, error: "llamaparse could not read page 2" });
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

    expect(result).toMatchObject({ ok: false, extractor: "llamaparse-v2@hosted" });
    if (!result.ok) expect(result.error).toContain("401");
  });
});
