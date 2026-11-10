import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { autocompleteEnabled, fetchCompletion, type CompleteFn } from "./autocomplete-client";

/*
 * Inline autocomplete for prose, the way a code editor completes a line: pause
 * while writing and the next few words appear as ghost text after the caret.
 *
 *   Tab             accept the whole suggestion
 *   Cmd/Ctrl + →    accept the next word
 *   Esc             dismiss
 *   keep typing     a suggestion you type through stays, anything else clears it
 *
 * The suggestion is a decoration, never part of the document, so autosave,
 * undo history and the Markdown the note stores never see it until it is
 * accepted. Requests are debounced and cancelled the moment the writer types
 * again, and only fire at the end of a block of prose - not in code, not while
 * the slash or [[ menus are open, not during IME composition.
 */

type Suggestion = { text: string; pos: number };
type Meta = { type: "set"; suggestion: Suggestion } | { type: "clear" };

export type InlineCompletionOptions = {
  complete: CompleteFn;
  isEnabled: () => boolean;
  debounceMs: number;
};

const key = new PluginKey<Suggestion | null>("inlineCompletion");

/** The suggestion showing in this editor state, if any (for tests and hosts). */
export function inlineSuggestion(state: EditorState): string | null {
  return key.getState(state)?.text ?? null;
}

const BEFORE_CHARS = 2_400;
const AFTER_CHARS = 500;
/** Open menus own the keyboard: [[ link query, or a / block query. */
const MENU_OPEN = /(\[\[[^\]\n]*|(^|\s)\/[\w-]*)$/;

function nextState(tr: Transaction, shown: Suggestion | null, next: EditorState): Suggestion | null {
  const meta = tr.getMeta(key) as Meta | undefined;
  if (meta) return meta.type === "set" ? meta.suggestion : null;
  if (!shown) return null;
  const { selection } = next;
  if (tr.docChanged) {
    // Typing through the suggestion keeps the rest of it, like Copilot.
    const typed =
      selection.empty && selection.from > shown.pos && tr.mapping.map(shown.pos, -1) === shown.pos
        ? next.doc.textBetween(shown.pos, selection.from, "\n")
        : "";
    const grewBy = next.doc.content.size - tr.before.content.size;
    if (typed && grewBy === typed.length && shown.text.startsWith(typed) && shown.text.length > typed.length) {
      return { text: shown.text.slice(typed.length), pos: selection.from };
    }
    return null;
  }
  // The caret moved away without typing.
  return selection.empty && selection.from === shown.pos ? shown : null;
}

function ghost(text: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "inline-completion";
  span.setAttribute("aria-hidden", "true");
  span.contentEditable = "false";
  span.textContent = text;
  const hint = document.createElement("span");
  hint.className = "inline-completion-hint readout";
  hint.textContent = "Tab";
  span.appendChild(hint);
  return span;
}

export const InlineCompletion = Extension.create<InlineCompletionOptions>({
  name: "inlineCompletion",
  // Ahead of the list keymap, so Tab accepts a visible suggestion before it
  // would indent a list item.
  priority: 1000,

  addOptions() {
    return { complete: fetchCompletion, isEnabled: autocompleteEnabled, debounceMs: 350 };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: AbortController | undefined;

    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      inFlight?.abort();
      inFlight = undefined;
    };

    const request = (view: EditorView) => {
      timer = undefined;
      const { state } = view;
      const { selection } = state;
      if (!options.isEnabled() || !view.editable || !view.hasFocus() || view.composing || !selection.empty) return;
      const { $from, from } = selection;
      const block = $from.parent;
      if (!block.isTextblock || block.type.spec.code) return;
      // Only at the end of the block: text to the right means an edit, not a continuation.
      if (block.textBetween($from.parentOffset, block.content.size).trim()) return;
      if (MENU_OPEN.test(block.textBetween(0, $from.parentOffset))) return;
      const before = state.doc.textBetween(Math.max(0, from - BEFORE_CHARS), from, "\n");
      if (before.trim().length < 12) return;
      const after = state.doc.textBetween(from, Math.min(state.doc.content.size, from + AFTER_CHARS), "\n");
      const title = view.dom.closest("[data-note-title]")?.getAttribute("data-note-title") ?? undefined;

      const controller = new AbortController();
      inFlight = controller;
      const doc = state.doc;
      void options
        .complete({ title: title || undefined, before, after }, controller.signal)
        .then((text) => {
          if (controller.signal.aborted || view.isDestroyed || !text) return;
          const now = view.state;
          // The note moved on while the model was thinking.
          if (now.doc !== doc || !now.selection.empty || now.selection.from !== from) return;
          view.dispatch(now.tr.setMeta(key, { type: "set", suggestion: { text, pos: from } } satisfies Meta));
        })
        .catch(() => {
          // No suggestion is not an error the writer should see.
        });
    };

    const accept = (view: EditorView, shown: Suggestion, chunk: string) => {
      const rest = shown.text.slice(chunk.length);
      const meta: Meta = rest
        ? { type: "set", suggestion: { text: rest, pos: shown.pos + chunk.length } }
        : { type: "clear" };
      view.dispatch(view.state.tr.insertText(chunk, shown.pos).setMeta(key, meta).scrollIntoView());
    };

    return [
      new Plugin<Suggestion | null>({
        key,
        state: {
          init: () => null,
          apply: (tr, shown, _old, next) => nextState(tr, shown, next),
        },
        props: {
          decorations(state) {
            const shown = key.getState(state);
            if (!shown) return null;
            return DecorationSet.create(state.doc, [
              Decoration.widget(shown.pos, () => ghost(shown.text), {
                side: 1,
                key: shown.text,
                ignoreSelection: true,
              }),
            ]);
          },
          handleKeyDown(view, event) {
            const shown = key.getState(view.state);
            if (!shown) return false;
            const plain = !event.shiftKey && !event.altKey;
            if (event.key === "Tab" && plain && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              accept(view, shown, shown.text);
              return true;
            }
            if (event.key === "ArrowRight" && plain && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              accept(view, shown, /^\s*\S+/.exec(shown.text)?.[0] ?? shown.text);
              return true;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              cancel();
              view.dispatch(view.state.tr.setMeta(key, { type: "clear" } satisfies Meta));
              return true;
            }
            return false;
          },
          handleDOMEvents: {
            blur(view) {
              cancel();
              if (key.getState(view.state)) view.dispatch(view.state.tr.setMeta(key, { type: "clear" } satisfies Meta));
              return false;
            },
          },
        },
        view() {
          return {
            update(view, previous) {
              if (previous.doc === view.state.doc) {
                // A caret move alone never asks for a suggestion, and drops a pending one.
                if (!previous.selection.eq(view.state.selection)) cancel();
                return;
              }
              cancel();
              // Still typing through a suggestion: nothing new to ask for.
              if (key.getState(view.state)) return;
              timer = setTimeout(() => request(view), options.debounceMs);
            },
            destroy: cancel,
          };
        },
      }),
    ];
  },
});
