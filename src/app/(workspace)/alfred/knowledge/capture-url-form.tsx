"use client";

import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { captureUrlAction } from "./actions";

/*
 * The URL field that sits beside the upload button. Same destination: a
 * document in the inbox. The message under the field is the only feedback, so
 * a failed fetch says why instead of silently doing nothing.
 */

export function CaptureUrlForm() {
  const inputId = useId();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const url = String(new FormData(form).get("url") ?? "").trim();
        if (!url) return;
        startTransition(async () => {
          try {
            const result = await captureUrlAction(url);
            setMessage({ text: result.message, error: !result.ok });
            if (result.ok) form.reset();
          } catch {
            setMessage({ text: "That address could not be captured. Try again.", error: true });
          }
        });
      }}
    >
      <div className="flex items-center gap-2">
        <label htmlFor={inputId} className="sr-only">Address of a PDF, image, or web page</label>
        <input
          id={inputId}
          name="url"
          type="url"
          inputMode="url"
          required
          placeholder="Paste a link to a PDF, image, or web page"
          disabled={pending}
          className="border-input bg-background h-9 w-64 rounded-md border px-3 text-sm"
        />
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Capturing…" : "Capture"}
        </Button>
      </div>
      {message ? (
        <p role={message.error ? "alert" : "status"} className={message.error ? "text-destructive text-xs" : "text-muted-foreground text-xs"}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
