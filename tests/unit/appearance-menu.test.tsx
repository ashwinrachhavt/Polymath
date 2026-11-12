import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement as h } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceMenu } from "@/components/shell/appearance-menu";
import type { ShellPreferenceSnapshot } from "@/components/shell/shell-preferences";
import { Toaster, dismissToast } from "@/components/ui/toast";

/*
 * Value: protects=the top-bar accent picker: a swatch paints every surface at once (the
 * <html data-accent> token switch), saves to the account row, and the account's choice wins on
 * another device; fails_when=a pick is not saved per user, a failed save leaves the wrong colour
 * painted, or a second browser keeps its stale mirror over the saved accent; why_new=the accent
 * moved from this-browser-only to the account; seam=AppearanceMenu under jsdom with next-themes
 * mocked and onSave as a spy; no_claim=the server action and row (tests/integration/preferences)
 */

vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "system", setTheme: vi.fn() }) }));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset.accent;
});

afterEach(() => {
  for (let id = 0; id < 200; id++) dismissToast(id);
});

const ready = (accent: "graphite" | "blue" | "green", version = 2): ShellPreferenceSnapshot => ({
  scope: "s",
  kind: "ready",
  version,
  appearance: "system",
  accent,
});

function open(preferences: ShellPreferenceSnapshot, onSave = vi.fn().mockResolvedValue(true)) {
  render(h("div", null, h(AppearanceMenu, { preferences, disabled: false, onSave }), h(Toaster)));
  fireEvent.pointerDown(screen.getByRole("button", { name: "Appearance" }), { button: 0, ctrlKey: false });
  fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  return onSave;
}

describe("AppearanceMenu accent", () => {
  it("a swatch paints the accent token now and saves it to the account", async () => {
    const onSave = open(ready("graphite"));
    fireEvent.click(await screen.findByRole("radio", { name: "Green" }));
    expect(document.documentElement.dataset.accent).toBe("green");
    expect(JSON.parse(window.localStorage.getItem("polymath.appearance") ?? "{}").accent).toBe("green");
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ accent: "green" }));
    expect((screen.getByRole("radio", { name: "Green" }) as HTMLInputElement).checked).toBe(true);
  });

  it("a failed save puts the previous accent back and says so", async () => {
    open(ready("graphite"), vi.fn().mockResolvedValue(false));
    fireEvent.click(await screen.findByRole("radio", { name: "Blue" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(document.documentElement.dataset.accent).toBe("graphite");
  });

  it("the account's accent wins over this browser's stale mirror", async () => {
    window.localStorage.setItem("polymath.appearance", JSON.stringify({ paper: "white", accent: "green" }));
    await act(async () => {
      render(h(AppearanceMenu, { preferences: ready("blue"), disabled: false, onSave: vi.fn() }));
    });
    expect(document.documentElement.dataset.accent).toBe("blue");
  });

  it("a never-saved account leaves this browser's choice alone", async () => {
    window.localStorage.setItem("polymath.appearance", JSON.stringify({ paper: "white", accent: "green" }));
    await act(async () => {
      render(h(AppearanceMenu, { preferences: ready("graphite", 0), disabled: false, onSave: vi.fn() }));
    });
    expect(document.documentElement.dataset.accent).toBeUndefined();
  });
});
