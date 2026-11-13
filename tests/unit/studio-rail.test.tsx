import { fireEvent, render, screen } from "@testing-library/react";
import { createElement as h } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import { StudioRail } from "@/app/(workspace)/projects/[projectId]/notebook/studio-rail";

/*
 * Value: protects=the notebook's Studio rail: four segments, every action one click away, a dot on
 * a segment whose work is in flight, Alt+1..4 as shortcuts, and a deep link (a quiz) opening on
 * Learn; fails_when=a segment's panel renders under the wrong tab, a running job shows no dot, the
 * shortcut fires while the person is typing, or the rail ignores its initial segment;
 * why_new=the rail replaces a stack of panels; seam=StudioRail under jsdom with plain panels;
 * no_claim=layout and placement (tests/e2e/notebook-layout.spec.ts measures where it sits)
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const panels = {
  create: h("p", null, "create panel"),
  learn: h("p", null, "learn panel"),
  practice: h("p", null, "practice panel"),
  library: h("p", null, "library panel"),
};

describe("StudioRail", () => {
  it("opens on Create and shows only that segment", () => {
    render(h(StudioRail, { panels }));
    expect(screen.getByRole("tab", { name: "Create" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("create panel")).toBeTruthy();
    expect(screen.queryByText("learn panel")).toBeNull();
  });

  it("switches segments with a click", () => {
    render(h(StudioRail, { panels }));
    fireEvent.click(screen.getByRole("tab", { name: "Practice" }));
    expect(screen.getByText("practice panel")).toBeTruthy();
    expect(screen.queryByText("create panel")).toBeNull();
  });

  it("jumps with Alt+digit, on the physical key", () => {
    render(h(StudioRail, { panels }));
    fireEvent.keyDown(window, { altKey: true, code: "Digit4", key: "⁄" });
    expect(screen.getByText("library panel")).toBeTruthy();
    fireEvent.keyDown(window, { altKey: true, code: "Digit2", key: "™" });
    expect(screen.getByText("learn panel")).toBeTruthy();
  });

  it("ignores the shortcut while typing in a field", () => {
    render(h("div", null, h("input", { "aria-label": "Brief" }), h(StudioRail, { panels })));
    fireEvent.keyDown(screen.getByLabelText("Brief"), { altKey: true, code: "Digit3", key: "£" });
    expect(screen.getByText("create panel")).toBeTruthy();
  });

  it("starts on the segment it was given", () => {
    render(h(StudioRail, { panels, initial: "learn" }));
    expect(screen.getByText("learn panel")).toBeTruthy();
  });

  it("says a segment is working without moving focus", () => {
    render(h(StudioRail, { panels, busy: { learn: true } }));
    expect(screen.getByRole("tab", { name: /Learn, working/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Create" })).toBeTruthy();
  });
});
