import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractionResult } from "@/integrations/extraction/provider";
import { createLlamaParseProvider } from "@/integrations/extraction/llamaparse";

/*
 * Provider contract, pinned with sanitized fixtures over a mocked fetch — no
 * live provider calls in CI, per engineering.md. The contract points worth
 * locking: the v2 endpoints and configuration field, job.status polling, and
 * per-page markdown mapped to text plus page spans with no structured fields
 * (LlamaParse's markdown result does not produce them; the domain's rules do).
 */

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

const PINNED_TIME = new Date();

beforeEach(() => {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(PINNED_TIME);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  // Restore the unit project's Date-only clock without leaving fake waits behind.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PINNED_TIME);
});

async function finishPolling(extraction: Promise<ExtractionResult>): Promise<ExtractionResult> {
  await vi.runAllTimersAsync();
  expect(vi.getTimerCount()).toBe(0);
  return extraction;
}

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
    const extraction = provider.extract({
      bytes: PDF_BYTES,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const result = await extraction;
    expect(vi.getTimerCount()).toBe(0);

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

  it.each(["FAILED", "CANCELLED"])("reports a %s job with the provider's reason", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse({ id: "job-2", status: "PENDING" }))
        .mockResolvedValueOnce(jsonResponse({ job: { id: "job-2", status, error_message: "encrypted PDF" } })),
    );
    const result = await finishPolling(createLlamaParseProvider("test-key").extract({
      bytes: PDF_BYTES,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    }));
    expect(result).toEqual({ ok: false, error: `llamaparse job ended ${status}: encrypted PDF`, extractor: "llamaparse-v2@hosted" });
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
    const result = await finishPolling(createLlamaParseProvider("test-key").extract({
      bytes: PDF_BYTES,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    }));
    expect(result).toMatchObject({ ok: false, error: "llamaparse could not read page 2" });
  });

  it.each(["PENDING", "RUNNING"])("bounds a stuck %s job to 45 polls at the default interval", async (status) => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ id: "stuck-job" }))
      .mockImplementation(async () => jsonResponse({ job: { status } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await finishPolling(createLlamaParseProvider("test-key").extract({
      bytes: PDF_BYTES,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    }));

    expect(result).toEqual({ ok: false, error: `llamaparse job ended ${status}`, extractor: "llamaparse-v2@hosted" });
    expect(fetchMock).toHaveBeenCalledTimes(46);
    expect(Date.now() - PINNED_TIME.getTime()).toBe(90_000);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("expand=markdown"))).toBe(false);
  });

  it.each([
    { timeoutMs: undefined, elapsedMs: 180_000, polls: 1 },
    { timeoutMs: undefined, elapsedMs: 180_001, polls: 0 },
    { timeoutMs: 5_000, elapsedMs: 5_000, polls: 1 },
    { timeoutMs: 5_000, elapsedMs: 5_001, polls: 0 },
  ])("enforces timeout $timeoutMs after $elapsedMs ms, allowing $polls polls at the boundary", async ({ timeoutMs, elapsedMs, polls }) => {
    vi.stubEnv("LLAMAPARSE_BASE_URL", undefined);
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => {
        vi.setSystemTime(PINNED_TIME.getTime() + elapsedMs);
        return jsonResponse({ id: "deadline-job" });
      })
      .mockImplementation(async () => jsonResponse({ job: { status: "RUNNING" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await finishPolling(createLlamaParseProvider("test-key", timeoutMs).extract({
      bytes: PDF_BYTES,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    }));

    expect(result).toEqual({ ok: false, error: "llamaparse job timed out", extractor: "llamaparse-v2@hosted" });
    expect(fetchMock).toHaveBeenCalledTimes(1 + polls);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.cloud.llamaindex.ai/api/v2/parse/upload");
    expect(Date.now() - PINNED_TIME.getTime()).toBe(elapsedMs + polls * 2_000);
  });

  it.each([
    { phase: "upload", responses: [] },
    { phase: "poll", responses: [{ id: "error-job" }] },
    { phase: "result", responses: [{ id: "error-job" }, { job: { status: "COMPLETED" } }] },
  ])("propagates a $phase transport error as a failed extraction", async ({ responses }) => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("connection reset"));
    for (const response of responses) fetchMock.mockResolvedValueOnce(jsonResponse(response));
    vi.stubGlobal("fetch", fetchMock);

    const result = await finishPolling(createLlamaParseProvider("test-key").extract({
      bytes: PDF_BYTES,
      filename: "invoice.pdf",
      mimeType: "application/pdf",
    }));

    expect(result).toEqual({ ok: false, error: "llamaparse unreachable: connection reset", extractor: "llamaparse-v2@hosted" });
    expect(fetchMock).toHaveBeenCalledTimes(responses.length + 1);
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
