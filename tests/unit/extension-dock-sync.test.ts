// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The companion's in-page dock lists recent captures with their sync state.
 * The background worker delivers a capture after the dock has drawn it as
 * "pending sync" and then rewrites captureHistory; the dock must redraw.
 *
 * Value: protects=the dock's label following the worker's real delivery
 * state; fails_when=the dock keeps showing "pending sync" for a capture the
 * worker already synced; seam=content.js and api.js loaded as classic scripts
 * against a fake chrome.storage under jsdom; no_claim=the worker's delivery
 * itself (capture-outbox.test.ts), real extension messaging.
 */

type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

function fakeChrome() {
  const store: Record<string, unknown> = {};
  const listeners: Listener[] = [];
  return {
    store,
    runtime: {
      id: "test-extension",
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(async () => ({})),
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    storage: {
      local: {
        get: vi.fn((key: string, callback?: (result: Record<string, unknown>) => void) => {
          const result = { [key]: store[key] };
          if (callback) callback(result);
          return Promise.resolve(result);
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
          const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }]));
          for (const listener of listeners) listener(changes, "local");
        }),
      },
      onChanged: { addListener: vi.fn((listener: Listener) => listeners.push(listener)) },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  document.body.innerHTML = "";
  delete (window as typeof window & { __alfredContentLoaded?: boolean }).__alfredContentLoaded;
});

const recentText = () => document.querySelector("#alfred-recent-captures")?.textContent ?? "";

describe("companion dock sync label", () => {
  it("drops 'pending sync' once the worker marks the capture synced", async () => {
    const chrome = fakeChrome();
    chrome.store.captureHistory = [
      { title: "[Page] Probe", type: "page-capture", delivery: "pending", outboxId: "o1", timestamp: Date.now() },
    ];
    vi.stubGlobal("chrome", chrome);

    // @ts-expect-error classic extension scripts export through window.
    await import("../../extensions/chrome/api.js");
    // @ts-expect-error classic extension script; runs for its side effects.
    await import("../../extensions/chrome/content.js");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", altKey: true }));
    await vi.waitFor(() => expect(recentText()).toContain("pending sync"));

    const api = (
      window as typeof window & {
        AlfredAPI: { updateCaptureHistoryByOutboxId(id: string, patch: object): Promise<void> };
      }
    ).AlfredAPI;
    await api.updateCaptureHistoryByOutboxId("o1", { delivery: "synced" });

    await vi.waitFor(() => expect(recentText()).not.toContain("pending sync"));
    expect(recentText()).toContain("[Page] Probe");
  });
});
