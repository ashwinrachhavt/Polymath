import { act, render } from "@testing-library/react";
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ViewportSync } from "@/components/shell/viewport-sync";

/*
 * Value: protects=the phone keyboard handling: while the on-screen keyboard is up the shell takes
 * the visible height (--vvh) so the composer rides above the keys, the bottom bar steps aside
 * (data-keyboard), and both are undone when it closes; fails_when=the keyboard leaves --vvh unset,
 * a pinch-zoom (which also shrinks the visual viewport) shrinks the layout, a small browser-bar
 * change counts as a keyboard, or unmounting leaves the page stuck in keyboard mode;
 * why_new=the phone shell is new; seam=ViewportSync under jsdom with a fake visualViewport;
 * no_claim=real iOS or Android keyboards (checked by hand on a device)
 */

type Listener = () => void;

function fakeViewport(initial: { height: number; scale: number }) {
  const listeners = new Set<Listener>();
  return {
    height: initial.height,
    scale: initial.scale,
    addEventListener: (_: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
    emit() {
      listeners.forEach((listener) => listener());
    },
  };
}

const root = document.documentElement;

beforeEach(() => {
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  root.style.removeProperty("--vvh");
  root.removeAttribute("data-keyboard");
});
afterEach(() => {
  Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
});

function mountWith(viewport: ReturnType<typeof fakeViewport>) {
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
  return render(h(ViewportSync));
}

describe("ViewportSync", () => {
  it("publishes the visible height and marks the keyboard while it is up", () => {
    const viewport = fakeViewport({ height: 800, scale: 1 });
    mountWith(viewport);
    expect(root.hasAttribute("data-keyboard")).toBe(false);

    viewport.height = 480;
    act(() => viewport.emit());
    expect(root.style.getPropertyValue("--vvh")).toBe("480px");
    expect(root.hasAttribute("data-keyboard")).toBe(true);

    viewport.height = 800;
    act(() => viewport.emit());
    expect(root.style.getPropertyValue("--vvh")).toBe("");
    expect(root.hasAttribute("data-keyboard")).toBe(false);
  });

  it("does not shrink the layout when the person pinch-zooms", () => {
    const viewport = fakeViewport({ height: 800, scale: 1 });
    mountWith(viewport);
    viewport.height = 400;
    viewport.scale = 2;
    act(() => viewport.emit());
    expect(root.style.getPropertyValue("--vvh")).toBe("");
    expect(root.hasAttribute("data-keyboard")).toBe(false);
  });

  it("ignores a small change such as the browser bar collapsing", () => {
    const viewport = fakeViewport({ height: 800, scale: 1 });
    mountWith(viewport);
    viewport.height = 740;
    act(() => viewport.emit());
    expect(root.hasAttribute("data-keyboard")).toBe(false);
  });

  it("leaves nothing behind when it unmounts with the keyboard up", () => {
    const viewport = fakeViewport({ height: 480, scale: 1 });
    const view = mountWith(viewport);
    expect(root.hasAttribute("data-keyboard")).toBe(true);
    view.unmount();
    expect(root.style.getPropertyValue("--vvh")).toBe("");
    expect(root.hasAttribute("data-keyboard")).toBe(false);
  });

  it("does nothing where there is no visual viewport", () => {
    Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
    render(h(ViewportSync));
    expect(root.hasAttribute("data-keyboard")).toBe(false);
  });
});
