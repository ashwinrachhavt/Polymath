import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * extensions/chrome/api.js assigns window.AlfredAPI at module load and touches
 * window/chrome/location only inside functions or behind its trailing root
 * guard, so it imports under Vitest once the globals are stubbed. Each test
 * gets a fresh module instance so the cached base URL never leaks across.
 */

type CaptureResult = { ok: boolean; delivered: boolean; unconfirmed?: boolean };
type EnqueueMessage = { type: string; text: string; url?: string; title?: string; mode?: string };
type Api = {
  base(): Promise<string>;
  queueCapture(input: Record<string, unknown>): Promise<CaptureResult>;
  capturePage(input: Record<string, unknown>): Promise<CaptureResult>;
  captureSelection(input: Record<string, unknown>): Promise<CaptureResult>;
};

async function loadApi(chromeStub: Record<string, unknown>): Promise<Api> {
  vi.resetModules();
  const win: Record<string, unknown> = {};
  vi.stubGlobal("window", win);
  vi.stubGlobal("chrome", chromeStub);
  // @ts-expect-error api.js is a plain script, not a module: it assigns window.AlfredAPI.
  await import("../../extensions/chrome/api.js");
  return win.AlfredAPI as Api;
}

function storageStub(values: Record<string, unknown> = {}) {
  return {
    local: {
      get: vi.fn(async (key: string) => (key in values ? { [key]: values[key] } : {})),
      set: vi.fn(async () => undefined),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Restore the file-wide pinned clock the setup file installed.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
});

describe("capture client", () => {
  it("reports an unanswered enqueue as unconfirmed, not as a save", async () => {
    const api = await loadApi({
      // The worker takes the message and never answers: Chrome killed it mid-await.
      runtime: { id: "x", sendMessage: vi.fn() },
      storage: storageStub(),
    });
    vi.useFakeTimers();
    const pending = api.captureSelection({ url: "https://e.com/a", selectedText: "frag" });
    await vi.advanceTimersByTimeAsync(30000);
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(false);
    expect(result.unconfirmed).toBe(true);
  });

  it("throws instead of falling back to localhost when the configured server is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const api = await loadApi({
      runtime: { id: "x", sendMessage: vi.fn() },
      storage: storageStub({ alfredUrlMigrated_v2: true, alfredBaseUrl: "https://polymath.example" }),
    });
    await expect(api.base()).rejects.toThrow(/unreachable/i);
  });

  it("keeps the default server on first run with nothing stored", async () => {
    const api = await loadApi({
      runtime: { id: "x", sendMessage: vi.fn() },
      storage: storageStub(),
    });
    await expect(api.base()).resolves.toBe("http://localhost:3000");
  });

  it("states the arrival mode and leaves the title free of a mode suffix", async () => {
    const sent: EnqueueMessage[] = [];
    const sendMessage = vi.fn((message: EnqueueMessage, callback: (value: unknown) => void) => {
      sent.push(message);
      callback({ ok: true, delivered: true });
      return Promise.resolve({ ok: true, delivered: true });
    });
    const api = await loadApi({ runtime: { id: "x", sendMessage }, storage: storageStub() });

    await api.capturePage({ url: "https://e.com/p", title: "Page", content: "body" });
    const [pageMessage] = sent.slice(-1);
    expect(pageMessage.mode).toBe("page");
    expect(pageMessage.title).toBe("Page");

    await api.captureSelection({ url: "https://e.com/s", title: "Article", selectedText: "frag" });
    const [selectionMessage] = sent.slice(-1);
    expect(selectionMessage.mode).toBe("selection");
    expect(selectionMessage.title).toBe("Article");
  });

  it("forwards the mode on the direct-POST path when no worker answers", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return new Response(JSON.stringify({ capture: { id: "capture-1" } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const api = await loadApi({ storage: storageStub() });

    const result = await api.capturePage({ url: "https://e.com/direct", title: "Direct", content: "body" });
    expect(result).toEqual({ ok: true, delivered: true });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(String(url)).toBe("http://localhost:3000/api/v1/captures");
    expect(JSON.parse(String(init?.body))).toMatchObject({ mode: "page", url: "https://e.com/direct" });
  });
});
