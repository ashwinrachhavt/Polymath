// @vitest-environment jsdom
import { createElement as h } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The shell's focus dock reads the REAL live session on canonical routes.
 * value: protects=a session started on Work shows on other pages and links
 * back; nothing shows on Work, when none is live, or after a failed read;
 * the preview store's session never appears on a canonical route and its own
 * dock links to its own screen; fails_when=the dock is driven by the preview
 * store on real routes, claims a session ended because a fetch failed, or
 * shows a read from a previous page; seam=fetch and the pathname mocked at the
 * boundary; no_claim=owner/workspace scoping and liveness live in
 * getLiveFocusDock (integration tests own those) and visuals need a browser.
 */

let pathname = "/command-center/inbox";
const preview = {
  focus: null as null | { taskId: string; status: string },
  tasks: [{ id: "t1", title: "Preview task" }],
};
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    h("a", { href, ...rest }, children),
}));
vi.mock("@/components/workspace/workspace-provider", () => ({ useWorkspace: () => ({ state: preview }) }));

let FocusDock: (typeof import("@/components/shell/focus-dock"))["FocusDock"];

const live = { id: "s1", state: "running", title: "Write the memo" };
const respond = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);

beforeEach(async () => {
  preview.focus = null;
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

  it("a failed focus re-check marks the cache stale, and a navigation mount inside the window inherits the cue", async () => {
    // Regression (CI, 2026-11-05): the revalidate window used to serve the
    // focus re-check from the cache, so the failed read the e2e journey
    // forces never happened and the dock stayed "verified". The window
    // governs navigation mounts; a focus event must really re-read. The
    // resulting stale mark rides on the cache, so the next navigation mount
    // inside the window presents the last known session as stale, not fresh.
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ session: live }) } as Response)
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response);
    vi.stubGlobal("fetch", fetchSpy);
    const realNow = Date.now;
    const offset = { ms: 0 };
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset.ms);
    try {
      const first = render(h(FocusDock));
      const dock = await screen.findByLabelText("Focus session");
      expect(dock.textContent).not.toContain("last known");

      // The focus re-check happens inside the revalidate window - but past
      // the debounce (a focus event milliseconds after the first read is the
      // thrash the debounce exists to absorb) - and it still reads the
      // network, fails, and marks the session unverified.
      offset.ms = 3_000;
      window.dispatchEvent(new Event("focus"));
      await waitFor(() => expect(screen.getByLabelText("Focus session").textContent).toContain("last known"));
      expect(screen.getByLabelText("Focus session").textContent).toContain("status may be out of date");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      first.unmount();

      // A navigation remount inside the revalidate window reads the cache
      // without refetching - and inherits the stale mark, not a cleared one.
      render(h(FocusDock));
      await screen.findByLabelText("Focus session");
      expect(screen.getByLabelText("Focus session").textContent).toContain("status may be out of date");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
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

  it("never shows the preview store's session on a canonical route", async () => {
    preview.focus = { taskId: "t1", status: "running" };
    vi.stubGlobal("fetch", respond({ session: null }));
    render(h(FocusDock));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByLabelText("Preview focus session")).toBeNull();
    expect(screen.queryByLabelText("Focus session")).toBeNull();
  });

  it("on a preview route shows the preview session linking to its own screen, and never fetches the real one", () => {
    pathname = "/apps/neuralflow/tasks";
    preview.focus = { taskId: "t1", status: "running" };
    const spy = respond({ session: live });
    vi.stubGlobal("fetch", spy);
    render(h(FocusDock));
    const dock = screen.getByLabelText("Preview focus session");
    expect(dock.textContent).toContain("Preview task");
    expect(dock.querySelector("a")?.getAttribute("href")).toBe("/apps/neuralflow/focus");
    expect(spy).not.toHaveBeenCalled();
  });
});
