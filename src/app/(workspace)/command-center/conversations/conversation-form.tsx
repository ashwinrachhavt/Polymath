"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/workspace/ui";
import { createConversationAction } from "./actions";

/* Start-a-conversation island. On success the action redirects to the new
 * thread's timeline. */

export function ConversationForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        setError(null);
        startTransition(async () => {
          const result = await createConversationAction({
            title: String(data.get("title") || ""),
            openingMessage: String(data.get("openingMessage") || ""),
          });
          if (!result?.ok) {
            setError(result?.error ?? "Could not start the conversation.");
            return;
          }
          form.reset();
        });
      }}
    >
      <Field label="Title">
        <Input name="title" maxLength={200} placeholder="What is this conversation about?" />
      </Field>
      <Field label="Opening message (optional)">
        <textarea
          name="openingMessage"
          rows={3}
          maxLength={4000}
          placeholder="The first message in the thread."
          className="border-input bg-background w-full rounded-md border px-3 py-2 text-[13px]"
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Starting…" : "Start conversation"}
        </Button>
        {error ? <p className="text-destructive text-[13px]" role="alert">{error}</p> : null}
      </div>
    </form>
  );
}
