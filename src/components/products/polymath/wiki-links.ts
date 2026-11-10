import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { LinkPreview } from "@/domains/knowledge/notes";

/*
 * A [[Title]] stays plain text in the document (the save path resolves it to a
 * graph edge), so it is styled here as a decoration rather than a mark: the
 * stored markdown is unchanged, the brackets fade, the title reads as a link,
 * and a click bubbles a WIKI_LINK_OPEN event from the editor's DOM for the
 * host to open. ProseMirror calls handleClick only for a click without a drag,
 * so a drag still selects, and the arrow keys move the caret into the title.
 *
 * With previews (the linked notes the server found), a link carries its note's
 * id, so the host opens it without a search, and a link to no note reads as
 * muted text. Without previews (null) no link is judged.
 */

export const WIKI_LINK_OPEN = "wikilink:open";
export type WikiLinkOpen = { title: string; id?: string };

const open = (from: HTMLElement, detail: WikiLinkOpen) =>
  from.dispatchEvent(new CustomEvent<WikiLinkOpen>(WIKI_LINK_OPEN, { detail, bubbles: true }));

const WIKI = /\[\[([^\]\n]+)\]\]/g;
const key = new PluginKey("wikiLinks");

/*
 * Where the page has no room for a margin column, the previews fold into the
 * text: one <details> widget after each top-level block that cites a previewed
 * note, listing that block's links. A container query in globals.css hides it
 * while the margin column shows.
 */
function inlineNote(previews: LinkPreview[]): HTMLElement {
  const root = document.createElement("div");
  root.className = "note-margin-inline";
  root.contentEditable = "false";
  const details = root.appendChild(document.createElement("details"));
  const summary = details.appendChild(document.createElement("summary"));
  summary.textContent = previews.map((p) => p.title).join(", ");
  for (const preview of previews) {
    const entry = details.appendChild(document.createElement("div"));
    const link = entry.appendChild(document.createElement("a"));
    link.href = `/polymath/notes?id=${preview.id}`;
    link.textContent = preview.title;
    // A plain click opens in place through the host (client routing, no reload);
    // modified clicks keep the href so open-in-new-tab still works.
    link.addEventListener("click", (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      open(link, { title: preview.title, id: preview.id });
    });
    if (preview.firstParagraph) entry.appendChild(document.createElement("p")).textContent = preview.firstParagraph;
  }
  return root;
}

function decorate(doc: ProseMirrorNode, editable: boolean, previews: LinkPreview[] | null): DecorationSet {
  const byTitle = new Map((previews ?? []).map((p) => [p.title.trim().toLowerCase(), p]));
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const match of node.text.matchAll(WIKI)) {
      const start = pos + (match.index ?? 0);
      const end = start + match[0].length;
      const title = match[1].split("|")[0].trim();
      const preview = byTitle.get(title.toLowerCase());
      const missing = previews !== null && !preview;
      decorations.push(
        Decoration.inline(start, start + 2, { class: "wiki-link-bracket" }),
        Decoration.inline(start + 2, end - 2, {
          class: missing ? "wiki-link wiki-link-missing" : "wiki-link",
          "data-wiki-title": title,
          ...(preview ? { "data-wiki-id": preview.id } : {}),
          ...(editable && !missing ? { title: "Click to open. Use the arrow keys to edit it." } : {}),
        }),
        Decoration.inline(end - 2, end, { class: "wiki-link-bracket" }),
      );
    }
  });
  if (byTitle.size > 0) {
    doc.forEach((block, offset) => {
      const cited = new Map<string, LinkPreview>();
      block.descendants((node) => {
        if (!node.isText || !node.text) return;
        for (const match of node.text.matchAll(WIKI)) {
          const preview = byTitle.get(match[1].split("|")[0].trim().toLowerCase());
          if (preview) cited.set(preview.id, preview);
        }
      });
      if (cited.size === 0) return;
      const list = [...cited.values()];
      decorations.push(
        Decoration.widget(offset + block.nodeSize, () => inlineNote(list), {
          side: -1,
          // Keyed by content, so refreshed preview text redraws the widget.
          key: `wiki-inline-${list.map((p) => `${p.id}\u0000${p.title}\u0000${p.firstParagraph}`).join("\u0001")}`,
          stopEvent: () => true,
          ignoreSelection: true,
        }),
      );
    });
  }
  return DecorationSet.create(doc, decorations);
}

type Previews = { previews: LinkPreview[] | null };

export const WikiLinks = Extension.create<Previews, Previews>({
  name: "wikiLinks",
  addOptions: () => ({ previews: null }),
  // The previews live in storage so the host can swap them after mount (see refreshWikiPreviews).
  addStorage() {
    return { previews: this.options.previews };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    // Rebuilt when the document or the editable flag changes; the flag can
    // flip without a transaction, so the set is cached here, not in plugin state.
    let cache: {
      doc: ProseMirrorNode;
      editable: boolean;
      previews: LinkPreview[] | null;
      set: DecorationSet;
    } | null = null;
    const storage = this.storage;
    return [
      new Plugin({
        key,
        props: {
          decorations: (state) => {
            const editable = editor.isEditable;
            const previews = storage.previews;
            if (!cache || cache.doc !== state.doc || cache.editable !== editable || cache.previews !== previews) {
              cache = { doc: state.doc, editable, previews, set: decorate(state.doc, editable, previews) };
            }
            return cache.set;
          },
          handleClick: (view, _pos, event) => {
            const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-wiki-title]");
            const title = target?.dataset.wikiTitle;
            // Shift- and Alt-click extend or adjust the selection.
            if (!title || event.shiftKey || event.altKey) return false;
            event.preventDefault();
            const id = target.dataset.wikiId;
            open(view.dom, id ? { title, id } : { title });
            return true;
          },
        },
      }),
    ];
  },
});

/** Swap the previews of a mounted editor and redraw the inline notes. */
export function refreshWikiPreviews(editor: Editor, previews: LinkPreview[]) {
  (editor.storage as unknown as { wikiLinks: Previews }).wikiLinks.previews = previews;
  editor.view.dispatch(editor.state.tr.setMeta(key, true));
}
