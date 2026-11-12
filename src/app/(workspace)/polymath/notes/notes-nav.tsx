"use client";

import { HistoryMenu, type HistoryGroup } from "../history-menu";
import { browseNotesAction } from "./actions";
import { NewNoteButton } from "./note-editor";

const search = { label: "Search notes", run: (query: string) => browseNotesAction({ query }) };

/*
 * The way to every other note, built like the chat's: a "Notes" chip whose
 * popover lists them by day, searchable, beside the way to a new one. It sits
 * at the top of the page instead of in a column of its own, so the note keeps
 * the whole width.
 */
export function NotesNav({ groups, currentId }: { groups: HistoryGroup[]; currentId?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <HistoryMenu
        groups={groups}
        label="Notes"
        listLabel="Your notes"
        empty="No notes yet."
        currentId={currentId}
        search={search}
      />
      <NewNoteButton chip />
    </div>
  );
}
