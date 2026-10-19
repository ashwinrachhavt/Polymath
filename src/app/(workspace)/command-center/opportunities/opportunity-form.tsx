"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/workspace/ui";
import { createOpportunityAction, updateOpportunityAction } from "./actions";

/*
 * One form for create and edit. Company and primary contact are links, not
 * text; the selects post ids, and a cleared select clears the link.
 */

type Option = { id: string; name: string };

type OpportunityDefaults = {
  id: string;
  version: number;
  title: string;
  companyId: string | null;
  primaryContactId: string | null;
  whyItMatters: string | null;
  sourceType: string | null;
  nextCommitment: string | null;
  nextCommitmentOn: string | null;
};

export function OpportunityForm({
  companies,
  contacts,
  opportunity,
  onSaved,
}: {
  companies: Option[];
  contacts: Option[];
  opportunity?: OpportunityDefaults;
  onSaved?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError(null);
    const payload = {
      title: String(data.get("title") || ""),
      companyId: String(data.get("companyId") || "") || null,
      primaryContactId: String(data.get("primaryContactId") || "") || null,
      whyItMatters: String(data.get("whyItMatters") || ""),
      sourceType: String(data.get("sourceType") || ""),
      nextCommitment: String(data.get("nextCommitment") || ""),
      nextCommitmentOn: String(data.get("nextCommitmentOn") || "") || undefined,
    };
    startTransition(async () => {
      const result = opportunity
        ? await updateOpportunityAction({
            opportunityId: opportunity.id,
            expectedVersion: opportunity.version,
            ...payload,
          })
        : await createOpportunityAction(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!opportunity) event.currentTarget.reset();
      onSaved?.();
    });
  }

  return (
    <form className="grid gap-3" onSubmit={onSubmit}>
      <Field label="Title">
        <Input name="title" required maxLength={300} defaultValue={opportunity?.title} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Company">
          <select
            name="companyId"
            defaultValue={opportunity?.companyId ?? ""}
            className="border-input bg-background h-9 rounded-md border px-2 text-[13px]"
          >
            <option value="">No company</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Primary contact">
          <select
            name="primaryContactId"
            defaultValue={opportunity?.primaryContactId ?? ""}
            className="border-input bg-background h-9 rounded-md border px-2 text-[13px]"
          >
            <option value="">No contact</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Source">
          <Input
            name="sourceType"
            maxLength={100}
            placeholder="referral, job board, capture…"
            defaultValue={opportunity?.sourceType ?? ""}
          />
        </Field>
        <Field label="Next commitment due">
          <Input name="nextCommitmentOn" type="date" defaultValue={opportunity?.nextCommitmentOn ?? ""} />
        </Field>
      </div>
      <Field label="Next commitment">
        <Input
          name="nextCommitment"
          maxLength={500}
          placeholder="The single next move"
          defaultValue={opportunity?.nextCommitment ?? ""}
        />
      </Field>
      <Field label="Why it matters">
        <Textarea
          name="whyItMatters"
          maxLength={5000}
          defaultValue={opportunity?.whyItMatters ?? ""}
          placeholder="Why this is worth pursuing, stated before the decision."
        />
      </Field>
      {error ? (
        <p className="text-destructive text-[13px]" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : opportunity ? "Save opportunity" : "Create opportunity"}
      </Button>
    </form>
  );
}
