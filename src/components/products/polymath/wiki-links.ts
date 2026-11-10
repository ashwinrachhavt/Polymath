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
 * id, so the host opens it without a search. A link reads as missing (muted,
 * and plain text to a click) only when its title is in `missingTitles`: the
 * titles that were in the note when the server rendered it and had no note.
 * Any other link without a preview, such as one added since, stays a normal
 * link and opens through the host's title search. A link to the open note
 * itself (the host's [[data-note-title]]) is not judged and does not navigate.
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

const titleKey = (title: string) => title.trim().toLowerCase();

function decorate(doc: ProseMirrorNode, editable: boolean, links: Links): DecorationSet {
  const byTitle = new Map((links.previews ?? []).map((p) => [titleKey(p.title), p]));
  const missingTitles = new Set(links.missingTitles.map(titleKey));
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    for (const match of node.text.matchAll(WIKI)) {
      const start = pos + (match.index ?? 0);
      const end = start + match[0].length;
      const title = match[1].split("|")[0].trim();
      const preview = byTitle.get(titleKey(title));
      const missing = !preview && missingTitles.has(titleKey(title));
      decorations.push(
        Decoration.inline(start, start + 2, { class: "wiki-link-bracket" }),
        Decoration.inline(start + 2, end - 2, {
          class: missing ? "wiki-link wiki-link-missing" : "wiki-link",
          "data-wiki-title": title,
          ...(missing ? { "data-wiki-missing": "" } : {}),
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
          const preview = byTitle.get(titleKey(match[1].split("|")[0]));
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

type Links = { previews: LinkPreview[] | null; missingTitles: string[] };

export const WikiLinks = Extension.create<Links, Links>({
  name: "wikiLinks",
  addOptions: () => ({ previews: null, missingTitles: [] }),
  // The link state lives in storage so the host can swap it after mount (see refreshWikiPreviews).
  addStorage() {
    return { previews: this.options.previews, missingTitles: this.options.missingTitles };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    // Rebuilt when the document or the editable flag changes; the flag can
    // flip without a transaction, so the set is cached here, not in plugin state.
    let cache: { doc: ProseMirrorNode; editable: boolean; links: Links; set: DecorationSet } | null = null;
    const storage = this.storage;
    return [
      new Plugin({
        key,
        props: {
          decorations: (state) => {
            const editable = editor.isEditable;
            const links = { previews: storage.previews, missingTitles: storage.missingTitles };
            if (
              !cache ||
              cache.doc !== state.doc ||
              cache.editable !== editable ||
              cache.links.previews !== links.previews ||
              cache.links.missingTitles !== links.missingTitles
            ) {
              cache = { doc: state.doc, editable, links, set: decorate(state.doc, editable, links) };
            }
            return cache.set;
          },
          handleClick: (view, _pos, event) => {
            const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-wiki-title]");
            const title = target?.dataset.wikiTitle;
            // Shift- and Alt-click extend or adjust the selection. A missing link,
            // and a link to the open note, are text: the click places the caret.
            if (!title || event.shiftKey || event.altKey || target.dataset.wikiMissing !== undefined) return false;
            const self = view.dom.closest<HTMLElement>("[data-note-title]")?.dataset.noteTitle;
            if (self !== undefined && titleKey(self) === titleKey(title)) return false;
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

/** Swap the previews (and the server's missing titles) of a mounted editor and redraw. */
export function refreshWikiPreviews(editor: Editor, previews: LinkPreview[], missingTitles: string[] = []) {
  const storage = (editor.storage as unknown as { wikiLinks: Links }).wikiLinks;
  storage.previews = previews;
  storage.missingTitles = missingTitles;
  editor.view.dispatch(editor.state.tr.setMeta(key, true));
}
