import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/*
 * A [[Title]] stays plain text in the document (the save path resolves it to a
 * graph edge), so it is styled here as a decoration rather than a mark: the
 * stored markdown is unchanged, the brackets fade, the title reads as a link,
 * and a click (Cmd/Ctrl-click while editing) bubbles a WIKI_LINK_OPEN event (detail: the title) from the
 * editor's DOM for the host to resolve and open.
 */

export const WIKI_LINK_OPEN = "wikilink:open";

const WIKI = /\[\[([^\]\n]+)\]\]/g;
const key = new PluginKey("wikiLinks");

function decorate(doc: ProseMirrorNode, editable: boolean): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const match of node.text.matchAll(WIKI)) {
      const start = pos + (match.index ?? 0);
      const end = start + match[0].length;
      const title = match[1].split("|")[0].trim();
      decorations.push(
        Decoration.inline(start, start + 2, { class: "wiki-link-bracket" }),
        Decoration.inline(start + 2, end - 2, {
          class: "wiki-link",
          "data-wiki-title": title,
          // Only while editing does opening need the modifier.
          ...(editable ? { title: "Cmd/Ctrl-click to open" } : {}),
        }),
        Decoration.inline(end - 2, end, { class: "wiki-link-bracket" }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const WikiLinks = Extension.create({
  name: "wikiLinks",
  addProseMirrorPlugins() {
    const editor = this.editor;
    // Rebuilt when the document or the editable flag changes; the flag can
    // flip without a transaction, so the set is cached here, not in plugin state.
    let cache: { doc: ProseMirrorNode; editable: boolean; set: DecorationSet } | null = null;
    return [
      new Plugin({
        key,
        props: {
          decorations: (state) => {
            const editable = editor.isEditable;
            if (!cache || cache.doc !== state.doc || cache.editable !== editable) {
              cache = { doc: state.doc, editable, set: decorate(state.doc, editable) };
            }
            return cache.set;
          },
          handleClick: (view, _pos, event) => {
            const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-wiki-title]");
            const title = target?.dataset.wikiTitle;
            if (!title) return false;
            // While editing, a plain click places the cursor so the title can
            // be fixed; Cmd/Ctrl-click opens, like the editor's other links.
            if (view.editable && !(event.metaKey || event.ctrlKey)) return false;
            event.preventDefault();
            view.dom.dispatchEvent(new CustomEvent(WIKI_LINK_OPEN, { detail: title, bubbles: true }));
            return true;
          },
        },
      }),
    ];
  },
});
