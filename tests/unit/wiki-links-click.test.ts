// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WIKI_LINK_OPEN, WikiLinks, type WikiLinkOpen } from "@/components/products/polymath/wiki-links";
import type { LinkPreview } from "@/domains/knowledge/notes";

/*
 * Value: protects=a plain click (or tap) on a [[link]] opens it, with the note's id when its preview is
 * known; Shift/Alt-click and keyboard editing are left to the editor; a link to no note reads as muted
 * text; fails_when=the click rule regresses to modifier-only, the id is dropped, or missing links look
 * like links; why_new=the spec says "clicking the link opens that note" and touch had no way to open;
 * seam=none; no_claim=real pointer hit-testing and drag detection (ProseMirror calls handleClick only
 * for a click without a drag; the handler is called through its own prop lookup here)
 */

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

function mount(editable: boolean, previews: LinkPreview[] | null = null) {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [StarterKit, WikiLinks.configure({ previews })],
    content: "<p>see [[Alpha]] here and [[Nowhere]]</p>",
    editable,
  });
  const opened = vi.fn();
  editor.view.dom.addEventListener(WIKI_LINK_OPEN, (event) => opened((event as CustomEvent<WikiLinkOpen>).detail));
  const [link, missing] = editor.view.dom.querySelectorAll<HTMLElement>("[data-wiki-title]");
  const click = (init: { shiftKey?: boolean; altKey?: boolean } = {}) =>
    editor!.view.someProp("handleClick", (handle) =>
      handle(editor!.view, 0, { target: link, metaKey: false, ctrlKey: false, ...init, preventDefault() {} } as never),
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
    const { opened, click } = mount(true, [alpha]);
    click();
    expect(opened).toHaveBeenCalledWith({ title: "Alpha", id: "a1" });
  });
});

describe("links to missing notes", () => {
  it("are muted once previews are known", () => {
    const { link, missing } = mount(true, [alpha]);
    expect(link.classList.contains("wiki-link-missing")).toBe(false);
    expect(missing.classList.contains("wiki-link-missing")).toBe(true);
    expect(missing.title).toBe("");
  });

  it("are not judged when the host gives no previews", () => {
    const { missing } = mount(true);
    expect(missing.classList.contains("wiki-link-missing")).toBe(false);
  });
});
