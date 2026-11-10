// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
  WIKI_LINK_OPEN,
  WikiLinks,
  refreshWikiPreviews,
  type WikiLinkOpen,
} from "@/components/products/polymath/wiki-links";

/*
 * Value: protects=the inline fallback for margin notes sits right after the paragraph that cites the note;
 * fails_when=the widget moves, doubles up per link, ignores unknown titles, or keeps stale text after the
 * previews refresh; why_new=no coverage for the
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

  it("redraws when a preview's text changes", () => {
    const ed = mount([alpha]);
    refreshWikiPreviews(ed, [{ ...alpha, firstParagraph: "Rewritten." }]);
    expect(ed.view.dom.querySelector(".note-margin-inline")?.textContent).toContain("Rewritten.");
  });
});

describe("inline link note clicks", () => {
  function click(init: MouseEventInit) {
    const ed = mount([alpha]);
    const opened: WikiLinkOpen[] = [];
    ed.view.dom.addEventListener(WIKI_LINK_OPEN, (e) => opened.push((e as CustomEvent<WikiLinkOpen>).detail));
    const link = ed.view.dom.querySelector<HTMLAnchorElement>(".note-margin-inline a")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
    link.dispatchEvent(event);
    return { opened, prevented: event.defaultPrevented };
  }

  it("opens a plain click through the host instead of navigating", () => {
    expect(click({})).toEqual({ opened: [{ title: "Alpha", id: "a1" }], prevented: true });
  });

  it("leaves a meta-click to the browser", () => {
    expect(click({ metaKey: true })).toEqual({ opened: [], prevented: false });
  });
});
