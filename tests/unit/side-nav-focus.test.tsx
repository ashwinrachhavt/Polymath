// @vitest-environment jsdom
import { createElement } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The sidebar is Linear-shaped: docked (pinned), floating over the page while
 * the pointer rests on the left edge (peek), or hidden. One control (the
 * button in the rail, the opener at the top left, and `[`) moves between
 * docked and not; the choice is remembered in this browser. Ordinary pages
 * start open and focus surfaces (Notes) start closed, each with its own
 * remembered choice.
 *
 * Value: protects=the rail states every page can show, that the opener and `[`
 * actually open the rail on a focus surface (they once only flipped a flag the
 * focus surface ignored, so the button did nothing), that Notes and the rest of
 * the app keep separate choices, that a hidden rail always leaves a focusable
 * way back, that folded groups persist and reach <html> before first paint,
 * that Up/Down walk the rail, that the workspace switcher sits in the rail, and
 * that under md the same content opens as a drawer; fails_when=the opener on
 * Notes leaves data-state="hidden", closing the rail on Notes closes it on the
 * inbox (or the reverse), `[` stops persisting, a keyboard collapse leaves
 * data-state="peek", a folded group's links stay in the arrow-key walk, or the
 * boot script paints the wrong state for a focus surface; seam=SideNav and the
 * sidebar boot script under jsdom with the pathname mocked;
 * no_claim=the slide animation, CSS media gates (pointer: fine, md), the
 * sidebar-pinned variant's first-paint layout, real hover geometry.
 */

const route = vi.hoisted(() => ({ pathname: "/command-center/inbox" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("@/app/(workspace)/settings/workspaces/actions", () => ({ switchWorkspaceAction: vi.fn() }));

import { SideNav } from "@/components/shell/side-nav";
import { SIDEBAR_BOOT_SCRIPT } from "@/lib/sidebar-pin";

const PAGE_KEY = "polymath.sidebar.pinned";
const FOCUS_KEY = "polymath.sidebar.focus-pinned";
const GROUPS_KEY = "polymath.sidebar.closed-groups";

function nav() {
  const element = document.querySelector("nav[aria-label='Workspace']");
  if (!element) throw new Error("rail not rendered");
  return element;
}

function button(label: string) {
  const element = document.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`);
  if (!element) throw new Error(`no "${label}" button`);
  return element;
}

const switcher = {
  currentWorkspaceId: "w1",
  memberships: [{ workspaceId: "w1", name: "Personal", role: "owner" }],
  pendingInvitations: [],
} as never;

describe("SideNav", () => {
  beforeEach(() => {
    route.pathname = "/command-center/inbox";
    window.localStorage.clear();
    // Most cases start from a person who hid the rail; the default is below.
    window.localStorage.setItem(PAGE_KEY, "0");
    document.documentElement.removeAttribute("data-sidebar-pinned");
    document.documentElement.removeAttribute("data-sidebar-closed");
  });

  it("starts hidden once the person hid it", () => {
    render(createElement(SideNav));
    expect(nav().getAttribute("data-state")).toBe("hidden");
  });

  it("peeks when the pointer reaches the left edge", () => {
    render(createElement(SideNav));
    const zone = document.querySelector("[data-peek-zone]");
    if (!zone) throw new Error("peek zone not rendered");
    fireEvent.mouseEnter(zone);
    expect(nav().getAttribute("data-state")).toBe("peek");
  });

  it("hides again 250ms after the pointer leaves the rail", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      render(createElement(SideNav));
      fireEvent.mouseEnter(document.querySelector("[data-peek-zone]")!);
      fireEvent.mouseLeave(nav());
      act(() => vi.advanceTimersByTime(200));
      expect(nav().getAttribute("data-state")).toBe("peek");
      act(() => vi.advanceTimersByTime(50));
      expect(nav().getAttribute("data-state")).toBe("hidden");
    } finally {
      vi.useRealTimers();
    }
  });

  it("toggles with [ and remembers it", () => {
    render(createElement(SideNav));
    fireEvent.keyDown(window, { key: "[" });
    expect(nav().getAttribute("data-state")).toBe("pinned");
    expect(window.localStorage.getItem(PAGE_KEY)).toBe("1");

    fireEvent.keyDown(window, { key: "[" });
    expect(nav().getAttribute("data-state")).toBe("hidden");
    expect(window.localStorage.getItem(PAGE_KEY)).toBe("0");
  });

  it("ignores [ typed into a field", () => {
    render(createElement("div", null, createElement("input", { "aria-label": "Title" }), createElement(SideNav)));
    const input = document.querySelector("input")!;
    fireEvent.keyDown(input, { key: "[" });
    expect(nav().getAttribute("data-state")).toBe("hidden");
    expect(window.localStorage.getItem(PAGE_KEY)).toBe("0");
  });

  it("ignores [ typed into a rich-text editor", () => {
    render(
      createElement(
        "div",
        null,
        createElement(
          "div",
          { contentEditable: true, suppressContentEditableWarning: true },
          createElement("p", null, "Note"),
        ),
        createElement(SideNav),
      ),
    );
    fireEvent.keyDown(document.querySelector("p")!, { key: "[" });
    expect(nav().getAttribute("data-state")).toBe("hidden");
  });

  it("opens pinned when the choice was saved", () => {
    window.localStorage.setItem(PAGE_KEY, "1");
    render(createElement(SideNav));
    expect(nav().getAttribute("data-state")).toBe("pinned");
  });

  it("always leaves a hidden rail a focusable opener that opens it", () => {
    render(createElement(SideNav));
    expect(nav().getAttribute("data-state")).toBe("hidden");
    const opener = button("Show sidebar");
    expect(opener.disabled).toBe(false);
    expect(opener.closest("[inert], [aria-hidden='true']")).toBeNull();
    opener.focus();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    expect(nav().getAttribute("data-state")).toBe("pinned");
    expect(window.localStorage.getItem(PAGE_KEY)).toBe("1");
    // The opener is gone; focus moved to the control that collapses.
    expect(document.activeElement).toBe(button("Collapse sidebar"));
  });

  it("hides at once when collapsed from the button with no mouse on the rail", () => {
    window.localStorage.setItem(PAGE_KEY, "1");
    render(createElement(SideNav));
    const collapse = button("Collapse sidebar");
    collapse.focus();
    fireEvent.click(collapse);
    expect(nav().getAttribute("data-state")).toBe("hidden");
    expect(window.localStorage.getItem(PAGE_KEY)).toBe("0");
    // The rail is inert now; focus landed on the way back, not on <body>.
    expect(document.activeElement).toBe(button("Show sidebar"));
  });

  it("stays a peek when collapsed with the mouse on the rail", () => {
    window.localStorage.setItem(PAGE_KEY, "1");
    render(createElement(SideNav));
    fireEvent.pointerEnter(nav(), { pointerType: "mouse" });
    fireEvent.click(button("Collapse sidebar"));
    expect(nav().getAttribute("data-state")).toBe("peek");
    // A peek offers to keep it open instead.
    expect(button("Keep sidebar open")).toBeTruthy();
  });

  it("hides at once when collapsed by touch", () => {
    window.localStorage.setItem(PAGE_KEY, "1");
    render(createElement(SideNav));
    fireEvent.pointerEnter(nav(), { pointerType: "touch" });
    fireEvent.click(button("Collapse sidebar"));
    expect(nav().getAttribute("data-state")).toBe("hidden");
  });

  it("mirrors the choice onto <html> for the first paint", () => {
    render(createElement(SideNav));
    fireEvent.keyDown(window, { key: "[" });
    expect(document.documentElement.hasAttribute("data-sidebar-pinned")).toBe(true);
    fireEvent.keyDown(window, { key: "[" });
    expect(document.documentElement.hasAttribute("data-sidebar-pinned")).toBe(false);
  });

  it("opens pinned on an ordinary page when no choice was saved", () => {
    window.localStorage.removeItem(PAGE_KEY);
    render(createElement(SideNav));
    expect(nav().getAttribute("data-state")).toBe("pinned");
    expect(document.querySelector("[data-peek-zone]")).toBeNull();
  });

  it("has no second, icon-rail collapse control", () => {
    render(createElement(SideNav));
    expect(document.querySelector("button[aria-label='Collapse navigation']")).toBeNull();
  });
});

describe("SideNav on a focus surface", () => {
  beforeEach(() => {
    route.pathname = "/polymath/notes";
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-sidebar-pinned");
  });

  it("starts closed even though ordinary pages start open", () => {
    render(createElement(SideNav, { focusSurface: true }));
    expect(nav().getAttribute("data-state")).toBe("hidden");
  });

  it("the opener opens it, and the choice is Notes' own", () => {
    // The regression: with the app-wide default (open) and a focus surface
    // that ignored it, the opener flipped the flag the wrong way and nothing
    // happened.
    window.localStorage.setItem(PAGE_KEY, "1");
    render(createElement(SideNav, { focusSurface: true }));
    expect(nav().getAttribute("data-state")).toBe("hidden");
    fireEvent.click(button("Show sidebar"));
    expect(nav().getAttribute("data-state")).toBe("pinned");
    expect(window.localStorage.getItem(FOCUS_KEY)).toBe("1");
    expect(window.localStorage.getItem(PAGE_KEY)).toBe("1");
  });

  it("[ opens it too", () => {
    render(createElement(SideNav, { focusSurface: true }));
    fireEvent.keyDown(window, { key: "[" });
    expect(nav().getAttribute("data-state")).toBe("pinned");
    expect(window.localStorage.getItem(FOCUS_KEY)).toBe("1");
  });

  it("closing it on Notes leaves the rest of the app open", () => {
    window.localStorage.setItem(PAGE_KEY, "1");
    window.localStorage.setItem(FOCUS_KEY, "1");
    render(createElement(SideNav, { focusSurface: true }));
    expect(nav().getAttribute("data-state")).toBe("pinned");
    fireEvent.click(button("Collapse sidebar"));
    expect(window.localStorage.getItem(FOCUS_KEY)).toBe("0");
    expect(window.localStorage.getItem(PAGE_KEY)).toBe("1");
  });

  it("still offers the edge peek when closed", () => {
    render(createElement(SideNav, { focusSurface: true }));
    fireEvent.mouseEnter(document.querySelector("[data-peek-zone]")!);
    expect(nav().getAttribute("data-state")).toBe("peek");
  });
});

describe("SideNav layout and behaviour", () => {
  beforeEach(() => {
    route.pathname = "/command-center/inbox";
    window.localStorage.clear();
    window.localStorage.setItem(PAGE_KEY, "1");
    document.documentElement.removeAttribute("data-sidebar-pinned");
    document.documentElement.removeAttribute("data-sidebar-closed");
  });

  it("puts the workspace switcher at the top of the rail", () => {
    render(createElement(SideNav, { workspaceSwitcher: switcher }));
    const trigger = within(nav() as HTMLElement).getByRole("button", { name: /Switch workspace, currently Personal/ });
    expect(trigger).toBeTruthy();
  });

  it("keeps every destination, in a Workspace group then a Manage group", () => {
    render(createElement(SideNav));
    const groups = [...document.querySelectorAll("[data-sidebar-group]")].map((group) => ({
      id: group.getAttribute("data-sidebar-group"),
      links: [...group.querySelectorAll("a")].map((link) => link.getAttribute("aria-label")),
    }));
    expect(groups.map((group) => group.id)).toEqual(["main", "shared"]);
    expect(groups[1]!.links).toEqual(["Reviews", "Activity", "Spending", "Settings"]);
    expect(groups[0]!.links).toContain("Notes");
    expect(groups[0]!.links).toContain("Document Vault");
    expect(groups[0]!.links).toHaveLength(12);
  });

  it("folds a group, remembers it, and mirrors it for the first paint", () => {
    render(createElement(SideNav));
    const head = screen.getByRole("button", { name: "Manage" });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(window.localStorage.getItem(GROUPS_KEY)!)).toEqual(["shared"]);
    expect(document.documentElement.getAttribute("data-sidebar-closed")).toBe("shared");
    fireEvent.click(head);
    expect(document.documentElement.hasAttribute("data-sidebar-closed")).toBe(false);
  });

  it("restores a folded group from storage", () => {
    window.localStorage.setItem(GROUPS_KEY, JSON.stringify(["main"]));
    render(createElement(SideNav));
    expect(screen.getByRole("button", { name: "Workspace" }).getAttribute("aria-expanded")).toBe("false");
    expect(document.documentElement.getAttribute("data-sidebar-closed")).toBe("main");
  });

  it("Up and Down walk the rail and a folded group leaves the walk", () => {
    window.localStorage.setItem(GROUPS_KEY, JSON.stringify(["shared"]));
    render(createElement(SideNav));
    const first = document.querySelector<HTMLAnchorElement>("[data-sidebar-group='main'] a")!;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Inbox");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "End" });
    // Last reachable control is the Manage heading: its links are folded away.
    expect(document.activeElement?.textContent).toContain("Manage");
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    // With no workspace data the first control is the wordmark link.
    expect(document.activeElement?.textContent).toContain("Polymath");
  });

  it("shows Search as a command row without adding the shortcut to its name", () => {
    render(createElement(SideNav));
    const search = button("Search workspace");
    expect(search.getAttribute("aria-keyshortcuts")).toContain("Meta+K");
    expect(search.textContent).toBe("Search");
  });

  it("opens the same content as a drawer from the menu button", () => {
    render(createElement(SideNav, { workspaceSwitcher: switcher }));
    fireEvent.click(button("Open menu"));
    const drawer = screen.getByRole("dialog", { name: "Navigation" });
    expect(within(drawer).getByRole("link", { name: "Notes" })).toBeTruthy();
    expect(within(drawer).getByRole("button", { name: /Switch workspace/ })).toBeTruthy();
  });
});

describe("sidebar boot script", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-sidebar-pinned");
    document.documentElement.removeAttribute("data-sidebar-closed");
    window.history.replaceState(null, "", "/command-center/inbox");
  });

  const boot = () => new Function(SIDEBAR_BOOT_SCRIPT)();

  it("marks <html> on an ordinary page unless the person closed the rail", () => {
    window.localStorage.setItem(PAGE_KEY, "0");
    boot();
    expect(document.documentElement.hasAttribute("data-sidebar-pinned")).toBe(false);
    window.localStorage.removeItem(PAGE_KEY);
    boot();
    expect(document.documentElement.hasAttribute("data-sidebar-pinned")).toBe(true);
  });

  it("starts a focus surface closed unless the person opened it there", () => {
    window.history.replaceState(null, "", "/polymath/notes/abc");
    boot();
    expect(document.documentElement.hasAttribute("data-sidebar-pinned")).toBe(false);
    window.localStorage.setItem(FOCUS_KEY, "1");
    boot();
    expect(document.documentElement.hasAttribute("data-sidebar-pinned")).toBe(true);
  });

  it("marks folded groups", () => {
    window.localStorage.setItem(GROUPS_KEY, JSON.stringify(["main", "shared"]));
    boot();
    expect(document.documentElement.getAttribute("data-sidebar-closed")).toBe("main shared");
  });
});
