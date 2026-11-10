// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WIKI_LINK_OPEN, WikiLinks } from "@/components/products/polymath/wiki-links";

/*
 * Value: protects=a [[link]] can be edited in place (plain click) and still followed (Cmd/Ctrl-click,
 * or any click when read-only); fails_when=the editable/modifier branch is removed or inverted;
 * why_new=the click rule had no test; seam=none; no_claim=real pointer hit-testing (the handler is
 * called through ProseMirror's own prop lookup with the decorated element as target)
 */

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

function mount(editable: boolean) {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [StarterKit, WikiLinks],
    content: "<p>see [[Alpha]] here</p>",
    editable,
  });
  const opened = vi.fn();
  editor.view.dom.addEventListener(WIKI_LINK_OPEN, (event) => opened((event as CustomEvent<string>).detail));
  const link = editor.view.dom.querySelector<HTMLElement>("[data-wiki-title]")!;
  const click = (modifier: boolean) =>
    editor!.view.someProp("handleClick", (handle) =>
      handle(editor!.view, 0, { target: link, metaKey: modifier, ctrlKey: false, preventDefault() {} } as never),
    );
  return { link, opened, click };
}

describe("wiki link clicks in the editor", () => {
  it("decorates the title and leaves a plain click to the cursor while editing", () => {
    const { link, opened, click } = mount(true);
    expect(link.textContent).toBe("Alpha");
    expect(link.title).toBe("Cmd/Ctrl-click to open");
    expect(click(false)).toBeFalsy();
    expect(opened).not.toHaveBeenCalled();
  });

  it("opens on Cmd/Ctrl-click while editing", () => {
    const { opened, click } = mount(true);
    expect(click(true)).toBe(true);
    expect(opened).toHaveBeenCalledWith("Alpha");
  });

  it("opens on a plain click when read-only, with no modifier hint", () => {
    const { link, opened, click } = mount(false);
    expect(link.title).toBe("");
    expect(click(false)).toBe(true);
    expect(opened).toHaveBeenCalledWith("Alpha");
  });
});
