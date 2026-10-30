import { afterEach, describe, expect, it, vi } from "vitest";
// The extension ships plain scripts; the state machine is exported for Node.
import Outbox from "../../extensions/chrome/outbox-core.js";

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

/*
 * The mode has to survive the whole path, not just the message: the worker
 * writes it to the outbox, chrome.storage serializes it to JSON, and deliver()
 * builds the POST body from the deserialized entry. A mode dropped anywhere in
 * that chain leaves selection and page captures indistinguishable on arrival.
 */
describe("capture outbox mode", () => {
  const ENTRY = {
    id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    text: "frag",
    url: "https://e.com/s",
    title: "Article",
    history: { title: "frag", url: "https://e.com/s", type: "selection" },
    destination: { origin: "https://polymath.example", tokenHash: "hash-a" },
  };

  it("keeps the mode through storage and onto the delivery body", () => {
    const queued = Outbox.makeEntry({ ...ENTRY, mode: "selection" }, 1_760_000_000_000);
    // Exactly what chrome.storage.local does to the array it persists.
    const loaded = JSON.parse(JSON.stringify([queued]))[0];
    expect(Outbox.deliveryBody(loaded)).toEqual({
      text: "frag",
      url: "https://e.com/s",
      title: "Article",
      mode: "selection",
    });
  });

  it("omits the mode from the body when the entry has none", () => {
    // An entry written by an extension build that predates the mode field.
    const queued = Outbox.makeEntry(ENTRY, 1_760_000_000_000);
    expect(queued.mode).toBeNull();
    const loaded = JSON.parse(JSON.stringify([queued]))[0];
    const body = Outbox.deliveryBody(loaded);
    expect("mode" in body).toBe(false);
    expect(body).toEqual({ text: "frag", url: "https://e.com/s", title: "Article" });
  });
});

/*
 * The service worker is a plain script, not a module: loading it runs
 * importScripts and its top-level chrome listener registrations. Stubbing
 * chrome and importScripts is enough to load it, and the registered listeners
 * let a test drive the real enqueue -> storage -> deliver path.
 *
 * When no worker can answer, api.js posts directly, so api.js is not loaded
 * here: the test supplies the two AlfredAPI methods deliver() reads.
 */
const SAVED_TOKEN = "saved-token";
const OUTBOX_KEY = "axiomCaptureOutbox";

type WorkerMessage = Record<string, unknown>;
type WorkerListener = (
  message: WorkerMessage,
  sender: unknown,
  sendResponse: (reply: unknown) => void,
) => boolean | undefined;

/** The hash background.js binds an entry to; a mismatch parks the entry. */
async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function loadWorker(options: {
  stored?: Record<string, unknown>;
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  api?: { base(): Promise<string>; token(): Promise<string | null> };
}) {
  vi.resetModules();
  const store: Record<string, unknown> = { ...options.stored };
  const listeners: WorkerListener[] = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const fetchMock = vi.fn(options.fetchImpl);
  vi.stubGlobal("fetch", fetchMock);
  // The worker runs as a service worker: importScripts writes onto self and
  // background.js reads both its globals back off self.
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("AbortSignal", { timeout: () => undefined });
  vi.stubGlobal("importScripts", (...files: string[]) => {
    for (const file of files) {
      if (file === "outbox-core.js") (globalThis as Record<string, unknown>).AxiomOutbox = Outbox;
      if (file === "api.js") {
        (globalThis as Record<string, unknown>).AlfredAPI = options.api || {
          base: async () => {
            throw new Error("AlfredAPI.base was not stubbed for this test");
          },
          token: async () => SAVED_TOKEN,
        };
      }
    }
  });
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in store ? { [key]: store[key] } : {})),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(store, values);
        }),
        remove: vi.fn(async () => undefined),
      },
    },
    runtime: {
      onMessage: { addListener: (fn: WorkerListener) => listeners.push(fn) },
      onInstalled: { addListener: vi.fn() },
      onStartup: { addListener: vi.fn() },
    },
    alarms: {
      clear: vi.fn(async () => undefined),
      create: vi.fn(),
      onAlarm: { addListener: (fn: (alarm: { name: string }) => void) => alarmListeners.push(fn) },
    },
    commands: { onCommand: { addListener: vi.fn() } },
    sidePanel: { open: vi.fn(async () => undefined) },
  });
  // @ts-expect-error background.js is a plain script, not a module.
  await import("../../extensions/chrome/background.js");

  const message = (payload: WorkerMessage) =>
    new Promise<unknown>((resolve) => {
      for (const listener of listeners) {
        if (listener(payload, {}, resolve) === true) return;
      }
      throw new Error(`no worker listener claimed ${String(payload.type)}`);
    });

  /** Fire the pump the way chrome.alarms does, and let its awaits settle. */
  const fireAlarm = async () => {
    for (const listener of alarmListeners) listener({ name: "axiom-capture-outbox-pump" });
    // pump() is async and the listener does not await it.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  /** Fire the pump and wait for the one request it must make. */
  const pumpByAlarm = async () => {
    for (const listener of alarmListeners) listener({ name: "axiom-capture-outbox-pump" });
    await vi.waitFor(() => {
      if (fetchMock.mock.calls.length === 0) throw new Error("the pump made no request");
    });
  };

  return { message, fireAlarm, pumpByAlarm, store, fetchMock };
}

describe("capture worker delivery", () => {
  it("delivers the mode the message carried", async () => {
    const { message, fetchMock, pumpByAlarm } = await loadWorker({
      api: { base: async () => "http://localhost:3000", token: async () => SAVED_TOKEN },
      fetchImpl: async () => new Response("{}", { status: 201 }),
    });

    const reply = await message({
      type: "AXIOM_ENQUEUE_CAPTURE",
      text: "frag",
      url: "https://e.com/s",
      title: "Article",
      mode: "selection",
    });

    // The enqueue reply no longer awaits delivery: the outbox write is the
    // durability contract and the pump runs unawaited. The entry delivers on
    // the next alarm/pump tick, so assert the async contract.
    expect(reply).toMatchObject({ ok: true, delivered: false });
    await pumpByAlarm();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      text: "frag",
      url: "https://e.com/s",
      title: "Article",
      mode: "selection",
    });
  });

  it("posts no mode key for an entry queued before the field existed", async () => {
    const legacy = {
      v: 1,
      id: "legacy-1",
      text: "old capture",
      url: "https://e.com/old",
      title: null,
      history: null,
      destination: { origin: "http://localhost:3000", tokenHash: await tokenHash(SAVED_TOKEN) },
      status: "queued",
      attempts: 0,
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_000,
      nextAttemptAt: 1_760_000_000_000,
      lastError: null,
    };
    const { pumpByAlarm, store, fetchMock } = await loadWorker({
      stored: { [OUTBOX_KEY]: [legacy] },
      api: { base: async () => "http://localhost:3000", token: async () => SAVED_TOKEN },
      fetchImpl: async () => new Response("{}", { status: 201 }),
    });

    await pumpByAlarm();

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ text: "old capture", url: "https://e.com/old" });
    expect("mode" in body).toBe(false);
    // Delivered, so the old entry leaves the outbox.
    await vi.waitFor(() => expect(store[OUTBOX_KEY]).toEqual([]));
  });

  it("treats a failed destination probe as a retryable failure, not a rejection", async () => {
    const legacy = {
      v: 1,
      id: "legacy-2",
      text: "kept",
      url: null,
      title: null,
      history: null,
      destination: { origin: "http://localhost:3000", tokenHash: await tokenHash(SAVED_TOKEN) },
      status: "queued",
      attempts: 0,
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_000,
      nextAttemptAt: 1_760_000_000_000,
      lastError: null,
    };
    const { fireAlarm, store, fetchMock } = await loadWorker({
      stored: { [OUTBOX_KEY]: [legacy] },
      api: {
        // AlfredAPI.base() throws when a STORED url fails its probe.
        base: async () => {
          throw new Error("The configured server is unreachable.");
        },
        token: async () => SAVED_TOKEN,
      },
      fetchImpl: async () => new Response("{}", { status: 201 }),
    });

    await fireAlarm();
    await fireAlarm();

    // The entry survives and is queued for another attempt, not dropped and
    // not left stranded in "sending".
    await vi.waitFor(() => {
      const [entry] = store[OUTBOX_KEY] as Array<Record<string, unknown>>;
      expect(entry).toBeDefined();
      expect(entry.status).toBe("queued");
      expect(entry.attempts).toBe(1);
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
