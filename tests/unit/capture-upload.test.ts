import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The shared upload helper: every input surface that accepts a file posts it
 * to the one multipart captures route with an idempotency key, names the 4 MB
 * ceiling before any network round, and maps a problem response to a message
 * a person can act on.
 *
 * Value: protects=the single-upload-path contract and the client-side ceiling;
 * fails_when=a surface grows its own fetch or an over-limit file leaves the
 * browser; seam=uploadCaptureFile under jsdom with fetch stubbed at global.
 */

const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  fetchCalls.push({ url: String(input), init });
  return new Response(JSON.stringify({ captureId: "c-1" }), { status: 200 });
});

vi.stubGlobal("fetch", fetchMock);

import { eventFile, uploadCaptureFile } from "@/lib/capture-upload";

afterEach(() => {
  fetchMock.mockClear();
  fetchCalls.length = 0;
});

function pngFile(size = 100): File {
  // PNG magic so the bytes would survive real sniffing; the stub never looks.
  const bytes = new Uint8Array(Math.max(size, 8));
  bytes.set([0x89, 0x50, 0x4e, 0x47], 0);
  return new File([bytes], "shot.png", { type: "image/png" });
}

describe("uploadCaptureFile", () => {
  it("posts the file to the multipart captures route with an idempotency key", async () => {
    const result = await uploadCaptureFile(pngFile());
    expect(result).toEqual({ ok: true, captureId: "c-1", quarantined: false });
    const { url, init } = fetchCalls[0];
    expect(url).toBe("/api/v1/captures/file");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "idempotency-key": expect.any(String) });
    expect((init?.body as FormData).get("file")).toBeInstanceOf(File);
  });

  it("refuses an over-limit file before any network round", async () => {
    const result = await uploadCaptureFile(pngFile(5 * 1024 * 1024));
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("4 MB");
    expect(fetchCalls.length).toBe(0);
  });

  it("names the 4 MB limit on a server 413, whatever the body says", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("<html>too big</html>", { status: 413 }));
    const result = await uploadCaptureFile(pngFile());
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.message).toContain("4 MB");
  });

  it("surfaces the problem title from a failed upload", async () => {
    fetchMock.mockImplementationOnce(
      async () => new Response(JSON.stringify({ title: "Upload rejected." }), { status: 400 }),
    );
    const result = await uploadCaptureFile(pngFile());
    expect(result.ok ? "" : result.message).toBe("Upload rejected.");
  });

  it("reports a dropped connection instead of throwing", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    const result = await uploadCaptureFile(pngFile());
    expect(result.ok ? "" : result.message).toBe("Could not capture the file. Try again.");
  });
});

describe("eventFile", () => {
  it("returns the first file from a clipboard or drop payload", () => {
    const file = pngFile();
    expect(eventFile({ files: [file] })).toBe(file);
    expect(eventFile({ files: [] })).toBeNull();
    expect(eventFile(null)).toBeNull();
  });
});
