// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { WikiLinks, refreshWikiPreviews } from "@/components/products/polymath/wiki-links";

/*
 * Value: protects=the inline fallback for margin notes sits right after the paragraph that cites the note;
 * fails_when=the widget moves, doubles up per link, or ignores unknown titles; why_new=no coverage for the
 * widget decoration; seam=none; no_claim=the CSS that hides it while the margin column shows
 */

let editor: Editor | undefined;
afterEach(() => {
  editor?.destroy();
  editor = undefined;
});

const alpha = { id: "a1", title: "Alpha", firstParagraph: "About alpha." };
const beta = { id: "b2", title: "Beta", firstParagraph: "About beta." };

function mount(previews: (typeof alpha)[]) {
  editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [StarterKit, WikiLinks.configure({ previews })],
    content: "<p>first</p><p>see [[Alpha]] and [[alpha|Aliased]] and [[Beta]]</p><p>last [[Unknown]]</p>",
  });
  return editor;
}

describe("inline link notes", () => {
  it("places exactly one widget at the end of the paragraph that cites the notes", () => {
    const ed = mount([alpha, beta]);
    const widgets = ed.view.dom.querySelectorAll(".note-margin-inline");
    expect(widgets).toHaveLength(1);
    const paragraphs = ed.view.dom.querySelectorAll("p");
    expect(paragraphs[1].nextElementSibling).toBe(widgets[0]);
    expect(widgets[0].querySelector("summary")?.textContent).toBe("Alpha, Beta");
    expect(widgets[0].querySelectorAll("a")).toHaveLength(2);
    expect(widgets[0].textContent).toContain("About beta.");
  });

  it("adds no widget without a matching preview, and follows refreshed previews", () => {
    const ed = mount([]);
    expect(ed.view.dom.querySelector(".note-margin-inline")).toBeNull();
    refreshWikiPreviews(ed, [alpha]);
    expect(ed.view.dom.querySelectorAll(".note-margin-inline")).toHaveLength(1);
  });
});
