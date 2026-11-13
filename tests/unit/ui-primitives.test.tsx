import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement as h } from "react";
import { Trash2 } from "lucide-react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { IconButton } from "@/components/ui/icon-button";
import { DeleteButton } from "@/components/ui/delete-button";
import { Toaster, dismissToast, toast } from "@/components/ui/toast";

/*
 * Value: protects=the shared IconButton (name + hover/focus hint) and the two-step DeleteButton
 * (arm, confirm, undo) every surface adopts; fails_when=an icon ships without an accessible name,
 * the hint does not open for keyboard users or reads the label twice, one click deletes, an armed
 * button never disarms, a failed delete is silent, or Undo does not call the restore; why_new=the
 * primitives are new; seam=the components under jsdom with the real Toaster; no_claim=visual
 * placement of the tooltip (Chromium screenshots in the PR cover it)
 */

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  vi.useRealTimers();
  // The toast store is module state; clear it between tests.
  for (let id = 0; id < 200; id++) dismissToast(id);
});

describe("IconButton", () => {
  it("is named by its label and shows the same text as a tooltip on keyboard focus", async () => {
    render(h(IconButton, { label: "Delete note", icon: h(Trash2, { "aria-hidden": true }), onClick: () => {} }));
    const button = screen.getByRole("button", { name: "Delete note" });
    act(() => button.focus());
    const tip = await screen.findByRole("tooltip");
    expect(tip.textContent).toBe("Delete note");
    // The hint repeats the name, so it must not also describe the button.
    expect(button.getAttribute("aria-describedby")).toBeNull();
    fireEvent.keyDown(button, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("exposes a shortcut to assistive tech and in the hint", async () => {
    render(h(IconButton, { label: "Search", shortcut: "⌘K", icon: h("span"), onClick: () => {} }));
    const button = screen.getByRole("button", { name: "Search" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("⌘K");
    act(() => button.focus());
    expect((await screen.findByRole("tooltip")).textContent).toContain("⌘K");
  });

  it("renders a real link when given href", () => {
    render(h(IconButton, { label: "Open settings", href: "/settings", icon: h("span") }));
    const link = screen.getByRole("link", { name: "Open settings" });
    expect(link.getAttribute("href")).toBe("/settings");
  });

  it("fires its action on click", () => {
    const onClick = vi.fn();
    render(h(IconButton, { label: "Refresh", icon: h("span"), onClick }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
});

function renderDelete(props: Partial<Parameters<typeof DeleteButton>[0]> = {}) {
  const onDelete = props.onDelete ?? vi.fn();
  render(h("div", null, h(DeleteButton, { label: "Delete idea", ...props, onDelete }), h(Toaster)));
  return { onDelete, button: screen.getByRole("button", { name: "Delete idea" }) };
}

describe("DeleteButton", () => {
  it("the first click only arms; the second deletes", async () => {
    const { onDelete, button } = renderDelete();
    fireEvent.click(button);
    expect(onDelete).not.toHaveBeenCalled();
    expect(button.dataset.state).toBe("armed");
    expect(button.getAttribute("aria-label")).toMatch(/click again to confirm/);
    expect((await screen.findByRole("tooltip")).textContent).toBe("Click again to delete");
    fireEvent.click(button);
    await waitFor(() => expect(onDelete).toHaveBeenCalledOnce());
    expect(await screen.findByText("Deleted")).toBeTruthy();
  });

  it("disarms by itself, on Escape and on blur", () => {
    vi.useFakeTimers();
    const { onDelete, button } = renderDelete();
    fireEvent.click(button);
    act(() => vi.advanceTimersByTime(3100));
    expect(button.dataset.state).toBe("idle");

    fireEvent.click(button);
    fireEvent.keyDown(button, { key: "Escape" });
    expect(button.dataset.state).toBe("idle");

    fireEvent.click(button);
    fireEvent.blur(button);
    expect(button.dataset.state).toBe("idle");

    // A click after any disarm arms again rather than deleting.
    fireEvent.click(button);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("offers Undo when the caller can restore, and calls it", async () => {
    const undo = vi.fn();
    const { button } = renderDelete({ undo, deletedMessage: "Idea deleted" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByText("Idea deleted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(undo).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText("Idea deleted")).toBeNull());
  });

  it("without a restore path the toast only confirms", async () => {
    const { button } = renderDelete();
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByText("Deleted");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("a failed delete says so and returns to rest", async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error("That idea is locked."));
    const { button } = renderDelete({ onDelete });
    fireEvent.click(button);
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("That idea is locked.");
    expect(button.dataset.state).toBe("idle");
    expect(screen.queryByText("Deleted")).toBeNull();
  });
});

describe("toast", () => {
  it("dismisses itself after its duration", () => {
    vi.useFakeTimers();
    render(h(Toaster));
    act(() => {
      toast("Saved", { duration: 2000 });
    });
    expect(screen.getByText("Saved")).toBeTruthy();
    act(() => vi.advanceTimersByTime(2100));
    expect(screen.queryByText("Saved")).toBeNull();
  });
});
