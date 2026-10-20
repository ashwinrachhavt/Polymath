"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { acceptCaptureAction, captureTextAction, discardCaptureAction, discardDocumentAction } from "./actions";

/*
 * One-action rows: each button fires its server action with the row's
 * version and the page revalidates in place. Errors land in the inline
 * status line; Edit converts the capture and opens the new note.
 */
export function CaptureForm() {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim() || pending) return;
        setError("");
        start(async () => {
          const result = await captureTextAction({ text, idempotencyKey: crypto.randomUUID() });
          if (!result.ok) { setError(result.message); return; }
          setText("");
        });
      }}
    >
      <Textarea aria-label="Quick capture" value={text} onChange={(event) => setText(event.target.value)} placeholder="Capture a thought, a quote, a link worth writing about..." className="min-h-20 text-[13px]" />
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending || !text.trim()}>{pending ? "Capturing..." : "Capture"}</Button>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
    </form>
  );
}

function useRowAction() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const run = (action: () => Promise<{ ok: boolean; message: string; noteId?: string }>, openNote: boolean) => {
    setError("");
    start(async () => {
      const result = await action();
      if (!result.ok) { setError(result.message); return; }
      if (openNote && result.noteId) router.push(`/alfred/notebook?id=${result.noteId}`);
      else router.refresh();
    });
  };
  return { error, pending, run };
}

export function CaptureRowActions({ id, version }: { id: string; version: number }) {
  const { error, pending, run } = useRowAction();
  return (
    <span className="flex items-center gap-2">
      <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => run(() => acceptCaptureAction({ captureId: id, expectedVersion: version }), false)}>Accept</Button>
      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => run(() => acceptCaptureAction({ captureId: id, expectedVersion: version }), true)}>Edit</Button>
      <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => run(() => discardCaptureAction({ captureId: id, expectedVersion: version }), false)}>Discard</Button>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </span>
  );
}

export function DocumentRowActions({ id, version }: { id: string; version: number }) {
  const router = useRouter();
  const { error, pending, run } = useRowAction();
  return (
    <span className="flex items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => router.push(`/alfred/knowledge?id=${id}`)}>Open</Button>
      <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => run(() => discardDocumentAction({ documentId: id, expectedVersion: version }), false)}>Discard</Button>
      {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
