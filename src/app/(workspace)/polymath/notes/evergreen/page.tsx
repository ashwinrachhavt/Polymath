import { Suspense } from "react";
import { io } from "next/cache";
import { z } from "zod";
import { Skeleton } from "@/components/ui/skeleton";
import { getNote, listNoteBacklinks, listNotes } from "@/domains/knowledge/notes";
import { noteContentToMarkdown } from "@/domains/knowledge/note-content";
import { markdownToPlainText } from "@/lib/display-text";
import { getAuthContext } from "@/lib/auth";
import type { RawSearchParams } from "@/lib/list-params";
import { EvergreenStack, type StackIndexEntry, type StackNote } from "./evergreen-stack";

export const metadata = { title: "Notes · Polymath" };

/*
 * A read-only view of the notes graph in the evergreen-notes style: each note
 * opens as a pane to the right of the one that linked to it, earlier panes
 * fold into spines, and every pane ends with the notes that link to it. The
 * open trail lives in the URL (?stack=id,id,...) so it can be shared, reloaded
 * and walked back with the browser. Editing stays on /polymath/notes.
 */

const MAX_PANES = 8;
const uuid = z.string().uuid();

function parseStack(raw: RawSearchParams): string[] {
  const value = typeof raw.stack === "string" ? raw.stack : "";
  const ids = value.split(",").filter((id) => uuid.safeParse(id).success);
  return [...new Set(ids)].slice(-MAX_PANES);
}

async function EvergreenSurface({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  await io();
  const auth = await getAuthContext();
  const stack = parseStack(await searchParams);

  const [all, opened] = await Promise.all([
    listNotes(auth, 2000),
    Promise.all(
      stack.map(async (id) => {
        const note = await getNote(auth, id);
        if (!note) return null;
        const backlinks = await listNoteBacklinks(auth, id);
        return { note, backlinks };
      }),
    ),
  ]);

  const index: StackIndexEntry[] = all.map((n) => ({
    id: n.id,
    title: n.title,
    kind: n.kind,
    tags: Array.isArray(n.tags) ? n.tags.filter((t): t is string => typeof t === "string") : [],
    updatedAt: n.updatedAt.toISOString(),
    excerpt: n.excerpt ? markdownToPlainText(n.excerpt).slice(0, 280) : null,
  }));

  const notes: StackNote[] = opened
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .map(({ note, backlinks }) => ({
      id: note.id,
      title: note.title,
      kind: note.kind,
      tags: note.tags,
      updatedAt: note.updatedAt.toISOString(),
      markdown: noteContentToMarkdown(note.draft?.content ?? note.content),
      backlinks: backlinks.map((b) => ({
        id: b.id,
        title: b.title,
        snippet: b.context ? markdownToPlainText(b.context) : b.excerpt ? markdownToPlainText(b.excerpt) : null,
      })),
    }));

  return <EvergreenStack index={index} notes={notes} />;
}

export default function EvergreenNotesPage(props: { searchParams: Promise<RawSearchParams> }) {
  return (
    <Suspense
      fallback={
        <div role="status" aria-label="Loading notes" className="flex h-full gap-0">
          <div className="flex w-[22rem] shrink-0 flex-col gap-3 border-r border-border p-8">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-8 w-full" />
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-[85%]" />
            ))}
          </div>
        </div>
      }
    >
      <EvergreenSurface {...props} />
    </Suspense>
  );
}
