"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/workspace/ui";
import { captureTextAction, makeTaskAction, setCaptureStateAction } from "./actions";

/* The inbox's interactive islands over the durable captures table. */

type Action = (input: { captureId: string; expectedVersion: number }) => Promise<{ ok: true } | { ok: false; error: string }>;

export function CaptureForm() {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await captureTextAction({ text });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setText("");
        });
      }}
    >
      <Field label="Original material">
        <Textarea
          required
          maxLength={20000}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Paste a thought, source excerpt, or URL"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !text.trim()}>
          {pending ? "Capturing…" : "Capture to inbox"}
        </Button>
        {error ? <p className="text-destructive text-[13px]" role="alert">{error}</p> : null}
      </div>
    </form>
  );
}

export function CaptureActions({
  captureId,
  version,
  state,
}: {
  captureId: string;
  version: number;
  state: "open" | "discarded" | "converted";
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const act = (action: Action | typeof setCaptureStateAction, extra: Record<string, unknown> = {}) => {
    setError(null);
    startTransition(async () => {
      const result = await action({ captureId, expectedVersion: version, ...extra } as never);
      if (!result.ok) setError(result.error);
    });
  };

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {state === "open" ? (
        <>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => act(makeTaskAction)}>
            Make task
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(setCaptureStateAction, { state: "discarded" })}>
            Archive
          </Button>
        </>
      ) : null}
      {state === "discarded" ? (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => act(setCaptureStateAction, { state: "unprocessed" })}>
          Restore capture
        </Button>
      ) : null}
      {error ? <p className="text-destructive text-[13px]" role="alert">{error}</p> : null}
    </div>
  );
}
