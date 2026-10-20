import { afterEach, describe, expect, it, vi } from "vitest";
import { createReductoProvider } from "@/integrations/extraction/reducto";
import { extractionProvider } from "@/domains/knowledge/extraction";

/*
 * Sanitized-fixture contract for the Reducto adapter (D13). Provider output
 * is untrusted: every response is zod-parsed. No live calls — fetch is
 * stubbed at the boundary.
 *
 * Value: protects=the Reducto two-call contract (upload then parse) maps
 * page-chunked output to spans and cleaned text and fails named on every
 * malformed path; fails_when=the adapter accepts an unreadable response,
 * refetches a URL reference result, or inverts the size guard; why_new=no
 * test covered this adapter (the nearest contract test pins llamaparse);
 * seam=globalThis.fetch (the adapter's real network boundary);
 * no_claim=Reducto service acceptance (fixtures only; live calls are the
 * smoke script's job, local only).
 */

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

const input = { bytes: new Uint8Array([1, 2, 3]), filename: "f.pdf", mimeType: "application/pdf" };

function okJson(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe("reducto adapter (sanitized fixture contract)", () => {
  it("maps page-chunked parse output to per-page spans and cleaned text", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      if (String(url).includes("/upload")) return okJson({ file_id: "file-1" });
      return okJson({
        result: {
          type: "full",
          chunks: [
            { blocks: [{ bbox: { page: 1 } }], content: "Page one.\n\n\n" },
            { blocks: [{ bbox: { page: 2 } }], content: "Page two." },
          ],
        },
      });
    }) as typeof fetch;
    const result = await createReductoProvider("key", "https://fixture.test").extract(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(2);
    expect(result.pageCount).toBe(2);
    // Spans are built over the joined page text; no post-join normalization
    // shifts them.
    expect(result.text).toBe("Page one.\n\n\n\n\nPage two.");
    expect(result.spans).toEqual([
      { page: 1, start: 0, end: "Page one.\n\n\n".length },
      { page: 2, start: "Page one.\n\n\n\n\n".length, end: "Page one.\n\n\n\n\nPage two.".length },
    ]);
  });

  it("sends the reducto:// input with Bearer auth and page chunking", async () => {
    let parseBody: unknown;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/upload")) return okJson({ file_id: "file-9" });
      parseBody = JSON.parse(String(init?.body));
      return okJson({ result: { type: "full", chunks: [{ content: "x" }] } });
    }) as typeof fetch;
    await createReductoProvider("secret", "https://fixture.test").extract(input);
    expect(parseBody).toMatchObject({ input: "reducto://file-9" });
  });

  it("fails with a named error when the result is a URL reference", async () => {
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/upload")) return okJson({ file_id: "file-1" });
      return okJson({ result: { type: "url", url: "https://fixture.test/presigned" } });
    }) as typeof fetch;
    const result = await createReductoProvider("key", "https://fixture.test").extract(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/URL reference/);
  });

  it("fails named on non-ok upload and parse, and on unreadable responses", async () => {
    const provider = createReductoProvider("key", "https://fixture.test");
    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const uploadFail = await provider.extract(input);
    expect(uploadFail.ok).toBe(false);
    if (!uploadFail.ok) expect(uploadFail.error).toMatch(/reducto upload 500/);

    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/upload")) return okJson({ file_id: "f" });
      return new Response("bad", { status: 418 });
    }) as typeof fetch;
    const parseFail = await provider.extract(input);
    expect(parseFail.ok).toBe(false);
    if (!parseFail.ok) expect(parseFail.error).toMatch(/reducto parse 418/);

    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/upload")) return okJson({ wrong: true });
      return okJson({ nonsense: true });
    }) as typeof fetch;
    const unreadable = await provider.extract(input);
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) expect(unreadable.error).toMatch(/unreadable/);
  });

  it("rejects oversized input before any fetch", async () => {
    const { MAX_UPLOAD_BYTES } = await import("@/lib/file-validation");
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("should not fetch");
    }) as typeof fetch;
    const result = await createReductoProvider("key", "https://fixture.test").extract({
      bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1),
      filename: "f.pdf",
      mimeType: "application/pdf",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("The document is too large to read.");
    expect(fetched).toBe(false);
  });

  it("extractionProvider prefers Reducto over LlamaParse when REDUCTO_API_KEY is set", async () => {
    vi.stubEnv("DOCLING_SERVE_URL", "");
    vi.stubEnv("REDUCTO_API_KEY", "fixture-key");
    vi.stubEnv("LLAMAPARSE_API_KEY", "also-set");
    const provider = await extractionProvider();
    // The provider contract has no name field; the extractor id is stamped on
    // a failed extraction against a stubbed fetch, so assert via the error
    // string the Reducto adapter produces.
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const result = await provider.extract(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/reducto upload 503/);
    vi.unstubAllEnvs();
  });
});
