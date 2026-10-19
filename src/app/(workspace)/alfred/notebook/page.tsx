import Link from "next/link";
import { connection } from "next/server";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { getNote, listNoteVersions, listNotes, type NoteContent } from "@/domains/knowledge/notes";
import { getAuthContext } from "@/lib/auth";
import { NewNoteButton, NoteEditor } from "./note-editor";

export const metadata = { title: "Notebook · Axiom" };

/*
 * The notebook on the canonical artifact rows (ASH-141 / B04): the list,
 * autosaving editor, checkpoints, history and draft recovery all read and
 * write the same artifact tables generated work uses. The /apps/alfred
 * notebook screen redirects here — one surface, one source of truth.
 */

export function noteMarkdown(content: NoteContent | null): string {
  if (!content) return "";
  if (typeof content.text === "string") return content.text;
  return "";
}

export default async function NotebookPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  await connection();
  const auth = await getAuthContext();
  const { id } = await searchParams;
  const notes = await listNotes(auth);
  const selected = id ? await getNote(auth, id) : null;
  const versions = selected ? await listNoteVersions(auth, selected.id) : [];

  return (
    <Screen
      title="Notebook"
      description="Notes live on the same artifact rows as generated work — autosaved as you type, with checkpoints you can name and a history you can trust."
      actions={<NewNoteButton />}
    >
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Panel title="Notes" description={`${notes.length} in this workspace`}>
          {notes.length === 0 ? (
            <Empty title="No notes yet" description="Create the first note — it autosaves as you type, and every checkpoint becomes an immutable version." />
          ) : (
            <ul className="flex flex-col gap-1">
              {notes.map((note) => (
                <li key={note.id}>
                  <Link
                    href={`/alfred/notebook?id=${note.id}`}
                    className={`block rounded-md border px-3 py-2 text-[13px] ${selected?.id === note.id ? "border-foreground/30 bg-muted/60" : "border-transparent hover:bg-muted/40"}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{note.title}</span>
                      {note.hasDraft && <Status>draft</Status>}
                    </span>
                    {note.excerpt && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{note.excerpt}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        {selected ? (
          <NoteEditor
            key={selected.id}
            noteId={selected.id}
            initialTitle={selected.title}
            initialVersion={selected.version}
            initialMarkdown={noteMarkdown(selected.content)}
            draft={selected.draft ? { markdown: noteMarkdown(selected.draft.content), updatedAt: selected.draft.updatedAt.toISOString() } : null}
            versions={versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() }))}
          />
        ) : (
          <Panel>
            <Empty title="Choose a note" description="Pick a note on the left, or start a new one. Editing begins the moment you type." />
          </Panel>
        )}
      </div>
    </Screen>
  );
}
