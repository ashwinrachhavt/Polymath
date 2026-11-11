/*
 * Where dictated text goes and how it gets there. One insertion path serves
 * every kind of field: document.execCommand("insertText") is the browser's
 * own typing path, so a controlled React field sees an ordinary input event,
 * Tiptap/ProseMirror reads it as typed text, and the browser's undo stack
 * records it as one step. Verified headless in Chromium against the chat
 * composer, an uncontrolled form textarea and the note editor. The API is
 * deprecated without a replacement for this purpose; setRangeText below is
 * the fallback for text controls if a browser ever refuses it.
 */

/**
 * Input types that hold free text and expose a caret. Email is left out with
 * number and date: browsers refuse setSelectionRange on it, so there is no
 * caret to insert at.
 */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel"]);

/** Fired on a target after dictated words were inserted, once the browser's own input event has run. */
export const DICTATED_EVENT = "polymath:dictated";

export type DictationTarget = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

export function editableTarget(element: Element | null): DictationTarget | null {
  if (element instanceof HTMLTextAreaElement) return element.readOnly || element.disabled ? null : element;
  if (element instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(element.type) && !element.readOnly && !element.disabled ? element : null;
  }
  if (element instanceof HTMLElement && element.isContentEditable) return element;
  return null;
}

/** A space goes before dictated text unless the caret is at the start or after whitespace. */
export function needsLeadingSpace(charBefore: string): boolean {
  return charBefore !== "" && !/\s/.test(charBefore);
}

function isTextControl(target: DictationTarget): target is HTMLTextAreaElement | HTMLInputElement {
  return target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
}

function charBeforeRange(range: Range): string {
  const { startContainer, startOffset } = range;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    return startOffset > 0 ? (startContainer.textContent ?? "").charAt(startOffset - 1) : "";
  }
  const previous = startContainer.childNodes[startOffset - 1];
  return previous?.textContent?.slice(-1) ?? "";
}

/** The caret a contenteditable target last had, re-applied when focus has moved elsewhere. */
function restoreCaret(target: HTMLElement, saved: Range | null): Range {
  const selection = window.getSelection()!;
  const current = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  if (current && target.contains(current.startContainer)) return current;
  let range = saved && target.contains(saved.startContainer) ? saved : null;
  if (!range) {
    range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
  return range;
}

export type InsertResult = "inserted" | "gone";

/**
 * Insert at the target's caret. Insertion needs focus, so a target that lost
 * it gets it back for the insertion and the person's focus is returned
 * afterwards. A target no longer on the page reports "gone".
 */
export function insertDictation(target: DictationTarget, text: string, savedRange: Range | null): InsertResult {
  if (!target.isConnected) return "gone";
  const previous = document.activeElement;
  const refocus = previous !== target;
  // Read before focusing: a focus call may move a text control's caret.
  const start = isTextControl(target) ? (target.selectionStart ?? target.value.length) : 0;
  const end = isTextControl(target) ? (target.selectionEnd ?? start) : 0;
  if (refocus) target.focus({ preventScroll: true });
  try {
    if (isTextControl(target)) {
      // Re-applying the selection ends the browser's current typing run, so
      // one undo removes the dictated words and not what was typed before them.
      target.setSelectionRange(start, end);
      const insertion = (needsLeadingSpace(target.value.charAt(start - 1)) ? " " : "") + text;
      if (!document.execCommand("insertText", false, insertion)) {
        target.setRangeText(insertion, start, end, "end");
        target.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return "inserted";
    }
    const range = restoreCaret(target, savedRange);
    const insertion = (needsLeadingSpace(charBeforeRange(range)) ? " " : "") + text;
    return document.execCommand("insertText", false, insertion) ? "inserted" : "gone";
  } finally {
    if (refocus && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
  }
}
