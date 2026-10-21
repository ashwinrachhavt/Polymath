"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { requestJson } from "@/lib/client-request";

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
    const result = await requestJson<{ runId: string }>(`/api/v1/dossiers/${dossierId}/generate`, {
      method: "POST",
      body: { brief },
      idempotencyKey: crypto.randomUUID(),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.failure.title);
      return;
    }
    setRunId(result.data.runId);
    setBrief("");
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
          Run started. It writes a draft for review, nothing publishes. <Link className="underline" href="/alfred">Watch it in the assistant</Link>.
        </p>
      ) : null}
      {error ? <p className="text-destructive text-[13px]">{error}</p> : null}
    </form>
  );
}
