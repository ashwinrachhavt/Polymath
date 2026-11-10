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
 * pinned) and that a normal page never leaves the docked rail; fails_when=the
 * rail stays docked on a focus page, the edge zone does not reveal it, or `[`
 * stops pinning or stops persisting; why_new=no test rendered the rail before;
 * seam=SideNav under jsdom with the pathname mocked; no_claim=the slide
 * animation, the 12px zone's pointer: fine gate (CSS), real hover geometry.
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/polymath/notes" }));

import { SideNav } from "@/components/shell/side-nav";

const PINNED_KEY = "polymath.sidebar.pinned";

function nav() {
  const element = document.querySelector("nav[aria-label='Workspace']");
  if (!element) throw new Error("rail not rendered");
  return element;
}

describe("SideNav focus mode", () => {
  beforeEach(() => {
    window.localStorage.clear();
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
