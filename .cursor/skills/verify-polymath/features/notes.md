# Notes

What it is: the writing surface over canonical note rows (ASH-141 / B04). A paginated list, one autosaving editor, version checkpoints and draft recovery, backlinks and tags, and note search across the workspace.

## Sub-features

- The list at `/polymath/notes`: the `ListToolbar` search and filters, pagination, and the "New note" button (an `aria-label="New note"` control in `note-editor.tsx`).
- The editor: autosaving `NoteEditor`, checkpoints, history, and draft recovery, with a comments panel and a Notion append action.
- Per-note links: backlinks, outlinks, and tags.
- Search: retrieval over notes by the kinds in `SEARCH_KINDS` (`src/domains/knowledge/retrieval.ts`).

## How to get to it (user POV)

The rail entry "Notes" leads to `/polymath/notes`. Opening a note opens the editor workspace; the notebook toggle switches between list and workspace layouts.

## Driving it with agent-browser

1. Open `http://localhost:3000/polymath/notes` and snapshot.
2. Click the "New note" button. The editor mounts asynchronously behind a "Loading the editor" status, so wait for the editor before typing.
3. Type a distinctive sentence, wait for the autosave, then reload the page. The sentence must survive. That round trip is the proof: list, editor, and persistence over the same rows.
4. From the editor, follow the link to `/polymath/graph` to hand off to the graph journey.
5. Capture the list and the reloaded editor to `/home/user/work/evidence/verify-polymath/`.

## Gotchas

- The editor mounts after a loading status; asserting before it hydrates produces flakes. The `waitSettled` pattern in `tests/e2e/helpers/settled.ts` exists for this.
- `tests/e2e/local-write-card.spec.ts` and `tests/e2e/task-notes-editor.spec.ts` own local writes and the editor in CI. Read them before adding new assertions here.
- A note created through the UI persists in the shared QA database. Delete it in cleanup if it was created only for the journey.
