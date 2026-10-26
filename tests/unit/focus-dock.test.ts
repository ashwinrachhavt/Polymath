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

import { FocusDock } from "@/components/shell/focus-dock";

const live = { id: "s1", state: "running", title: "Write the memo" };
const respond = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);

beforeEach(() => {
  preview.focus = null;
  pathname = "/command-center/inbox";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FocusDock", () => {
  it("shows the real live session on a canonical page and links back to Work", async () => {
    vi.stubGlobal("fetch", respond({ session: live }));
    render(h(FocusDock));
    const dock = await screen.findByLabelText("Focus session");
    expect(dock.textContent).toContain("Write the memo");
    expect(dock.textContent).toContain("Focus running");
    expect(dock.querySelector("a")?.getAttribute("href")).toBe("/neuralflow/work?view=today");
  });

  it("renders nothing when no session is live, on Work, or when the read fails", async () => {
    const none = respond({ session: null });
    vi.stubGlobal("fetch", none);
    const { unmount } = render(h(FocusDock));
    await waitFor(() => expect(none).toHaveBeenCalled());
    expect(screen.queryByLabelText("Focus session")).toBeNull();
    unmount();

    pathname = "/neuralflow/work";
    const onWork = respond({ session: live });
    vi.stubGlobal("fetch", onWork);
    render(h(FocusDock));
    expect(screen.queryByLabelText("Focus session")).toBeNull();
    expect(onWork).not.toHaveBeenCalled();
    cleanup();

    pathname = "/reviews";
    vi.stubGlobal("fetch", respond({}, false));
    render(h(FocusDock));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByLabelText("Focus session")).toBeNull();
  });

  it("a failed refresh keeps the last known session but marks it unverified, and a good read clears the mark", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ session: live }) } as Response)
      .mockResolvedValueOnce({ ok: false, json: async () => ({}) } as Response)
      .mockResolvedValue({ ok: true, json: async () => ({ session: live }) } as Response);
    vi.stubGlobal("fetch", fetchSpy);
    const view = render(h(FocusDock));
    const dock = await screen.findByLabelText("Focus session");
    expect(dock.textContent).not.toContain("last known");

    pathname = "/reviews";
    view.rerender(h(FocusDock));
    await waitFor(() => expect(screen.getByLabelText("Focus session").textContent).toContain("last known"));
    expect(screen.getByLabelText("Focus session").textContent).toContain("status may be out of date");

    pathname = "/activity";
    view.rerender(h(FocusDock));
    await waitFor(() => expect(screen.getByLabelText("Focus session").textContent).not.toContain("last known"));
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
