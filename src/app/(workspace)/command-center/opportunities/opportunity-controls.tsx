"use client";

import { Select } from "@/components/ui/select";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/workspace/ui";
import { OPPORTUNITY_STAGES, STAGE_LABELS, type OpportunityStage } from "@/domains/opportunities/status";
import {
  addDeadlineAction,
  archiveOpportunityAction,
  changeStageAction,
  markDeadlineMetAction,
} from "./actions";

/*
 * The mutation islands on the pipeline and detail panel. The stage select
 * fires on change; an error keeps the select where it was by keying it to
 * the server-rendered stage (the revalidated render resets it).
 */

function useActionError() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return { error, setError, pending, startTransition };
}

export function StageSelect({
  opportunityId,
  stage,
  version,
}: {
  opportunityId: string;
  stage: OpportunityStage;
  version: number;
}) {
  const { error, setError, pending, startTransition } = useActionError();
  return (
    <span className="inline-flex flex-col gap-1">
      <Select aria-label="Stage" value={stage} disabled={pending} onChange={(event) => {
          const toStage = event.target.value as OpportunityStage;
          setError(null);
          startTransition(async () => {
            const result = await changeStageAction({ opportunityId, expectedVersion: version, toStage });
            if (!result.ok) setError(result.error);
          });
        }}
      >
        {OPPORTUNITY_STAGES.map((value) => (
          <option key={value} value={value}>
            {STAGE_LABELS[value]}
          </option>
        ))}
      </Select>
      {error ? <span className="text-destructive text-[13px]" role="alert">{error}</span> : null}
    </span>
  );
}

export function ArchiveOpportunityButton({
  opportunityId,
  version,
  title,
}: {
  opportunityId: string;
  version: number;
  title: string;
}) {
  const { error, setError, pending, startTransition } = useActionError();
  return (
    <div>
      <Button
        variant="outline"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Archive ${title}? Linked history is kept; the record leaves the pipeline.`)) return;
          setError(null);
          startTransition(async () => {
            const result = await archiveOpportunityAction({ opportunityId, expectedVersion: version });
            if (!result.ok) setError(result.error);
          });
        }}
      >
        {pending ? "Archiving…" : "Archive opportunity"}
      </Button>
      {error ? <p className="text-destructive mt-1 text-[13px]" role="alert">{error}</p> : null}
    </div>
  );
}

export function DeadlineForm({ opportunityId }: { opportunityId: string }) {
  const { error, setError, pending, startTransition } = useActionError();
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_180px_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        setError(null);
        startTransition(async () => {
          const result = await addDeadlineAction({
            opportunityId,
            label: String(data.get("label") || ""),
            dueOn: String(data.get("dueOn") || "") || undefined,
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          form.reset();
        });
      }}
    >
      <Field label="Deadline">
        <Input name="label" required maxLength={200} placeholder="Application closes" />
      </Field>
      <Field label="Due">
        <Input name="dueOn" type="date" />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Adding…" : "Add deadline"}
        </Button>
        {error ? <p className="text-destructive text-[13px]" role="alert">{error}</p> : null}
      </div>
    </form>
  );
}

export function MarkDeadlineMetButton({ deadlineId, version }: { deadlineId: string; version: number }) {
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
            const result = await markDeadlineMetAction({ deadlineId, expectedVersion: version });
            if (!result.ok) setError(result.error);
          });
        }}
      >
        Mark met
      </Button>
      {error ? <span className="text-destructive text-[13px]" role="alert">{error}</span> : null}
    </span>
  );
}
