"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/workspace/ui";
import {
  addObservationAction,
  archiveContactAction,
  createFollowUpAction,
  resolveFollowUpAction,
} from "./actions";

/*
 * The small mutation islands on the contact detail panel. Each posts one
 * server action and lets the revalidated server render show the result; an
 * error stays on the control that produced it.
 */

function useActionError() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return { error, setError, pending, startTransition };
}

export function ArchiveContactButton({
  contactId,
  version,
  name,
}: {
  contactId: string;
  version: number;
  name: string;
}) {
  const { error, setError, pending, startTransition } = useActionError();
  return (
    <div>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Archive ${name}? Linked history is kept; the record leaves the list.`)) return;
          setError(null);
          startTransition(async () => {
            const result = await archiveContactAction({ contactId, expectedVersion: version });
            if (!result.ok) setError(result.error);
          });
        }}
      >
        {pending ? "Archiving…" : "Archive contact"}
      </Button>
      {error ? <p className="text-destructive mt-1 text-[13px]" role="alert">{error}</p> : null}
    </div>
  );
}

export function ObservationForm({ contactId }: { contactId: string }) {
  const { error, setError, pending, startTransition } = useActionError();
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        setError(null);
        startTransition(async () => {
          const result = await addObservationAction({
            contactId,
            body: String(data.get("body") || ""),
            source: String(data.get("source") || "stated") as "stated" | "document" | "observed",
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          form.reset();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <Field label="Observation">
          <Textarea name="body" required maxLength={5000} placeholder="What was seen or said, and where it came from." />
        </Field>
        <Field label="Source">
          <select name="source" defaultValue="stated" className="border-input bg-background h-9 rounded-md border px-2 text-[13px]">
            <option value="stated">Stated</option>
            <option value="observed">Observed</option>
            <option value="document">Document</option>
          </select>
        </Field>
      </div>
      {error ? <p className="text-destructive text-[13px]" role="alert">{error}</p> : null}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Adding…" : "Add observation"}
      </Button>
    </form>
  );
}

export function FollowUpForm({ contactId }: { contactId: string }) {
  const { error, setError, pending, startTransition } = useActionError();
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        setError(null);
        startTransition(async () => {
          const result = await createFollowUpAction({
            contactId,
            dueAt: String(data.get("dueAt") || "") || undefined,
            note: String(data.get("note") || "") || undefined,
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          form.reset();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
        <Field label="Due date">
          <Input name="dueAt" type="date" />
        </Field>
        <Field label="Note">
          <Input name="note" maxLength={2000} placeholder="What to follow up about" />
        </Field>
      </div>
      {error ? <p className="text-destructive text-[13px]" role="alert">{error}</p> : null}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Adding…" : "Add follow-up"}
      </Button>
    </form>
  );
}

export function ResolveFollowUpButton({
  followUpId,
  version,
  resolution,
}: {
  followUpId: string;
  version: number;
  resolution: "done" | "cancelled";
}) {
  const { error, setError, pending, startTransition } = useActionError();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await resolveFollowUpAction({ followUpId, expectedVersion: version, resolution });
            if (!result.ok) setError(result.error);
          });
        }}
      >
        {resolution === "done" ? "Mark done" : "Cancel"}
      </Button>
      {error ? <span className="text-destructive text-[13px]" role="alert">{error}</span> : null}
    </span>
  );
}

/* C03 correspondence islands: compose a draft, gate its send, cancel it. */
import { cancelCorrespondenceAction, draftCorrespondenceAction, requestSendApprovalAction } from "./actions";

export function CorrespondenceForm({ contactId }: { contactId: string }) {
  const { error, setError, pending, startTransition } = useActionError();
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setError(null);
        startTransition(async () => {
          const result = await draftCorrespondenceAction({
            contactId,
            subject: String(data.get("subject") || ""),
            body: String(data.get("body") || ""),
          });
          if (result.ok) {
            event.currentTarget.reset();
          } else {
            setError(result.error);
          }
        });
      }}
    >
      <Field label="Subject">
        <Input name="subject" placeholder="Thursday works" />
      </Field>
      <Field label="Draft">
        <Textarea name="body" required rows={3} placeholder="What you'd send, once you approve the send in Reviews." />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>Save draft</Button>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      </div>
    </form>
  );
}

export function RequestSendApprovalButton({
  correspondenceId,
  version,
  hasProposal,
}: {
  correspondenceId: string;
  version: number;
  hasProposal: boolean;
}) {
  const { error, setError, pending, startTransition } = useActionError();
  if (hasProposal) return <span className="text-xs text-muted-foreground">Approval requested - open Reviews to decide.</span>;
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await requestSendApprovalAction({ correspondenceId, expectedVersion: version });
            if (!result.ok) setError(result.error);
          });
        }}
      >
        Request send approval
      </Button>
      {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}

export function CancelCorrespondenceButton({ correspondenceId, version }: { correspondenceId: string; version: number }) {
  const { error, setError, pending, startTransition } = useActionError();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await cancelCorrespondenceAction({ correspondenceId, expectedVersion: version });
            if (!result.ok) setError(result.error);
          });
        }}
      >
        Cancel draft
      </Button>
      {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
