"use client";

import { Select } from "@/components/ui/select";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/workspace/ui";
import { createRateCardAction, savePolicyAction } from "./actions";

/*
 * The two spending mutation islands. Ceilings submit as strings; an empty
 * field is "no ceiling", which the action stores as null - never zero.
 */

export function PolicyForm({
  policy,
}: {
  policy: {
    dailyCeilingUsd: string | null;
    monthlyCeilingUsd: string | null;
    perRunCeilingUsd: string | null;
    onExceeded: string;
    version: number;
  } | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setError(null);
        setSaved(false);
        startTransition(async () => {
          const result = await savePolicyAction({
            dailyCeilingUsd: String(data.get("dailyCeilingUsd") || ""),
            monthlyCeilingUsd: String(data.get("monthlyCeilingUsd") || ""),
            perRunCeilingUsd: String(data.get("perRunCeilingUsd") || ""),
            onExceeded: String(data.get("onExceeded") || "pause"),
            expectedVersion: policy?.version ?? null,
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setSaved(true);
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Daily ceiling (USD)">
          <Input
            name="dailyCeilingUsd"
            inputMode="decimal"
            placeholder="No ceiling"
            defaultValue={policy?.dailyCeilingUsd ?? ""}
          />
        </Field>
        <Field label="Monthly ceiling (USD)">
          <Input
            name="monthlyCeilingUsd"
            inputMode="decimal"
            placeholder="No ceiling"
            defaultValue={policy?.monthlyCeilingUsd ?? ""}
          />
        </Field>
        <Field label="Per-run ceiling (USD)">
          <Input
            name="perRunCeilingUsd"
            inputMode="decimal"
            placeholder="No ceiling"
            defaultValue={policy?.perRunCeilingUsd ?? ""}
          />
        </Field>
      </div>
      <Field label="At the ceiling">
        <Select name="onExceeded" defaultValue={policy?.onExceeded ?? "pause"} className="border-input bg-background h-9 w-full max-w-xs rounded-md border px-2 text-[13px]" >
          <option value="pause">Pause the agent</option>
          <option value="fail">Fail the run</option>
        </Select>
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : policy ? "Save policy" : "Create policy"}
        </Button>
        {saved ? <p className="text-[13px] text-muted-foreground" role="status">Saved.</p> : null}
        {error ? <p className="text-destructive text-[13px]" role="alert">{error}</p> : null}
      </div>
    </form>
  );
}

export function RateCardForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        setError(null);
        startTransition(async () => {
          const result = await createRateCardAction({
            provider: String(data.get("provider") || ""),
            model: String(data.get("model") || ""),
            inputPerMillion: String(data.get("inputPerMillion") || ""),
            outputPerMillion: String(data.get("outputPerMillion") || ""),
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          form.reset();
        });
      }}
    >
      <Field label="Provider">
        <Input name="provider" required maxLength={100} placeholder="openrouter" />
      </Field>
      <Field label="Exact model ID">
        <Input name="model" required maxLength={200} placeholder="openai/gpt-5-mini" />
      </Field>
      <Field label="Input USD per million tokens">
        <Input name="inputPerMillion" required inputMode="decimal" placeholder="Explicit price" />
      </Field>
      <Field label="Output USD per million tokens">
        <Input name="outputPerMillion" required inputMode="decimal" placeholder="Explicit price" />
      </Field>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Adding…" : "Add rate card"}
        </Button>
        {error ? <p className="text-destructive text-[13px]" role="alert">{error}</p> : null}
      </div>
    </form>
  );
}
