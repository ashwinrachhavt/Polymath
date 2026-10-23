"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { createAuthoredSkillAction } from "./actions";

/*
 * "New skill" - write a procedure in plain words. No repository, no install
 * command: a name, when the assistant should use it, and the steps. It lands
 * in the same library an import would, pinned and auditable like one.
 */
export function NewSkill() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        New skill
      </Button>
    );
  }

  return (
    <form
      className="flex w-full flex-col gap-3 rounded-xl border border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        start(async () => {
          const result = await createAuthoredSkillAction({ name, description, body });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setOpen(false);
          setName("");
          setDescription("");
          setBody("");
          router.refresh();
        });
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="new-skill-name" className="text-xs font-medium text-muted-foreground">
          Name
        </label>
        <input
          id="new-skill-name"
          required
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Weekly review"
          className="h-9 rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="new-skill-description" className="text-xs font-medium text-muted-foreground">
          When to use it
        </label>
        <input
          id="new-skill-description"
          required
          maxLength={300}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Close the week: what moved, what stalled, what carries into the next one."
          className="h-9 rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="new-skill-body" className="text-xs font-medium text-muted-foreground">
          The procedure
        </label>
        <textarea
          id="new-skill-body"
          required
          rows={8}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={"1. List what finished this week.\n2. List what stalled, with the next action for each.\n3. Choose the three outcomes next week is for."}
          className="field-sizing-content max-h-72 min-h-32 resize-none rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        A skill is a procedure, never authority. Run permissions still decide what the assistant may do.
      </p>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save skill"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
