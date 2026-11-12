import type { NoteListItem } from "@/domains/knowledge/notes";
import { groupHistory, type HistoryGroup } from "../history";

/*
 * The Notes popover's rows: the same day buckets the Chats popover uses, built
 * on the server for the same reason (a row never jumps between "Today" and
 * "Yesterday" by the reader's timezone). A plain module, because the page and
 * the browse action both speak it.
 */

/** How many notes the popover lists, newest first, before a search narrows it. */
export const NOTES_LIST_SIZE = 30;

/** The list holds notes; zettels and ideas have surfaces of their own. */
export const LISTED_KINDS = ["note"] as const;

export function noteHistory(items: NoteListItem[]): HistoryGroup[] {
  return groupHistory(
    items.map((note) => ({
      id: note.id,
      title: note.title.trim() || "Untitled note",
      href: `/polymath/notes?id=${note.id}`,
      at: note.updatedAt,
    })),
  );
}
