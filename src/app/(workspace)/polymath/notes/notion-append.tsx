"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { listNotionPagesAction, proposeNotionAppendAction } from "./actions";

/*
 * "Add to Notion page" from the note editor (ASH-283).
 *
 * The owner picks the page, so the write targets something they chose rather
 * than something a model inferred. Pressing the button creates a proposal, not
 * a write: the review queue shows the diff against the page and the owner
 * approves there. This dialog says so, because a button that looked like a save
 * would make the approval step feel like a confirmation of something already
 * done.
 */

type Page = { id: string; title: string; url: string };
type State =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "choosing"; pages: Page[] }
  | { phase: "proposing"; page: Page }
  | { phase: "queued"; page: Page }
  | { phase: "error"; message: string };

export function NotionAppendAction({
  noteId,
  title,
  markdown,
  disabled,
}: {
  noteId: string;
  title: string;
  markdown: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State>({ phase: "idle" });
  const [query, setQuery] = useState("");

  async function loadPages() {
    setState({ phase: "loading" });
    const pages = await listNotionPagesAction();
    setState(pages.length > 0 ? { phase: "choosing", pages } : { phase: "error", message: "No Notion pages are available. Connect Notion in Integrations first." });
  }

  async function propose(page: Page) {
    setState({ phase: "proposing", page });
    const result = await proposeNotionAppendAction({
      noteId,
      notionPageId: page.id,
      notionPageTitle: page.title || title || "Untitled note",
      markdown,
    });
    setState(result.ok ? { phase: "queued", page } : { phase: "error", message: result.error });
  }

  const pages = state.phase === "choosing" ? state.pages : [];
  const shown = query.trim() ? pages.filter((page) => page.title.toLowerCase().includes(query.trim().toLowerCase())) : pages;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Each opening re-reads the page list: an account connected or a page
        // shared since last time should be there without a reload.
        if (next) {
          setState({ phase: "idle" });
          setQuery("");
          void loadPages();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="xs" variant="ghost" className="text-muted-foreground" disabled={disabled}>
          Add to Notion
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Add to a Notion page</DialogTitle>
        <DialogDescription>
          Choose where this note should go. Nothing is written yet: you review the diff in Reviews and approve it there.
        </DialogDescription>

        {(state.phase === "loading" || state.phase === "idle") && <p role="status" className="mt-3 text-[13px] text-muted-foreground">Loading your pages…</p>}

        {state.phase === "choosing" && (
          <div className="mt-3 flex flex-col gap-2">
            <input
              aria-label="Filter pages"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter by title"
              className="rounded-md border border-border bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {shown.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">No page matches “{query}”.</p>
            ) : (
              <ul className="max-h-72 overflow-y-auto">
                {shown.map((page) => (
                  <li key={page.id}>
                    <button
                      type="button"
                      onClick={() => void propose(page)}
                      className="hover:bg-muted focus-visible:ring-ring flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] outline-none focus-visible:ring-2"
                    >
                      <span className="min-w-0 flex-1 truncate">{page.title || "Untitled page"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {state.phase === "proposing" && (
          <p role="status" className="mt-3 text-[13px] text-muted-foreground">
            Queuing for review…
          </p>
        )}

        {state.phase === "queued" && (
          <p role="status" className="mt-3 text-[13px]">
            Queued. Approve the diff in{" "}
            <a href="/reviews" className="text-primary underline decoration-primary/30 underline-offset-2">
              Reviews
            </a>{" "}
            to add it to “{state.page.title || "Untitled page"}”.
          </p>
        )}

        {state.phase === "error" && (
          <p role="status" className="mt-3 text-[13px] text-destructive">
            {state.message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
