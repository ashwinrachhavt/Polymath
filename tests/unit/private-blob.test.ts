import { beforeEach, describe, expect, it, vi } from "vitest";
import { get } from "@vercel/blob";
import { MAX_UPLOAD_BYTES } from "@/lib/file-validation";
import { readBlob } from "@/integrations/object-store/vercel-blob";

vi.mock("@vercel/blob", () => ({ get: vi.fn(), put: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

function stored(chunks: Uint8Array[], size: number, cancel = vi.fn()) {
  return {
    statusCode: 200 as const,
    stream: new ReadableStream<Uint8Array>({
      start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); },
      cancel,
    }),
    headers: new Headers(),
    blob: {
      url: "https://private.blob.vercel-storage.com/doc.pdf",
      downloadUrl: "https://private.blob.vercel-storage.com/doc.pdf",
      pathname: "doc.pdf", contentDisposition: "attachment", cacheControl: "private",
      uploadedAt: new Date(), etag: "fixture", contentType: "application/pdf", size,
    },
  };
}

describe("authenticated private Blob reads", () => {
  it("uses the SDK's authenticated private read and combines streamed bytes", async () => {
    vi.mocked(get).mockResolvedValueOnce(stored([new Uint8Array([1, 2]), new Uint8Array([3])], 3));
    const key = "https://private.blob.vercel-storage.com/doc.pdf";
    expect(await readBlob(key)).toEqual(new Uint8Array([1, 2, 3]));
    expect(get).toHaveBeenCalledWith(key, { access: "private", abortSignal: expect.any(AbortSignal) });
  });

  it("rejects oversized metadata without buffering the stream", async () => {
    const cancel = vi.fn();
    const result = stored([], MAX_UPLOAD_BYTES + 1);
    result.stream = new ReadableStream({ cancel });
    vi.mocked(get).mockResolvedValueOnce(result);
    await expect(readBlob("doc.pdf")).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("enforces the byte bound even when Blob metadata understates the size", async () => {
    const cancel = vi.fn();
    const result = stored([], 1);
    result.stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_UPLOAD_BYTES));
        controller.enqueue(new Uint8Array([1]));
      }, cancel,
    });
    vi.mocked(get).mockResolvedValueOnce(result);
    await expect(readBlob("doc.pdf")).rejects.toThrow("size limit");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not turn missing content into an empty document", async () => {
    vi.mocked(get).mockResolvedValueOnce(null);
    await expect(readBlob("missing.pdf")).rejects.toThrow("unavailable");
  });

  it("propagates authenticated read failures without falling back to a public fetch", async () => {
    vi.mocked(get).mockRejectedValueOnce(new Error("Blob access denied"));
    await expect(readBlob("private.pdf")).rejects.toThrow("access denied");
    expect(get).toHaveBeenCalledOnce();
  });
});
