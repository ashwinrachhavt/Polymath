"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/*
 * Studio Generate from the dossier screen: the brief becomes a run bound to
 * this dossier. The run writes a draft, never a published artifact; the link
 * goes to the run on the Alfred screen.
 */
export function GenerateForm({ dossierId }: { dossierId: string }) {
  const [brief, setBrief] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  async function generate() {
    setPending(true);
    setError(null);
    setRunId(null);
    try {
      const response = await fetch(`/api/v1/dossiers/${dossierId}/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brief }),
      });
      if (!response.ok) {
        const problem = (await response.json().catch(() => null)) as { title?: string } | null;
        throw new Error(problem?.title ?? `Generate failed to start (${response.status}).`);
      }
      const { runId: started } = (await response.json()) as { runId: string };
      setRunId(started);
      setBrief("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Generate failed to start.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void generate();
      }}
    >
      <div className="flex items-center gap-2">
        <input
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          placeholder="What should the draft say?"
          required
          maxLength={2000}
          className="border-input bg-background h-9 w-96 max-w-full rounded-md border px-3 text-sm"
        />
        <Button type="submit" variant="outline" disabled={pending || !brief.trim()}>
          {pending ? "Starting…" : "Generate"}
        </Button>
      </div>
      {runId ? (
        <p className="text-muted-foreground text-[13px]">
          Run started. It writes a draft for review, nothing publishes. <a className="underline" href="/alfred">Watch it in the assistant</a>.
        </p>
      ) : null}
      {error ? <p className="text-destructive text-[13px]">{error}</p> : null}
    </form>
  );
}
