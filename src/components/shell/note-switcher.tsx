"use client";

import { useEffect, useEffectEvent, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createNoteAction, findLinkTargetsAction } from "@/app/(workspace)/polymath/notes/actions";
import { randomId } from "@/lib/random-id";

type Hit = { id: string; title: string; kind: string };
type Row = { kind: "open"; hit: Hit } | { kind: "create"; title: string };

/** The hits, then a row that creates a note titled with the query unless one already has that title. */
function rowsFor(hits: Hit[], title: string): Row[] {
  const exists = hits.some((hit) => hit.title.trim().toLowerCase() === title.toLowerCase());
  return [
    ...hits.map((hit): Row => ({ kind: "open", hit })),
    ...(title && !exists ? [{ kind: "create", title } as const] : []),
  ];
}

/*
 * The note finder (Cmd/Ctrl+K on the notes page). It searches note and zettel
 * titles and text with the same keyword lookup the [[link]] picker uses; Enter
 * opens the highlighted note, and the last row creates a note titled with the
 * query. Hits remember the query they answer: an Enter typed before the hits
 * for the current query arrive waits for them, so it never opens the previous
 * query's hit or creates a twin of a note that exists.
 */
export function NoteSwitcher({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const router = useRouter();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ query: string; hits: Hit[] } | null>(null);
  const [active, setActive] = useState(0);
  const enterQueued = useRef(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const title = query.trim();
  const rows = rowsFor(results?.hits ?? [], title);
  const optionId = (index: number) => `${listId}-${index}`;

  const close = () => {
    setQuery("");
    setResults(null);
    setError("");
    enterQueued.current = false;
    onOpenChange(false);
  };

  const choose = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "open") {
      close();
      router.push(`/polymath/notes?id=${row.hit.id}`);
      return;
    }
    startTransition(async () => {
      const result = await createNoteAction({ title: row.title, idempotencyKey: randomId() });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      close();
      router.push(`/polymath/notes?id=${result.artifactId}`);
    });
  };

  const settle = useEffectEvent((answered: string, hits: Hit[]) => {
    setResults({ query: answered, hits });
    setActive(0);
    if (enterQueued.current) {
      enterQueued.current = false;
      choose(rowsFor(hits, answered.trim())[0]);
    }
  });

  useEffect(() => {
    if (!open) return;
    let stale = false;
    const timer = window.setTimeout(
      () => {
        void findLinkTargetsAction({ query, mode: "keyword", notesOnly: true })
          .catch(() => [])
          .then((hits) => {
            if (!stale) settle(query, hits);
          });
      },
      query ? 150 : 0,
    );
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  });

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">Find a note</DialogTitle>
        <DialogDescription className="sr-only">
          Type to search your notes, then press Enter to open one.
        </DialogDescription>
        <Input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={rows[active] ? optionId(active) : undefined}
          aria-label="Find a note"
          placeholder="Find or create a note"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((i) => Math.min(i + 1, rows.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (pending) return;
              if (results?.query === query) choose(rows[active]);
              else enterQueued.current = true;
            }
          }}
        />
        <ul id={listId} role="listbox" aria-label="Notes" className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
          {rows.map((row, index) => (
            <li key={row.kind === "open" ? row.hit.id : "create"} role="presentation">
              <button
                type="button"
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                disabled={pending}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(row)}
                className={`block w-full truncate rounded-md px-3 py-2 text-left text-body-dense ${index === active ? "bg-muted" : ""}`}
              >
                {row.kind === "open" ? row.hit.title : `Create note "${row.title}"`}
              </button>
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
