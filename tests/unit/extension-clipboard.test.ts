import { afterEach, describe, expect, it, vi } from "vitest";

type ExtensionApi = {
  readClipboardPayload(): Promise<{
    text: string;
    image: { filename: string; mimeType: string; base64: string } | null;
  }>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("extension clipboard capture", () => {
  it("reads copied text and image bytes together", async () => {
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    const item = {
      types: ["text/plain", "image/png"],
      getType: vi.fn(async (type: string) =>
        type === "text/plain" ? new Blob(["Copied headline and body"], { type: "text/plain" }) : png,
      ),
    };
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("navigator", { clipboard: { read: vi.fn(async () => [item]) } });

    // @ts-expect-error classic extension script exports through window.AlfredAPI.
    await import("../../extensions/chrome/api.js");
    const api = (globalThis as typeof globalThis & { AlfredAPI: ExtensionApi }).AlfredAPI;
    const payload = await api.readClipboardPayload();

    expect(payload.text).toBe("Copied headline and body");
    expect(payload.image).toMatchObject({ filename: "clipboard-image.png", mimeType: "image/png" });
    expect(atob(payload.image!.base64)).toBe(String.fromCharCode(0x89, 0x50, 0x4e, 0x47));
  });

  it("rejects clipboard images above the upload limit instead of silently dropping them", async () => {
    const oversized = new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: "image/png" });
    const item = {
      types: ["image/png"],
      getType: vi.fn(async () => oversized),
    };
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("self", globalThis);
    vi.stubGlobal("navigator", { clipboard: { read: vi.fn(async () => [item]) } });

    // @ts-expect-error classic extension script exports through window.AlfredAPI.
    await import("../../extensions/chrome/api.js");
    const api = (globalThis as typeof globalThis & { AlfredAPI: ExtensionApi }).AlfredAPI;
    await expect(api.readClipboardPayload()).rejects.toThrow(/4 MB or smaller/);
  });
});
