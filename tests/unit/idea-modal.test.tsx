import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

/*
 * The idea card is a modal over the Ideas collection (the Alfred pattern).
 * These tests prove the shell's own contract: the card body renders, the edit
 * control sits top right and swaps the card for the editor in place, closing
 * navigates back to the list (the ?idea parameter leaves the URL), and the
 * not-found state offers no edit control because there is nothing to edit.
 */

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, refresh: vi.fn(), push: vi.fn() }),
}));
// The editor is a rich-text client surface; here it stands in as a marker.
vi.mock("@/components/polymath/zettels/idea-editor", () => ({
  IdeaEditor: () => <div data-testid="idea-editor" />,
}));

const { IdeaModal } = await import("@/components/polymath/ideas/idea-modal");

const editor = { workspaceId: "w1", artifactId: "6f1c2b7a-5b3e-4c8d-9a10-2b3c4d5e6f70", version: 1 };

function renderModal(editorProps: typeof editor | null = editor) {
  return render(
    <IdeaModal title="The cache is the bill" closeHref="/polymath/ideas?q=mvcc" editor={editorProps}>
      <p>Long context bills in memory before it bills in tokens.</p>
    </IdeaModal>,
  );
}

describe("IdeaModal", () => {
  it("renders the card body beside the title", () => {
    renderModal();
    expect(screen.getByText("The cache is the bill")).toBeDefined();
    expect(screen.getByText(/Long context bills in memory/)).toBeDefined();
  });

  it("places the edit control top right, next to the dialog's close", () => {
    renderModal();
    const edit = screen.getByRole("button", { name: "Edit idea" });
    expect(edit.className).toContain("top-2");
    expect(edit.className).toContain("right-10");
    expect(edit.getAttribute("aria-pressed")).toBe("false");
  });

  it("swaps the card for the editor in place, and back", () => {
    renderModal();
    const edit = screen.getByRole("button", { name: "Edit idea" });
    fireEvent.click(edit);
    expect(screen.queryByTestId("idea-editor")).not.toBeNull();
    expect(screen.queryByText(/Long context bills in memory/)).toBeNull();
    const done = screen.getByRole("button", { name: "Done editing" });
    expect(done.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(done);
    expect(screen.queryByTestId("idea-editor")).toBeNull();
    expect(screen.getByText(/Long context bills in memory/)).toBeDefined();
  });

  it("closing the dialog replaces the ?idea parameter out of the URL", () => {
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(replace).toHaveBeenCalledWith("/polymath/ideas?q=mvcc");
  });

  it("offers no edit control in the not-found state", () => {
    renderModal(null);
    expect(screen.getByText("The cache is the bill")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Edit idea" })).toBeNull();
  });
});
