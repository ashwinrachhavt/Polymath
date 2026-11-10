// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineCompletion, inlineSuggestion } from "@/components/products/polymath/inline-completion";

/*
 * Value: protects=ghost-text autocomplete in the editor: appears after a pause, Tab accepts, Cmd/Ctrl+→
 * accepts a word, Esc dismisses, typing through keeps it, and it never asks in code, mid-block, with a
 * menu open, or when turned off; fails_when=a key stops working, a stale reply is shown, or the
 * suggestion leaks into the document before it is accepted; why_new=the plugin is new; seam=none (the
 * completion function is the extension's own option); no_claim=real pointer focus, IME, model quality
 */

// jsdom has no layout: ProseMirror's scrollIntoView asks a Range for its rects.
const flat = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => flat as DOMRect;

const complete = vi.fn<(request: { before: string; after: string }, signal: AbortSignal) => Promise<string>>();
let editor: Editor;
let enabled = true;

function mount(content = "<p></p>") {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [StarterKit, InlineCompletion.configure({ complete, isEnabled: () => enabled, debounceMs: 20 })],
    content,
  });
  // jsdom only focuses tabbable elements.
  editor.view.dom.tabIndex = 0;
  editor.view.dom.focus();
}

const type = (text: string) => editor.view.dispatch(editor.state.tr.insertText(text));
const pause = () => vi.advanceTimersByTimeAsync(30);
const press = (key: string, modifiers: KeyboardEventInit = {}) =>
  editor.view.someProp("handleKeyDown", (handle) =>
    handle(editor.view, new KeyboardEvent("keydown", { key, cancelable: true, ...modifiers })),
  );
const shown = () => inlineSuggestion(editor.state);
const ghost = () => editor.view.dom.querySelector(".inline-completion");

beforeEach(() => {
  vi.useFakeTimers();
  enabled = true;
  complete.mockReset();
  complete.mockResolvedValue("");
});

afterEach(() => {
  editor.destroy();
  vi.useRealTimers();
});

describe("inline completion", () => {
  it("shows a suggestion after a pause, without putting it in the note", async () => {
    mount();
    complete.mockResolvedValueOnce(" be atomic.");
    type("Evergreen notes should");
    expect(complete).not.toHaveBeenCalled();
    await pause();
    expect(complete.mock.calls[0][0]).toMatchObject({ before: "Evergreen notes should", after: "" });
    expect(shown()).toBe(" be atomic.");
    expect(ghost()?.textContent).toContain("be atomic.");
    expect(ghost()?.getAttribute("aria-hidden")).toBe("true");
    expect(editor.getText()).toBe("Evergreen notes should");
  });

  it("accepts the whole suggestion on Tab, then asks for the next one", async () => {
    mount();
    complete.mockResolvedValueOnce(" be atomic.");
    type("Evergreen notes should");
    await pause();
    expect(press("Tab")).toBe(true);
    expect(editor.getText()).toBe("Evergreen notes should be atomic.");
    expect(shown()).toBeNull();
    await pause();
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("accepts one word on Cmd/Ctrl+ArrowRight and keeps the rest", async () => {
    mount();
    complete.mockResolvedValueOnce(" be atomic.");
    type("Evergreen notes should");
    await pause();
    expect(press("ArrowRight", { metaKey: true })).toBe(true);
    expect(editor.getText()).toBe("Evergreen notes should be");
    expect(shown()).toBe(" atomic.");
  });

  it("dismisses on Escape and leaves the note alone", async () => {
    mount();
    complete.mockResolvedValueOnce(" be atomic.");
    type("Evergreen notes should");
    await pause();
    expect(press("Escape")).toBe(true);
    expect(shown()).toBeNull();
    expect(editor.getText()).toBe("Evergreen notes should");
  });

  it("keeps the rest while the writer types through it, and clears on a different key", async () => {
    mount();
    complete.mockResolvedValueOnce(" be atomic.");
    type("Evergreen notes should");
    await pause();
    type(" b");
    expect(shown()).toBe("e atomic.");
    await pause();
    expect(complete).toHaveBeenCalledTimes(1);
    type("x");
    expect(shown()).toBeNull();
  });

  it("drops a reply that arrives after the writer typed again", async () => {
    mount();
    let resolve!: (text: string) => void;
    complete.mockReturnValueOnce(new Promise((done) => (resolve = done)));
    type("Evergreen notes should");
    await pause();
    const signal = complete.mock.calls[0][1];
    type(" really");
    expect(signal.aborted).toBe(true);
    resolve(" be atomic.");
    await pause();
    expect(shown()).toBeNull();
  });

  it("leaves Tab alone when nothing is suggested", async () => {
    mount();
    type("Evergreen notes should");
    await pause();
    expect(press("Tab")).toBeFalsy();
  });

  it.each([
    ["turned off", "<p></p>", () => ((enabled = false), type("Evergreen notes should"))],
    ["there is too little text", "<p></p>", () => type("Hi there")],
    [
      "the caret is in the middle of a block",
      "<p>Evergreen notes should be atomic</p>",
      () => {
        editor.commands.setTextSelection(6);
        type("x");
      },
    ],
    [
      "writing code",
      "<pre><code>const evergreen = 1;</code></pre>",
      () => {
        editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize - 1);
        type(" // and more");
      },
    ],
    ["the [[ link menu is open", "<p></p>", () => type("Evergreen notes link to [[Atom")],
    ["the / block menu is open", "<p></p>", () => type("Evergreen notes should /head")],
  ])("asks for nothing when %s", async (_name, content, act) => {
    mount(content);
    act();
    await pause();
    expect(complete).not.toHaveBeenCalled();
  });
});
