// @vitest-environment jsdom
import { createElement } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Every page shares one rail (spec 5): pinned open, or hidden off-canvas,
 * sliding in from a hover zone at the left edge. `[` toggles the pin, which
 * persists in localStorage; with no saved choice the rail is pinned.
 *
 * Value: protects=the rail states every page can show (hidden, peek,
 * pinned), the pinned default, that a hidden rail always leaves a focusable
 * way back (touch and keyboard have no edge zone), that unpinning without a
 * mouse on the rail never strands a peek, and that the pin reaches <html>
 * before first paint; fails_when=an ordinary page keeps a docked rail, the
 * edge zone does not reveal it, `[` stops pinning or persisting, the opener
 * goes missing or unfocusable, a keyboard unpin leaves data-state="peek", or
 * the boot script stops marking a pinned browser; seam=SideNav and the
 * sidebar-pin boot script under jsdom with the pathname mocked;
 * no_claim=the slide animation, CSS media gates (pointer: fine, md), the
 * sidebar-pinned variant's first-paint layout, real hover geometry.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/command-center/inbox" }));

import { SideNav } from "@/components/shell/side-nav";
import { SIDEBAR_PIN_BOOT_SCRIPT } from "@/lib/sidebar-pin";

const PINNED_KEY = "polymath.sidebar.pinned";

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

describe("SideNav", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // Most cases start from a person who hid the rail; the default is below.
    window.localStorage.setItem(PINNED_KEY, "0");
    document.documentElement.removeAttribute("data-sidebar-pinned");
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

  it("pins with [ and remembers it", () => {
    render(createElement(SideNav));
    fireEvent.keyDown(window, { key: "[" });
    expect(nav().getAttribute("data-state")).toBe("pinned");
    expect(window.localStorage.getItem(PINNED_KEY)).toBe("1");

    fireEvent.keyDown(window, { key: "[" });
    expect(nav().getAttribute("data-state")).toBe("hidden");
    expect(window.localStorage.getItem(PINNED_KEY)).toBe("0");
  });

  it("ignores [ typed into a field", () => {
    render(createElement("div", null, createElement("input", { "aria-label": "Title" }), createElement(SideNav)));
    const input = document.querySelector("input")!;
    fireEvent.keyDown(input, { key: "[" });
    expect(nav().getAttribute("data-state")).toBe("hidden");
    expect(window.localStorage.getItem(PINNED_KEY)).toBe("0");
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

  it("opens pinned when the pin was saved", () => {
    window.localStorage.setItem(PINNED_KEY, "1");
    render(createElement(SideNav));
    expect(nav().getAttribute("data-state")).toBe("pinned");
  });

  it("always leaves a hidden rail a focusable opener that pins it", () => {
    render(createElement(SideNav));
    expect(nav().getAttribute("data-state")).toBe("hidden");
    const opener = button("Show sidebar");
    expect(opener.disabled).toBe(false);
    expect(opener.closest("[inert], [aria-hidden='true']")).toBeNull();
    opener.focus();
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    expect(nav().getAttribute("data-state")).toBe("pinned");
    expect(window.localStorage.getItem(PINNED_KEY)).toBe("1");
    // The opener is gone; focus moved to the control that unpins.
    expect(document.activeElement).toBe(button("Keep sidebar open"));
  });

  it("hides at once when unpinned from the button with no mouse on the rail", () => {
    window.localStorage.setItem(PINNED_KEY, "1");
    render(createElement(SideNav));
    const pin = button("Keep sidebar open");
    pin.focus();
    fireEvent.click(pin);
    expect(nav().getAttribute("data-state")).toBe("hidden");
    expect(window.localStorage.getItem(PINNED_KEY)).toBe("0");
    // The rail is inert now; focus landed on the way back, not on <body>.
    expect(document.activeElement).toBe(button("Show sidebar"));
  });

  it("stays a peek when unpinned with the mouse on the rail", () => {
    window.localStorage.setItem(PINNED_KEY, "1");
    render(createElement(SideNav));
    fireEvent.pointerEnter(nav(), { pointerType: "mouse" });
    fireEvent.click(button("Keep sidebar open"));
    expect(nav().getAttribute("data-state")).toBe("peek");
  });

  it("hides at once when unpinned by touch", () => {
    window.localStorage.setItem(PINNED_KEY, "1");
    render(createElement(SideNav));
    fireEvent.pointerEnter(nav(), { pointerType: "touch" });
    fireEvent.click(button("Keep sidebar open"));
    expect(nav().getAttribute("data-state")).toBe("hidden");
  });

  it("mirrors the pin onto <html> for the first paint", () => {
    render(createElement(SideNav));
    fireEvent.keyDown(window, { key: "[" });
    expect(document.documentElement.hasAttribute("data-sidebar-pinned")).toBe(true);
    fireEvent.keyDown(window, { key: "[" });
    expect(document.documentElement.hasAttribute("data-sidebar-pinned")).toBe(false);
  });

  it("marks <html> from the boot script unless the person hid the rail", () => {
    new Function(SIDEBAR_PIN_BOOT_SCRIPT)();
    expect(document.documentElement.hasAttribute("data-sidebar-pinned")).toBe(false);
    window.localStorage.removeItem(PINNED_KEY);
    new Function(SIDEBAR_PIN_BOOT_SCRIPT)();
    expect(document.documentElement.hasAttribute("data-sidebar-pinned")).toBe(true);
  });

  it("opens pinned when no choice was saved", () => {
    window.localStorage.removeItem(PINNED_KEY);
    render(createElement(SideNav));
    expect(nav().getAttribute("data-state")).toBe("pinned");
    expect(document.querySelector("[data-peek-zone]")).toBeNull();
  });

  it("has no second, icon-rail collapse control", () => {
    render(createElement(SideNav));
    expect(document.querySelector("button[aria-label='Collapse navigation']")).toBeNull();
  });
});
