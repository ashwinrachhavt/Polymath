/*
 * §14.13 keyboard map, §14.3 suggestion keys - one named place, tested.
 * While the suggestion block is focused, plain Enter keeps and Escape
 * discards; Cmd/Ctrl+Enter finalizes the current card (flushes the pause);
 * Cmd+]/Cmd+[ move between the rail's cards.
 */
export type SuggestionKeyAction = "keep" | "discard" | null;

export function suggestionKeyAction(key: string, suggestionFocused: boolean): SuggestionKeyAction {
  if (!suggestionFocused) return null;
  if (key === "Enter") return "keep";
  if (key === "Escape") return "discard";
  return null;
}

export function isFinalizeKey(e: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return e.key === "Enter" && (e.metaKey || e.ctrlKey);
}

export function isCardNavKey(e: { key: string; metaKey: boolean; ctrlKey: boolean }): "next" | "prev" | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  if (e.key === "]") return "next";
  if (e.key === "[") return "prev";
  return null;
}
