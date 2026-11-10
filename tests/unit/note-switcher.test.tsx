import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Value: protects=Cmd/Ctrl+K on the notes page opens the note finder (and nothing else does), the finder
 * offers notes only, and Enter acts on the hits for what is typed now; fails_when=the sidebar's search
 * opens the finder, Enter opens the previous query's hit or creates a twin, a create drops its
 * idempotency key, or the combobox loses its active option; why_new=the finder had no tests;
 * seam=the server actions and the router; no_claim=ranking, which belongs to searchKnowledge
 */

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/app/(workspace)/polymath/notes/actions", () => ({
  findLinkTargetsAction: vi.fn(),
  createNoteAction: vi.fn(),
}));

import { createNoteAction, findLinkTargetsAction } from "@/app/(workspace)/polymath/notes/actions";
import { NotebookWorkspace } from "@/app/(workspace)/polymath/notes/notebook-workspace";
import { OPEN_COMMAND_SEARCH } from "@/components/shell/command-layer-mount";

type Hit = { id: string; title: string; kind: string };
const find = vi.mocked(findLinkTargetsAction);
const create = vi.mocked(createNoteAction);

/** Each search waits until the test answers it, so the test controls arrival order. */
let answers: Map<string, (hits: Hit[]) => void>;
beforeEach(() => {
  push.mockReset();
  create.mockReset().mockResolvedValue({ ok: true, artifactId: "new-note" });
  answers = new Map();
  find.mockReset().mockImplementation(
    ({ query }) =>
      new Promise((resolve) => {
        answers.set(query, resolve);
      }),
  );
});
afterEach(cleanup);

async function answer(query: string, hits: Hit[]) {
  await vi.waitFor(() => expect(answers.has(query)).toBe(true));
  await act(async () => answers.get(query)!(hits));
}

function pressCmdK() {
  fireEvent.keyDown(window, { key: "k", metaKey: true });
}

async function openFinder() {
  render(<NotebookWorkspace>page</NotebookWorkspace>);
  pressCmdK();
  const input = await screen.findByRole("combobox", { name: "Find a note" });
  await answer("", []);
  return input;
}

const alpha = { id: "n1", title: "Alpha", kind: "note" };

describe("note finder scope", () => {
  it("answers Cmd+K before the global command layer", async () => {
    const commandLayer = vi.fn();
    window.addEventListener("keydown", commandLayer);
    render(<NotebookWorkspace>page</NotebookWorkspace>);
    pressCmdK();
    expect(await screen.findByRole("combobox", { name: "Find a note" })).toBeTruthy();
    expect(commandLayer).not.toHaveBeenCalled();
    window.removeEventListener("keydown", commandLayer);
  });

  it("leaves the sidebar's search open event to the command layer", () => {
    render(<NotebookWorkspace>page</NotebookWorkspace>);
    act(() => void window.dispatchEvent(new Event(OPEN_COMMAND_SEARCH)));
    expect(screen.queryByRole("combobox", { name: "Find a note" })).toBeNull();
  });

  it("searches notes only", async () => {
    await openFinder();
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ query: "", notesOnly: true }));
  });
});

describe("note finder Enter", () => {
  it("waits for the typed query's hits, then opens the exact match", async () => {
    const input = await openFinder();
    fireEvent.change(input, { target: { value: "Alpha" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).not.toHaveBeenCalled();
    await answer("Alpha", [alpha]);
    expect(push).toHaveBeenCalledWith("/polymath/notes?id=n1");
    expect(create).not.toHaveBeenCalled();
  });

  it("does not offer to create a note whose title exists", async () => {
    const input = await openFinder();
    fireEvent.change(input, { target: { value: "alpha" } });
    await answer("alpha", [alpha]);
    expect(screen.queryByText(/Create note/)).toBeNull();
  });

  it("creates a note titled with the query, with an idempotency key", async () => {
    const input = await openFinder();
    fireEvent.change(input, { target: { value: "Fresh idea" } });
    await answer("Fresh idea", []);
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/polymath/notes?id=new-note"));
    expect(create).toHaveBeenCalledWith({
      title: "Fresh idea",
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("starts empty when reopened", async () => {
    const input = await openFinder();
    fireEvent.change(input, { target: { value: "Alpha" } });
    await answer("Alpha", [alpha]);
    fireEvent.keyDown(input, { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
    pressCmdK();
    const reopened = await screen.findByRole("combobox", { name: "Find a note" });
    expect((reopened as HTMLInputElement).value).toBe("");
    expect(screen.queryByText("Alpha")).toBeNull();
  });
});

describe("note finder combobox", () => {
  it("points the input at its listbox and the active option", async () => {
    const input = await openFinder();
    fireEvent.change(input, { target: { value: "a" } });
    await answer("a", [alpha, { id: "n2", title: "Another", kind: "zettel" }]);
    const listbox = screen.getByRole("listbox");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const active = document.getElementById(input.getAttribute("aria-activedescendant")!);
    expect(active?.textContent).toBe("Another");
    expect(active?.getAttribute("aria-selected")).toBe("true");
  });
});
