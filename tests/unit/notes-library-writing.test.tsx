import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Value: protects=the library rail steps aside while the note is being written
 * and comes back on its own, keeps its width so the prose never reflows under
 * the caret, and stays put when the person is not writing the note (a
 * shortcut, or the rail's own search); fails_when=typing leaves the rail on
 * screen as a reader's distraction, a shortcut hides it, or searching the rail
 * makes it disappear; why_new=the writing hush is new interaction behavior;
 * seam=keyboard events and the toggle; no_claim=the visual transition
 */

vi.mock("@/components/shell/note-switcher", () => ({ NoteSwitcher: () => null }));

import { LibraryToggle, NotebookWorkspace } from "@/app/(workspace)/polymath/notes/notebook-workspace";

function setup() {
  render(
    <NotebookWorkspace
      library={
        <div>
          <input aria-label="Search notes" />
        </div>
      }
    >
      <LibraryToggle />
      <div data-note-container>
        <input aria-label="Note title" />
      </div>
    </NotebookWorkspace>,
  );
  const rail = document.querySelector("[data-notes-library]") as HTMLElement;
  return { rail, title: screen.getByLabelText("Note title"), search: screen.getByLabelText("Search notes") };
}

beforeEach(() => window.localStorage.clear());

describe("notes library writing hush", () => {
  it("leaves while the note is being written and returns after the pause", async () => {
    const { rail, title } = setup();
    expect(rail.getAttribute("data-state")).toBe("open");

    fireEvent.keyDown(title, { key: "a" });
    expect(rail.getAttribute("data-state")).toBe("writing");
    expect(rail.hasAttribute("inert")).toBe(true);

    // Idle, not a keystroke, brings it back - nobody has to click.
    await vi.waitFor(() => expect(rail.getAttribute("data-state")).toBe("open"), { timeout: 2500 });
    expect(rail.hasAttribute("inert")).toBe(false);
  });

  it("treats a deleted character and a new line as writing too", () => {
    const { rail, title } = setup();
    for (const key of ["Backspace", "Enter"]) {
      fireEvent.keyDown(title, { key });
      expect(rail.getAttribute("data-state")).toBe("writing");
    }
  });

  it("stays out of the way of shortcuts and of its own search", () => {
    const { rail, title, search } = setup();
    fireEvent.keyDown(title, { key: "k", metaKey: true });
    expect(rail.getAttribute("data-state")).toBe("open");
    fireEvent.keyDown(search, { key: "p" });
    expect(rail.getAttribute("data-state")).toBe("open");
  });
});

describe("notes library toggle", () => {
  it("puts the rail away, remembers it, and brings it back", () => {
    const { rail } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Hide the note list" }));
    expect(rail.getAttribute("data-state")).toBe("collapsed");
    expect(rail.hasAttribute("inert")).toBe(true);
    expect(window.localStorage.getItem("polymath.notes.library")).toBe("0");
    // The header toggle and the edge opener both bring it back.
    expect(screen.getAllByRole("button", { name: "Show the note list" })).toHaveLength(2);

    fireEvent.click(screen.getAllByRole("button", { name: "Show the note list" })[0]);
    expect(rail.getAttribute("data-state")).toBe("open");
    expect(window.localStorage.getItem("polymath.notes.library")).toBe("1");
  });
});
