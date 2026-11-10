import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/*
 * A [[Title]] stays plain text in the document (the save path resolves it to a
 * graph edge), so it is styled here as a decoration rather than a mark: the
 * stored markdown is unchanged, the brackets fade, the title reads as a link,
 * and a click bubbles a WIKI_LINK_OPEN event (detail: the title) from the
 * editor's DOM for the host to resolve and open.
 */

export const WIKI_LINK_OPEN = "wikilink:open";

const WIKI = /\[\[([^\]\n]+)\]\]/g;
const key = new PluginKey<DecorationSet>("wikiLinks");

function decorate(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const match of node.text.matchAll(WIKI)) {
      const start = pos + (match.index ?? 0);
      const end = start + match[0].length;
      const title = match[1].split("|")[0].trim();
      decorations.push(
        Decoration.inline(start, start + 2, { class: "wiki-link-bracket" }),
        Decoration.inline(start + 2, end - 2, { class: "wiki-link", "data-wiki-title": title }),
        Decoration.inline(end - 2, end, { class: "wiki-link-bracket" }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const WikiLinks = Extension.create({
  name: "wikiLinks",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (_, state) => decorate(state.doc),
          apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
        },
        props: {
          decorations: (state) => key.getState(state),
          handleClick: (view, _pos, event) => {
            const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-wiki-title]");
            const title = target?.dataset.wikiTitle;
            if (!title) return false;
            event.preventDefault();
            view.dom.dispatchEvent(new CustomEvent(WIKI_LINK_OPEN, { detail: title, bubbles: true }));
            return true;
          },
        },
      }),
    ];
  },
});
