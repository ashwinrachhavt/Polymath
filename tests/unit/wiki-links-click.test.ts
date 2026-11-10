// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WIKI_LINK_OPEN, WikiLinks, type WikiLinkOpen } from "@/components/products/polymath/wiki-links";
import type { LinkPreview } from "@/domains/knowledge/notes";

/*
 * Value: protects=a plain click (or tap) on a [[link]] opens it, with the note's id when its preview is
 * known; Shift/Alt-click and keyboard editing are left to the editor; only a title the server named
 * missing reads as muted text, and a click on it (or on a link to the open note) places the caret;
 * fails_when=the click rule regresses to modifier-only, the id is dropped, a link added after load
 * reads as missing, or a missing link still navigates; why_new=the spec says "clicking the link opens
 * that note", touch had no way to open, and autosave never refreshes previews; seam=none;
 * no_claim=real pointer hit-testing and drag detection (ProseMirror calls handleClick only for a click
 * without a drag; the handler is called through its own prop lookup here)
 */

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
  document.body.innerHTML = "";
});

function mount(
  editable: boolean,
  {
    previews = null,
    missingTitles = [],
    noteTitle,
  }: { previews?: LinkPreview[] | null; missingTitles?: string[]; noteTitle?: string } = {},
) {
  // The notes page wraps its editor in [data-note-title]; other hosts do not.
  const host = document.body.appendChild(document.createElement("div"));
  if (noteTitle !== undefined) host.dataset.noteTitle = noteTitle;
  editor = new Editor({
    element: host.appendChild(document.createElement("div")),
    extensions: [StarterKit, WikiLinks.configure({ previews, missingTitles })],
    content: "<p>see [[Alpha]] here and [[Nowhere]]</p>",
    editable,
  });
  const opened = vi.fn();
  editor.view.dom.addEventListener(WIKI_LINK_OPEN, (event) => opened((event as CustomEvent<WikiLinkOpen>).detail));
  const [link, missing] = editor.view.dom.querySelectorAll<HTMLElement>("[data-wiki-title]");
  const click = (init: { shiftKey?: boolean; altKey?: boolean } = {}, target: HTMLElement = link) =>
    editor!.view.someProp("handleClick", (handle) =>
      handle(editor!.view, 0, { target, metaKey: false, ctrlKey: false, ...init, preventDefault() {} } as never),
    );
  return { link, missing, opened, click };
}

const alpha = { id: "a1", title: "Alpha", firstParagraph: "About alpha." };

describe("wiki link clicks in the editor", () => {
  it("opens on a plain click while editing, and says so", () => {
    const { link, opened, click } = mount(true);
    expect(link.textContent).toBe("Alpha");
    expect(link.title).toBe("Click to open. Use the arrow keys to edit it.");
    expect(click()).toBe(true);
    expect(opened).toHaveBeenCalledWith({ title: "Alpha" });
  });

  it("leaves Shift- and Alt-click to the selection", () => {
    const { opened, click } = mount(true);
    expect(click({ shiftKey: true })).toBeFalsy();
    expect(click({ altKey: true })).toBeFalsy();
    expect(opened).not.toHaveBeenCalled();
  });

  it("opens on a plain click when read-only, with no hint", () => {
    const { link, opened, click } = mount(false);
    expect(link.title).toBe("");
    expect(click()).toBe(true);
    expect(opened).toHaveBeenCalledWith({ title: "Alpha" });
  });

  it("carries the note id when its preview is known", () => {
    const { opened, click } = mount(true, { previews: [alpha] });
    click();
    expect(opened).toHaveBeenCalledWith({ title: "Alpha", id: "a1" });
  });
});

describe("links to missing notes", () => {
  it("mutes a title the server named missing, and a plain click on it places the caret", () => {
    const { link, missing, opened, click } = mount(true, { previews: [alpha], missingTitles: ["nowhere"] });
    expect(link.classList.contains("wiki-link-missing")).toBe(false);
    expect(missing.classList.contains("wiki-link-missing")).toBe(true);
    expect(missing.title).toBe("");
    expect(click({}, missing)).toBeFalsy();
    expect(opened).not.toHaveBeenCalled();
  });

  it("keeps a link with no preview as a normal link when the server did not name it missing", () => {
    // A link added after load: no preview yet, not in the server's missing list.
    const { missing: added, opened, click } = mount(true, { previews: [alpha], missingTitles: [] });
    expect(added.classList.contains("wiki-link-missing")).toBe(false);
    expect(added.title).toBe("Click to open. Use the arrow keys to edit it.");
    expect(click({}, added)).toBe(true);
    expect(opened).toHaveBeenCalledWith({ title: "Nowhere" });
  });

  it("lets a preview win over a stale missing title", () => {
    const { link, opened, click } = mount(true, { previews: [alpha], missingTitles: ["Alpha"] });
    expect(link.classList.contains("wiki-link-missing")).toBe(false);
    click();
    expect(opened).toHaveBeenCalledWith({ title: "Alpha", id: "a1" });
  });

  it("does not mute a link to the open note, and a click on it stays in the note", () => {
    const { link, opened, click } = mount(true, { previews: [], missingTitles: ["Nowhere"], noteTitle: "alpha " });
    expect(link.classList.contains("wiki-link-missing")).toBe(false);
    expect(click()).toBeFalsy();
    expect(opened).not.toHaveBeenCalled();
  });

  it("are not judged when the host names none", () => {
    const { missing } = mount(true);
    expect(missing.classList.contains("wiki-link-missing")).toBe(false);
  });
});
