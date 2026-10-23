import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenRouterVisionProvider,
  DEFAULT_OCR_MODEL,
  openRouterVisionProviderFromEnv,
} from "@/integrations/extraction/openrouter-vision";
import { scannedPdf } from "../helpers/scanned-pdf";

/*
 * The vision-OCR rescue, pinned with generated scanned fixtures over a mocked
 * fetch — no live provider calls in CI, per agents/coding.md. The contract
 * points worth locking: opt-in env resolution (a present key alone never
 * enables a metered route), page-per-request PDF splitting with the file-parser
 * engine pinned to "native" (the price control), page-exact spans, and
 * partial page failures reported as a failed extraction that names the page.
 */

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

const completion = (text: string) => jsonResponse({ choices: [{ message: { content: text } }] });

describe("openrouter vision adapter (generated scanned fixture)", () => {
  it("the scanned fixture is real: the in-process floor refuses it for having no text layer", async () => {
    const { createPdfTextLayerProvider } = await import("@/integrations/extraction/pdf-text-layer");
    const result = await createPdfTextLayerProvider().extract({
      bytes: await scannedPdf(1),
      filename: "scan.pdf",
      mimeType: "application/pdf",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no text layer");
  });

  it("splits a scanned PDF into one native-engine request per page and maps text to page-exact spans", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completion("Page one body"))
      .mockResolvedValueOnce(completion("Page two body"));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenRouterVisionProvider("test-key", { baseUrl: "https://or.test" });
    const result = await provider.extract({
      bytes: await scannedPdf(2),
      filename: "scan.pdf",
      mimeType: "application/pdf",
    });

    expect(result).toMatchObject({
      ok: true,
      text: "Page one body\n\nPage two body",
      pageCount: 2,
      extractor: `openrouter-vision:${DEFAULT_OCR_MODEL}@hosted`,
    });
    expect(result.ok && result.spans).toEqual([
      { page: 1, start: 0, end: 13 },
      { page: 2, start: 15, end: 28 },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toBe("https://or.test/chat/completions");
      expect(init?.headers).toEqual({ Authorization: "Bearer test-key", "Content-Type": "application/json" });
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(DEFAULT_OCR_MODEL);
      expect(body.temperature).toBe(0);
      // The pin is the price control: native file processing, never the
      // per-page-priced OCR engine OpenRouter defaults to otherwise.
      expect(body.plugins).toEqual([{ id: "file-parser", pdf: { engine: "native" } }]);
      const filePart = body.messages[0].content.find((p: { type: string }) => p.type === "file");
      expect(filePart.file.file_data.startsWith("data:application/pdf;base64,")).toBe(true);
    }
    const names = fetchMock.mock.calls.map(([, init]) => {
      const body = JSON.parse(String(init?.body));
      return body.messages[0].content.find((p: { type: string }) => p.type === "file").file.filename;
    });
    expect(names.sort()).toEqual(["page-1.pdf", "page-2.pdf"]);
  });

  it("reads an image upload as a single page through an image_url part", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(completion("Photo of a receipt"));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createOpenRouterVisionProvider("test-key", { baseUrl: "https://or.test" });
    const result = await provider.extract({ bytes: PNG_BYTES, filename: "receipt.png", mimeType: "image/png" });

    expect(result).toMatchObject({ ok: true, text: "Photo of a receipt", pageCount: 1 });
    expect(result.ok && result.spans).toEqual([{ page: 1, start: 0, end: 18 }]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const imagePart = body.messages[0].content.find((p: { type: string }) => p.type === "image_url");
    expect(imagePart.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("treats a page the model could not read as a failed extraction naming the page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValueOnce(completion("UNREADABLE")).mockResolvedValueOnce(completion("Fine page")),
    );
    const provider = createOpenRouterVisionProvider("test-key", { baseUrl: "https://or.test" });
    const result = await provider.extract({
      bytes: await scannedPdf(2),
      filename: "scan.pdf",
      mimeType: "application/pdf",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("page 1");
  });

  it("fails over the page cap before any provider call, naming the limit", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenRouterVisionProvider("test-key", { baseUrl: "https://or.test", maxPages: 1 });
    const result = await provider.extract({
      bytes: await scannedPdf(2),
      filename: "scan.pdf",
      mimeType: "application/pdf",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("over the OCR page limit of 1");
      expect(result.error).toContain("OCR_MAX_PAGES");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps provider error detail out of the failure: status only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-ish provider body", { status: 429 })),
    );
    const provider = createOpenRouterVisionProvider("test-key", { baseUrl: "https://or.test" });
    const result = await provider.extract({ bytes: PNG_BYTES, filename: "receipt.png", mimeType: "image/png" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("429");
      expect(result.error).not.toContain("secret-ish provider body");
    }
  });

  it("refuses a type it cannot read without a provider call", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const provider = createOpenRouterVisionProvider("test-key", { baseUrl: "https://or.test" });
    const result = await provider.extract({ bytes: PNG_BYTES, filename: "notes.txt", mimeType: "text/plain" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not read text/plain");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("openRouterVisionProviderFromEnv: opt-in, never inferred", () => {
  const KEY_ENV = { OPENROUTER_API_KEY: "k" };

  it("a present OpenRouter key alone does not enable the metered route", () => {
    expect(openRouterVisionProviderFromEnv(KEY_ENV)).toBeNull();
    expect(openRouterVisionProviderFromEnv({})).toBeNull();
  });

  it("OCR_PROVIDER=off stays off even with a key", () => {
    expect(openRouterVisionProviderFromEnv({ ...KEY_ENV, OCR_PROVIDER: "off" })).toBeNull();
  });

  it("OCR_PROVIDER=openrouter without the key resolves nothing", () => {
    expect(openRouterVisionProviderFromEnv({ OCR_PROVIDER: "openrouter" })).toBeNull();
  });

  it("OCR_PROVIDER=openrouter with the key resolves the provider", () => {
    expect(openRouterVisionProviderFromEnv({ ...KEY_ENV, OCR_PROVIDER: "openrouter" })).not.toBeNull();
    expect(openRouterVisionProviderFromEnv({ ...KEY_ENV, OCR_PROVIDER: " OpenRouter " })).not.toBeNull();
  });

  it("a junk OCR_MAX_PAGES falls back to the default cap rather than disabling it", () => {
    expect(
      openRouterVisionProviderFromEnv({ ...KEY_ENV, OCR_PROVIDER: "openrouter", OCR_MAX_PAGES: "many" }),
    ).not.toBeNull();
  });
});
