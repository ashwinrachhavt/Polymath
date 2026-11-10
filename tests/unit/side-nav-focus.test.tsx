// @vitest-environment jsdom
import { createElement } from "react";
import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Focus pages hide the rail (spec 5): it waits off-canvas, slides in from a
 * hover zone at the left edge, and `[` pins it open. The pin persists in
 * localStorage so the choice survives a reload.
 *
 * Value: protects=the four rail states a focus page can show (hidden, peek,
 * pinned), that a normal page never leaves the docked rail, that a hidden
 * rail always leaves a focusable way back (touch and keyboard have no edge
 * zone), that unpinning without a mouse on the rail never strands a peek,
 * and that the pin reaches <html> before first paint; fails_when=the rail
 * stays docked on a focus page, the edge zone does not reveal it, `[` stops
 * pinning or persisting, the opener goes missing or unfocusable, a keyboard
 * unpin leaves data-state="peek", or the boot script stops marking a pinned
 * browser; why_new=no test rendered the rail before; seam=SideNav and the
 * sidebar-pin boot script under jsdom with the pathname mocked;
 * no_claim=the slide animation, CSS media gates (pointer: fine, md), the
 * sidebar-pinned variant's first-paint layout, real hover geometry.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/polymath/notes" }));

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

describe("SideNav focus mode", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-sidebar-pinned");
  });

  it("starts hidden on a focus page", () => {
    render(createElement(SideNav, { focus: true }));
    expect(nav().getAttribute("data-state")).toBe("hidden");
  });

  it("peeks when the pointer reaches the left edge", () => {
    render(createElement(SideNav, { focus: true }));
    const zone = document.querySelector("[data-peek-zone]");
    if (!zone) throw new Error("peek zone not rendered");
    fireEvent.mouseEnter(zone);
    expect(nav().getAttribute("data-state")).toBe("peek");
  });

  it("hides again 250ms after the pointer leaves the rail", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      render(createElement(SideNav, { focus: true }));
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
    render(createElement(SideNav, { focus: true }));
    fireEvent.keyDown(window, { key: "[" });
    expect(nav().getAttribute("data-state")).toBe("pinned");
    expect(window.localStorage.getItem(PINNED_KEY)).toBe("1");

    fireEvent.keyDown(window, { key: "[" });
    expect(nav().getAttribute("data-state")).toBe("hidden");
    expect(window.localStorage.getItem(PINNED_KEY)).toBe("0");
  });

  it("ignores [ typed into a field", () => {
    render(
      createElement(
        "div",
        null,
        createElement("input", { "aria-label": "Title" }),
        createElement(SideNav, { focus: true }),
      ),
    );
    const input = document.querySelector("input")!;
    fireEvent.keyDown(input, { key: "[" });
    expect(nav().getAttribute("data-state")).toBe("hidden");
    expect(window.localStorage.getItem(PINNED_KEY)).toBeNull();
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
        createElement(SideNav, { focus: true }),
      ),
    );
    fireEvent.keyDown(document.querySelector("p")!, { key: "[" });
    expect(nav().getAttribute("data-state")).toBe("hidden");
  });

  it("opens pinned when the pin was saved", () => {
    window.localStorage.setItem(PINNED_KEY, "1");
    render(createElement(SideNav, { focus: true }));
    expect(nav().getAttribute("data-state")).toBe("pinned");
  });

  it("always leaves a hidden rail a focusable opener that pins it", () => {
    render(createElement(SideNav, { focus: true }));
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
    render(createElement(SideNav, { focus: true }));
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
    render(createElement(SideNav, { focus: true }));
    fireEvent.pointerEnter(nav(), { pointerType: "mouse" });
    fireEvent.click(button("Keep sidebar open"));
    expect(nav().getAttribute("data-state")).toBe("peek");
  });

  it("hides at once when unpinned by touch", () => {
    window.localStorage.setItem(PINNED_KEY, "1");
    render(createElement(SideNav, { focus: true }));
    fireEvent.pointerEnter(nav(), { pointerType: "touch" });
    fireEvent.click(button("Keep sidebar open"));
    expect(nav().getAttribute("data-state")).toBe("hidden");
  });

  it("mirrors the pin onto <html> for the first paint", () => {
    render(createElement(SideNav, { focus: true }));
    fireEvent.keyDown(window, { key: "[" });
    expect(document.documentElement.hasAttribute("data-sidebar-pinned")).toBe(true);
    fireEvent.keyDown(window, { key: "[" });
    expect(document.documentElement.hasAttribute("data-sidebar-pinned")).toBe(false);
  });

  it("marks <html> from the boot script only when the pin was saved", () => {
    new Function(SIDEBAR_PIN_BOOT_SCRIPT)();
    expect(document.documentElement.hasAttribute("data-sidebar-pinned")).toBe(false);
    window.localStorage.setItem(PINNED_KEY, "1");
    new Function(SIDEBAR_PIN_BOOT_SCRIPT)();
    expect(document.documentElement.hasAttribute("data-sidebar-pinned")).toBe(true);
  });

  it("stays docked off a focus page, whatever the pin or the keys say", () => {
    window.localStorage.setItem(PINNED_KEY, "0");
    render(createElement(SideNav));
    expect(nav().getAttribute("data-state")).toBe("docked");
    expect(document.querySelector("[data-peek-zone]")).toBeNull();
    fireEvent.keyDown(window, { key: "[" });
    expect(nav().getAttribute("data-state")).toBe("docked");
    expect(window.localStorage.getItem(PINNED_KEY)).toBe("0");
  });
});
