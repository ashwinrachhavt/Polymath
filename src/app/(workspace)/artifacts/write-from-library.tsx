"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { PenLine } from "lucide-react";
import { draftFromLibraryAction } from "./actions";

/*
 * "Write from library" (ASH-301): name a topic, get a long-form draft
 * grounded only in the library - citations into the source list, and
 * [citation needed] flags where the sources run out. An empty library is an
 * honest refusal, shown in place.
 */
export function WriteFromLibrary() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [topic, setTopic] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <PenLine aria-hidden className="size-3.5" />
        Write from library
      </button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      {error ? <span role="alert" className="w-full text-xs text-destructive sm:w-auto sm:max-w-72">{error}</span> : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          startTransition(async () => {
            const result = await draftFromLibraryAction({ topic });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            router.push(`/artifacts/${result.artifactId}`);
          });
        }}
        className="flex h-8 items-center gap-1.5 rounded-md border border-border px-2"
      >
        <label className="sr-only" htmlFor="library-draft-topic">Draft topic</label>
        <input
          id="library-draft-topic"
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          placeholder="Draft about…"
          autoFocus
          className="w-40 bg-transparent text-[13px] outline-none"
        />
        <button type="submit" disabled={pending || !topic.trim()} className="text-[13px] text-muted-foreground hover:text-foreground disabled:opacity-50">
          {pending ? "Drafting…" : "Draft"}
        </button>
      </form>
    </span>
  );
}
