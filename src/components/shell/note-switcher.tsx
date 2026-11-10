"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createNoteAction, findLinkTargetsAction } from "@/app/(workspace)/polymath/notes/actions";

type Hit = { id: string; title: string; kind: string };
type Row = { kind: "open"; hit: Hit } | { kind: "create"; title: string };

/*
 * The note finder (Cmd/Ctrl+K on the notes page). It searches note titles and
 * text with the same keyword lookup the [[link]] picker uses; Enter opens the
 * highlighted note, and the last row creates a note titled with the query.
 */
export function NoteSwitcher({ open, onOpenChange }: { open: boolean; onOpenChange(v: boolean): void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    let stale = false;
    const timer = window.setTimeout(
      () => {
        void findLinkTargetsAction({ query, mode: "keyword" })
          .then((rows) => {
            if (stale) return;
            setHits(rows.filter((row) => !("href" in row && row.href)));
            setActive(0);
          })
          .catch(() => {
            if (!stale) setHits([]);
          });
      },
      query ? 150 : 0,
    );
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const title = query.trim();
  const rows: Row[] = [
    ...hits.map((hit): Row => ({ kind: "open", hit })),
    ...(title ? [{ kind: "create", title } as Row] : []),
  ];

  const choose = (index: number) => {
    const row = rows[index];
    if (!row) return;
    if (row.kind === "open") {
      onOpenChange(false);
      router.push(`/polymath/notes?id=${row.hit.id}`);
      return;
    }
    startTransition(async () => {
      const result = await createNoteAction({ title: row.title });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
      router.push(`/polymath/notes?id=${result.artifactId}`);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setQuery("");
          setError("");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">Find a note</DialogTitle>
        <DialogDescription className="sr-only">
          Type to search your notes, then press Enter to open one.
        </DialogDescription>
        <Input
          autoFocus
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
              if (!pending) choose(active);
            }
          }}
        />
        <ul role="listbox" aria-label="Notes" className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
          {rows.map((row, index) => (
            <li key={row.kind === "open" ? row.hit.id : "create"} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                disabled={pending}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
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
