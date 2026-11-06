// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * The inbox capture bar's attach contract: the collapsed bar's plus opens the
 * file picker (it visually promises an add affordance, so a dead glyph is
 * chrome lying), a pasted image uploads through the shared multipart route,
 * and a captured file navigates to the new row.
 *
 * Value: protects=the plus button is a real control and paste-image capture;
 * fails_when=the plus renders without a handler or a pasted image becomes
 * text; seam=CaptureForm under jsdom with the server action mocked and fetch
 * stubbed at global; no_claim=the real file-chooser dialog.
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }),
}));

const captureTextAction = vi.fn();
vi.mock("@/app/(workspace)/command-center/inbox/actions", () => ({
  captureTextAction: (...args: unknown[]) => captureTextAction(...args),
}));

import { CaptureForm } from "@/app/(workspace)/command-center/inbox/inbox-client";

const fetchCalls: Array<{ url: string }> = [];
const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
  fetchCalls.push({ url: String(input) });
  return new Response(JSON.stringify({ captureId: "cap-1" }), { status: 200 });
});
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  fetchCalls.length = 0;
  push.mockReset();
  captureTextAction.mockReset();
});

function png(): File {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  return new File([bytes], "shot.png", { type: "image/png" });
}

function renderBar() {
  return render(createElement(CaptureForm));
}

describe("CaptureForm attach", () => {
  it("the collapsed bar's plus opens the file picker", () => {
    const { container } = renderBar();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    fireEvent.click(screen.getByRole("button", { name: "Attach a file or image" }));
    expect(click).toHaveBeenCalled();
  });

  it("a pasted image uploads as a capture and navigates to the new row", async () => {
    const { container } = renderBar();
    fireEvent.focus(screen.getByLabelText("Capture a thought, excerpt, or URL"));
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.paste(textarea, {
      clipboardData: { files: [png()], getData: () => "" },
    });
    await waitFor(() => expect(fetchCalls.length).toBeGreaterThan(0));
    expect(fetchCalls[0].url).toBe("/api/v1/captures/file");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/command-center/inbox?id=cap-1"));
  });

  it("a pasted screenshot over the limit names the ceiling and never hits the network", async () => {
    const big = new File([new Uint8Array(5 * 1024 * 1024)], "shot.png", { type: "image/png" });
    renderBar();
    fireEvent.focus(screen.getByLabelText("Capture a thought, excerpt, or URL"));
    fireEvent.paste(screen.getByLabelText("Capture a thought, excerpt, or URL"), {
      clipboardData: { files: [big], getData: () => "" },
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("4 MB"));
    expect(fetchCalls.length).toBe(0);
  });

  it("a text paste still lands in the draft, not the network", () => {
    renderBar();
    const bar = screen.getByLabelText("Capture a thought, excerpt, or URL");
    fireEvent.focus(bar);
    fireEvent.paste(bar, { clipboardData: { files: [], getData: () => "hello" } });
    expect(fetchCalls.length).toBe(0);
  });
});
