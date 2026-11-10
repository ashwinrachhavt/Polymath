// @vitest-environment jsdom
import { createElement as h } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The shell's focus dock reads the REAL live session on canonical routes.
 * value: protects=a session started on Work shows on other pages and links
 * back; nothing shows on Work, when none is live, or after a failed read;
 * fails_when=the dock claims a session ended because a fetch failed, or
 * shows a read from a previous page; seam=fetch and the pathname mocked at the
 * boundary; no_claim=owner/workspace scoping and liveness live in
 * getLiveFocusDock (integration tests own those) and visuals need a browser.
 */

let pathname = "/command-center/inbox";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    h("a", { href, ...rest }, children),
}));

let FocusDock: (typeof import("@/components/shell/focus-dock"))["FocusDock"];

const live = { id: "s1", state: "running", title: "Write the memo" };
const respond = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);

beforeEach(async () => {
  pathname = "/command-center/inbox";
  // The dock keeps its bounded-fetch cache and debounce window at module
  // scope (spec W4), so each test loads a fresh module instance instead of
  // inheriting the previous test's cache.
  vi.resetModules();
  FocusDock = (await import("@/components/shell/focus-dock")).FocusDock;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FocusDock", () => {
  it("shows the real live session on a canonical page and links back to Focus", async () => {
    vi.stubGlobal("fetch", respond({ session: live }));
    render(h(FocusDock));
    const dock = await screen.findByLabelText("Focus session");
    expect(dock.textContent).toContain("Write the memo");
    expect(dock.textContent).toContain("Focus running");
    expect(dock.querySelector("a")?.getAttribute("href")).toBe("/neuralflow/focus");
  });

  it("renders nothing when no session is live, on the Focus screen, or when the read fails", async () => {
    const none = respond({ session: null });
    vi.stubGlobal("fetch", none);
    const { unmount } = render(h(FocusDock));
    await waitFor(() => expect(none).toHaveBeenCalled());
    expect(screen.queryByLabelText("Focus session")).toBeNull();
    unmount();

    pathname = "/neuralflow/focus";
    const onFocus = respond({ session: live });
    vi.stubGlobal("fetch", onFocus);
    render(h(FocusDock));
    expect(screen.queryByLabelText("Focus session")).toBeNull();
    expect(onFocus).not.toHaveBeenCalled();
    cleanup();

    pathname = "/reviews";
    vi.stubGlobal("fetch", respond({}, false));
    render(h(FocusDock));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByLabelText("Focus session")).toBeNull();
  });

  it("a failed refresh keeps the last known session but marks it unverified, and a good read clears the mark", async () => {
    // Inside the revalidate window the dock reuses its cache and never
    // refetches; the test bends Date.now past the window where it needs the
    // refetch paths (real timers, so RTL's waitFor behaves).
    const realNow = Date.now;
    const offset = { ms: 0 };
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset.ms);
    try {
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ session: live }) } as Response)
        .mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response)
        .mockResolvedValue({ ok: true, json: async () => ({ session: live }) } as Response);
      vi.stubGlobal("fetch", fetchSpy);
      const view = render(h(FocusDock));
      const dock = await screen.findByLabelText("Focus session");
      expect(dock.textContent).not.toContain("last known");

      // Past the revalidate window a navigation re-reads; a failed read
      // keeps the session on screen but marks it unverified.
      offset.ms = 31_000;
      pathname = "/reviews";
      view.rerender(h(FocusDock));
      await waitFor(() => expect(screen.getByLabelText("Focus session").textContent).toContain("last known"));
      expect(screen.getByLabelText("Focus session").textContent).toContain("status may be out of date");

      // A good read clears the mark. Age past the debounce window too: a
      // navigation in the same instant as the failed refetch is exactly the
      // thrash the debounce exists to absorb.
      offset.ms = 64_000;
      pathname = "/activity";
      view.rerender(h(FocusDock));
      await waitFor(() => expect(screen.getByLabelText("Focus session").textContent).not.toContain("last known"));
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("routine focus events inside the revalidate window reuse the verified cache instead of re-reading", async () => {
    // The request storm (2026-11-06): every window focus and visibility
    // event fired a FORCED network read that bypassed the revalidate window,
    // so an otherwise idle open tab hit /api/v1/focus/live on every refocus.
    // A verified fresh cache answers focus events the same way it answers
    // navigation mounts; only an expired or stale cache re-reads.
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ session: live }) } as Response);
    vi.stubGlobal("fetch", fetchSpy);
    render(h(FocusDock));
    const dock = await screen.findByLabelText("Focus session");
    expect(dock.textContent).not.toContain("last known");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 10; i++) {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Focus session").textContent).not.toContain("last known");
  });

  it("a failed re-check past the window marks the session unverified, and the next focus event retries the network", async () => {
    // The focus event stays the failed read's recovery path: once a re-check
    // fails, the next focus event must attempt the network again — the
    // attempt may never be silently dropped — and a good read clears the
    // mark. (CI regression 2026-11-05, re-pinned after the storm fix.)
    const realNow = Date.now;
    const offset = { ms: 0 };
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset.ms);
    try {
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ session: live }) } as Response)
        .mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response)
        .mockResolvedValue({ ok: true, json: async () => ({ session: live }) } as Response);
      vi.stubGlobal("fetch", fetchSpy);
      render(h(FocusDock));
      const dock = await screen.findByLabelText("Focus session");
      expect(dock.textContent).not.toContain("last known");

      // Inside the window a focus event is served from the cache: no re-read.
      offset.ms = 3_000;
      window.dispatchEvent(new Event("focus"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Past the window the re-check really reads; a failure keeps the last
      // known session on screen but marks it unverified.
      offset.ms = 31_000;
      window.dispatchEvent(new Event("focus"));
      await waitFor(() => expect(screen.getByLabelText("Focus session").textContent).toContain("last known"));
      expect(screen.getByLabelText("Focus session").textContent).toContain("status may be out of date");
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      // The recovery attempt is never dropped: the next focus event hits the
      // network again, and a good read clears the mark. Simultaneous events
      // (focus landing on visibilitychange) join the one in-flight retry -
      // the count moves by one, so a failing endpoint is never retried in
      // parallel storms of its own.
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(screen.getByLabelText("Focus session").textContent).not.toContain("last known"));
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("the real session also follows the owner onto /settings and /activity (preview-banner routes)", async () => {
    for (const path of ["/settings", "/activity"]) {
      pathname = path;
      vi.stubGlobal("fetch", respond({ session: live }));
      const view = render(h(FocusDock));
      expect((await screen.findByLabelText("Focus session")).textContent).toContain("Write the memo");
      view.unmount();
    }
  });
});
