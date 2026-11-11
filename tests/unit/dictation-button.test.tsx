import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDLE, type DictationState } from "@/components/speech/dictation-machine";
import { DICTATED_EVENT } from "@/components/speech/dictation-target";

/*
 * Value: protects=the mic button a person clicks to dictate into a field: it starts and stops
 * dictation for its own field, keeps the caret in that field, and cannot start a second session;
 * fails_when=a click steals focus from the field, a button for another field shows as listening, a
 * click starts dictation while a clip is transcribing or failed, or the dictated callback fires for
 * anything but inserted words; why_new=the button is new; seam=DictationButton under jsdom with the
 * controller module mocked as a small store; no_claim=recording, upload and insertion (the e2e spec
 * covers them in Chromium)
 */

const controller = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    state: { kind: "idle", notice: null } as DictationState,
    target: null as Element | null,
    listeners,
    startDictation: vi.fn(),
    stopDictation: vi.fn(),
    set(state: DictationState, target: Element | null) {
      this.state = state;
      this.target = target;
      listeners.forEach((listener) => listener());
    },
  };
});

vi.mock("@/components/speech/dictation-controller", () => ({
  startDictation: controller.startDictation,
  stopDictation: controller.stopDictation,
  getDictationState: () => controller.state,
  getDictationTarget: () => controller.target,
  subscribe: (listener: () => void) => {
    controller.listeners.add(listener);
    return () => controller.listeners.delete(listener);
  },
}));

import { DictationButton } from "@/components/speech/dictation-button";

const session = { queue: [], recording: true, stranded: "" };
const listening: DictationState = {
  kind: "listening",
  press: { kind: "latched" },
  startedAt: 0,
  micOpen: true,
  session,
};

let field: HTMLTextAreaElement;
let other: HTMLTextAreaElement;

async function mount(props: Partial<Parameters<typeof DictationButton>[0]> = {}) {
  render(createElement(DictationButton, { field: () => field, ...props }));
  // The controller arrives through a dynamic import.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return screen.getByRole("button", { name: /dictate/i });
}

beforeEach(() => {
  field = document.body.appendChild(document.createElement("textarea"));
  other = document.body.appendChild(document.createElement("textarea"));
  controller.set(IDLE, null);
  controller.startDictation.mockClear();
  controller.stopDictation.mockClear();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("DictationButton", () => {
  it("starts dictation into its own field on click", async () => {
    const button = await mount();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    await vi.waitFor(() => expect(controller.startDictation).toHaveBeenCalledWith(field));
  });

  it("reads as listening and stops dictation on the next click", async () => {
    const button = await mount();
    act(() => controller.set(listening, field));
    expect(screen.getByRole("button", { name: "Stop dictating" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(button);
    await vi.waitFor(() => expect(controller.stopDictation).toHaveBeenCalledTimes(1));
    expect(controller.startDictation).not.toHaveBeenCalled();
  });

  it("does not claim a session that is listening into another field", async () => {
    await mount();
    act(() => controller.set(listening, other));
    const button = screen.getByRole("button", { name: "Dictate" });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it.each<[string, DictationState]>([
    ["transcribing", { kind: "transcribing", session }],
    ["failed", { kind: "error", reason: "failed", failed: null, session }],
  ])("is disabled while the previous session is %s", async (_name, state) => {
    await mount();
    act(() => controller.set(state, field));
    const button = screen.getByRole("button", { name: "Dictate" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(controller.startDictation).not.toHaveBeenCalled();
  });

  it("is disabled when the field cannot take words", async () => {
    const button = await mount({ disabled: true });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the field focused when the button is pressed", async () => {
    const button = await mount();
    field.focus();
    const proceeded = fireEvent.mouseDown(button);
    expect(proceeded).toBe(false);
    expect(document.activeElement).toBe(field);
  });

  it("tells the host when dictated words land in the field", async () => {
    const onDictated = vi.fn();
    await mount({ onDictated });
    field.dispatchEvent(new CustomEvent(DICTATED_EVENT));
    expect(onDictated).toHaveBeenCalledTimes(1);
    other.dispatchEvent(new CustomEvent(DICTATED_EVENT));
    expect(onDictated).toHaveBeenCalledTimes(1);
  });
});
