"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/workspace/ui";
import { captureTextAction } from "./actions";

/* The inbox's interactive islands over the durable captures table. */

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
