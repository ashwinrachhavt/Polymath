"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { linkRelatedNoteAction, removeLinkAction } from "@/app/(workspace)/polymath/notes/actions";

/*
 * §14.9 in the card's own metadata strip: pending semantic suggestions with
 * in-place accept (promoted to an explicit related edge) and dismiss (the
 * canonical dismissed store - never re-proposed on re-embed, §11).
 */
export function SuggestedLinksStrip({
  artifactId,
  suggestions,
}: {
  artifactId: string;
  suggestions: { targetId: string; targetTitle: string }[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  if (suggestions.length === 0) return null;

  const decide = async (targetId: string, keep: boolean) => {
    setPending(targetId);
    const result = keep
      ? await linkRelatedNoteAction({ artifactId, targetId })
      : await removeLinkAction({ artifactId, targetId, dismiss: true });
    setPending(null);
    if (result.ok) {
      setGone((prev) => new Set(prev).add(targetId));
    } else {
      router.refresh();
    }
  };

  const visible = suggestions.filter((s) => !gone.has(s.targetId));
  if (visible.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1.5" aria-label="Suggested links">
      {visible.map((suggestion) => (
        <span key={suggestion.targetId} className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px]">
          <span className="max-w-32 truncate">Suggested: {suggestion.targetTitle}</span>
          <button
            type="button"
            disabled={pending === suggestion.targetId}
            className="min-h-11 min-w-11 px-1 text-xs underline"
            onClick={() => void decide(suggestion.targetId, true)}
          >
            Accept
          </button>
          <button
            type="button"
            disabled={pending === suggestion.targetId}
            className="min-h-11 min-w-11 px-1 text-xs text-muted-foreground underline"
            onClick={() => void decide(suggestion.targetId, false)}
          >
            Dismiss
          </button>
        </span>
      ))}
    </span>
  );
}
