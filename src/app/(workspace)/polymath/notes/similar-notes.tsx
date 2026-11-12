"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, Link2, Waypoints } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/tooltip";
import { sanitizeLinkText } from "@/components/products/polymath/link-target-insertion";
import { similarNotesAction, type SimilarNotes } from "./actions";

/*
 * "Find similar notes" while writing: the notes that mean something close to
 * this one, each with a one-click [[link]] into the text at the caret. The
 * connection stays the writer's choice; nothing is linked for them. A title
 * opens that note beside this one, so a candidate can be read before it is
 * linked.
 *
 * It asks on every opening, from the live text, because the note it answers
 * for is the one on screen, not the one the server last saw. A popover, not a
 * dialog: the writer can keep typing while it answers.
 */

type State = { phase: "loading" } | { phase: "ready"; result: SimilarNotes } | { phase: "error" };

/** The text already links this title. Case-insensitive, like link resolution. */
function linksTo(markdown: string, title: string): boolean {
  const wanted = sanitizeLinkText(title).toLowerCase();
  for (const match of markdown.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    if (match[1].split("|")[0].trim().toLowerCase() === wanted) return true;
  }
  return false;
}

export function SimilarNotesButton({
  noteId,
  title,
  markdown,
  onLink,
  onOpen,
}: {
  noteId: string;
  title: string;
  markdown: string;
  /** Writes `[[title]]` into the note. */
  onLink: (wikiLink: string) => void;
  /** Opens a candidate beside the note. */
  onOpen: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ phase: "loading" });
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const asked = useRef(0);

  const ask = () => {
    const call = ++asked.current;
    setState({ phase: "loading" });
    similarNotesAction({ noteId, title, text: markdown }).then(
      (result) => call === asked.current && setState({ phase: "ready", result }),
      () => call === asked.current && setState({ phase: "error" }),
    );
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    // Below sm the panel spans the bar (the nearest positioned ancestor), so
    // it never runs off the left edge of a phone.
    <div ref={container} className="sm:relative">
      <Hint label="Find similar notes">
        <Button
          ref={trigger}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Find similar notes"
          aria-expanded={open}
          aria-controls={panelId}
          // The caret stays in the text, so a link lands where the writer was.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (!open) ask();
            setOpen(!open);
          }}
        >
          <Waypoints aria-hidden className="text-muted-foreground" />
        </Button>
      </Hint>
      {open ? (
        <div
          id={panelId}
          role="region"
          aria-label="Similar notes"
          className="panel bg-popover text-popover-foreground shadow-raised absolute top-full z-50 mt-1.5 max-h-[min(70dvh,520px)] overflow-y-auto rounded-[9px] p-1.5 max-sm:inset-x-3 sm:right-0 sm:w-[360px]"
        >
          <p className="text-muted-foreground px-2 pt-1.5 pb-1 text-label font-medium">Similar notes</p>
          {state.phase === "loading" ? (
            <p role="status" className="text-muted-foreground px-2 py-1.5 text-label">
              Reading this note for what it means…
            </p>
          ) : state.phase === "error" ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-label">
              <span role="alert" className="text-destructive">
                Could not search just now.
              </span>
              <Button type="button" variant="ghost" size="xs" onClick={ask}>
                Try again
              </Button>
            </div>
          ) : state.result.meaning === "unconfigured" ? (
            <p className="text-muted-foreground px-2 py-1.5 text-label">
              Meaning search is not set up in this workspace, so similar notes cannot be found yet.
            </p>
          ) : state.result.meaning === "failed" ? (
            <div className="flex items-center gap-2 px-2 py-1.5 text-label">
              <span role="alert" className="text-destructive">
                Meaning search did not answer.
              </span>
              <Button type="button" variant="ghost" size="xs" onClick={ask}>
                Try again
              </Button>
            </div>
          ) : state.result.notes.length === 0 ? (
            <p className="text-muted-foreground px-2 py-1.5 text-label">
              {markdown.trim()
                ? "Nothing close to this note yet."
                : "Write a few lines first; similar notes follow what the note says."}
            </p>
          ) : (
            <ul className="flex flex-col">
              {state.result.notes.map((note) => {
                const linked = linksTo(markdown, note.title);
                const name = note.title || "Untitled note";
                return (
                  <li key={note.id} className="hover:bg-muted/60 flex items-start gap-2 rounded-md px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        onOpen(note.id);
                      }}
                      className="focus-visible:ring-ring min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-2"
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 truncate text-body-dense">{name}</span>
                        {note.kind === "zettel" ? (
                          <span className="text-muted-foreground shrink-0 text-data">zettel</span>
                        ) : null}
                        {note.similarity !== null ? (
                          <span className="text-muted-foreground ml-auto shrink-0 text-data tabular-nums">
                            {Math.round(note.similarity * 100)}%
                          </span>
                        ) : null}
                      </span>
                      {note.snippet ? (
                        <span className="text-muted-foreground mt-0.5 line-clamp-2 block text-label leading-5">
                          {note.snippet}
                        </span>
                      ) : null}
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-muted-foreground shrink-0"
                      disabled={linked}
                      aria-label={linked ? `${name} is linked` : `Link ${name}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onLink(`[[${sanitizeLinkText(note.title)}]] `)}
                    >
                      {linked ? <Check aria-hidden className="size-3.5" /> : <Link2 aria-hidden className="size-3.5" />}
                      {linked ? "Linked" : "Link"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
