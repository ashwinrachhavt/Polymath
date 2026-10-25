"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startChatRun } from "@/app/(workspace)/apps/alfred/chat-actions";

/*
 * The session starter at the top of a project page (Perplexity parity): type
 * what you want, submit, and a project-scoped run begins. The run is bound to
 * the project through its subject, so search stays inside the project's
 * sources; the project's instructions and memory ride in the objective.
 */
export function StartSession({
  projectId,
  projectTitle,
  contextPrefix,
}: {
  projectId: string;
  projectTitle: string;
  /** Instructions + memory, resolved server-side and prepended to the objective. */
  contextPrefix: string;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function begin() {
    const objective = value.trim();
    if (!objective || pending) return;
    setError(null);
    start(async () => {
      const full = contextPrefix ? `${contextPrefix}\n\n${objective}` : objective;
      const result = await startChatRun({
        objective: full,
        subject: { type: "project", id: projectId },
      });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setValue("");
      router.push(`/alfred/${result.runId}`);
    });
  }

  return (
    <div>
      <form
        className="rounded-2xl border border-border bg-muted/30 px-4 py-5"
        onSubmit={(event) => {
          event.preventDefault();
          begin();
        }}
      >
        <label className="sr-only" htmlFor={`start-session-${projectId}`}>
          Start a session in {projectTitle}
        </label>
        <input
          id={`start-session-${projectId}`}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={`Start a session in ${projectTitle}`}
          maxLength={4000}
          className="w-full bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
        />
        <div className="mt-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs">
              <Plus aria-hidden className="size-3" /> Attach
            </span>
            <span className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs">
              <Search aria-hidden className="size-3" /> Search
            </span>
          </div>
          <Button type="submit" size="sm" disabled={pending || !value.trim()}>
            {pending ? <Loader2 aria-hidden className="animate-spin" /> : "Start"}
          </Button>
        </div>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
