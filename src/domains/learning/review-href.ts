/** Where a deck is reviewed: inside its Notebook, or on Learn for a deck made from picked sources. */
export function deckReviewHref(deck: { deckId: string; notebookId: string | null }): string {
  return deck.notebookId
    ? `/projects/${deck.notebookId}/notebook/flashcards?deck=${deck.deckId}`
    : `/learn/decks/${deck.deckId}`;
}
