"use client";

import { useCallback, useEffect, useState } from "react";
import {
  acceptSuggestedLinkAction,
  dismissSuggestedLinkAction,
  listSittingSuggestedLinksAction,
} from "@/app/(workspace)/polymath/knowledge/zettels/session/actions";

/*
 * The ActionTasksSidebar (§14.9): the per-sitting "N suggested links" count
 * opens the batch review; each suggestion is accepted (becomes an explicit
 * related edge) or dismissed (never re-proposed on re-embed) in place.
 */

type Suggestion = { artifactId: string; artifactTitle: string; targetId: string; targetTitle: string | null; score: number | null };

export function ActionTasksSidebar({ sittingId, refreshKey }: { sittingId: string; refreshKey: string }) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<Suggestion[] | null>(null);

  const reload = useCallback(async () => {
    const result = await listSittingSuggestedLinksAction({ sittingId });
    setLinks("links" in result && result.links ? result.links : []);
  }, [sittingId]);

  useEffect(() => {
    let cancelled = false;
    void listSittingSuggestedLinksAction({ sittingId }).then((result) => {
      if (!cancelled) setLinks("links" in result && result.links ? result.links : []);
    });
    return () => {
      cancelled = true;
    };
  }, [sittingId, refreshKey]);

  const decide = useCallback(async (suggestion: Suggestion, keep: boolean) => {
    // Outcome-first: the row leaves the list immediately; a failure restores it.
    setLinks((prev) => (prev ?? []).filter((l) => !(l.artifactId === suggestion.artifactId && l.targetId === suggestion.targetId)));
    const result = keep
      ? await acceptSuggestedLinkAction({ sittingId, artifactId: suggestion.artifactId, targetId: suggestion.targetId })
      : await dismissSuggestedLinkAction({ sittingId, artifactId: suggestion.artifactId, targetId: suggestion.targetId });
    if ("error" in result) await reload();
  }, [sittingId, reload]);

  if (links === null) return null;
  return (
    <section aria-label="Action tasks" className="flex w-72 shrink-0 flex-col gap-2 border-l border-border p-4 max-lg:border-l-0 max-lg:border-t">
      <button type="button" className="min-h-11 text-left font-mono text-xs uppercase tracking-wide text-muted-foreground" onClick={() => setOpen((o) => !o)}>
        {links.length} suggested link{links.length === 1 ? "" : "s"} {open ? "▴" : "▾"}
      </button>
      {open && links.length === 0 && <p className="text-sm text-muted-foreground">No suggestions right now.</p>}
      {open && (
        <ul className="space-y-2">
          {links.map((suggestion) => (
            <li key={`${suggestion.artifactId}-${suggestion.targetId}`} className="rounded border border-border p-2 text-sm">
              <p className="text-xs text-muted-foreground">{suggestion.artifactTitle}</p>
              <p className="font-medium">→ {suggestion.targetTitle ?? "Untitled"}</p>
              <span className="mt-1 flex gap-2">
                <button type="button" className="min-h-11 rounded border border-border px-3 text-xs" onClick={() => void decide(suggestion, true)}>
                  Accept
                </button>
                <button type="button" className="min-h-11 rounded border border-border px-3 text-xs text-muted-foreground" onClick={() => void decide(suggestion, false)}>
                  Dismiss
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
