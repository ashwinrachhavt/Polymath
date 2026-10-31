import { describe, expect, it, vi } from "vitest";

/*
 * The blob-serve handler is the one place a storage fault becomes a client
 * answer. The packets route shipped without this guard: a missing or unread
 * blob was an unhandled 500 with a raw stack trace instead of a problem the
 * download button could show. These cases pin the fault mapping (ENOENT ->
 * 404 file_unavailable, anything else -> 500 file_read_failed) and the
 * response headers each surface depends on.
 */

import { readBlob } from "@/integrations/object-store/object-store";

vi.mock("@/integrations/object-store/object-store", () => ({ readBlob: vi.fn() }));

import { serveBlob } from "@/lib/blob-serve";

const readBlobMock = vi.mocked(readBlob);

const bytes = new Uint8Array([1, 2, 3, 4]);

function baseInput() {
  return {
    storageKey: "blobs/abc",
    contentType: "application/pdf",
    inline: true,
    filename: 're"port.pdf',
    sizeBytes: 4,
    label: "document",
  };
}

describe("serveBlob", () => {
  it("serves bytes with the inline headers", async () => {
    readBlobMock.mockResolvedValue(bytes);
    const response = await serveBlob(baseInput());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Length")).toBe("4");
    expect(response.headers.get("Content-Disposition")).toBe('inline; filename="report.pdf"');
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=60");
  });

  it("forces octet-stream attachment when not inline", async () => {
    readBlobMock.mockResolvedValue(bytes);
    const response = await serveBlob({ ...baseInput(), inline: false, cacheControl: "private, no-store" });
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="report.pdf"');
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("answers ENOENT with the 404 unavailable problem", async () => {
    readBlobMock.mockRejectedValue(Object.assign(new Error("no such file"), { code: "ENOENT" }));
    const response = await serveBlob(baseInput());
    expect(response.status).toBe(404);
    const problem = (await response.json()) as { code: string; title: string };
    expect(problem.code).toBe("file_unavailable");
    expect(problem.title).toContain("document");
  });

  it("answers any other read failure with the 500 problem — the guard the packet route lacked", async () => {
    readBlobMock.mockRejectedValue(new Error("ECONNRESET from storage"));
    const response = await serveBlob({ ...baseInput(), label: "packet" });
    expect(response.status).toBe(500);
    const problem = (await response.json()) as { code: string; title: string };
    expect(problem.code).toBe("file_read_failed");
    expect(problem.title).toContain("packet");
  });

  it("falls back to the byte length when the row has no size", async () => {
    readBlobMock.mockResolvedValue(bytes);
    const response = await serveBlob({ ...baseInput(), sizeBytes: null });
    expect(response.headers.get("Content-Length")).toBe(String(bytes.byteLength));
  });

  it("carries per-surface extra headers", async () => {
    readBlobMock.mockResolvedValue(bytes);
    const response = await serveBlob({ ...baseInput(), headers: { "X-Content-SHA256": "deadbeef" } });
    expect(response.headers.get("X-Content-SHA256")).toBe("deadbeef");
  });
});
