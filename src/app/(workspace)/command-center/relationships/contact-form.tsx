"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/workspace/ui";
import { RELATIONSHIP_STATUS_LABELS, RELATIONSHIP_STATUSES, type RelationshipStatus } from "@/domains/crm/status";
import { createContactAction, updateContactAction } from "./actions";

/*
 * One form for create and edit. Company is a link, not text: the select lists
 * canonical companies and posts the id. On edit, `companyId` is always sent
 * (undefined would mean "leave the link alone"), so a cleared select is how
 * the owner ends a current company link.
 */

type CompanyOption = { id: string; name: string };

type ContactDefaults = {
  id: string;
  version: number;
  fullName: string;
  primaryEmail: string | null;
  phone: string | null;
  title: string | null;
  location: string | null;
  relationshipStatus: RelationshipStatus;
  notes: string | null;
  currentCompanyId: string | null;
};

export function ContactForm({
  companies,
  contact,
  onSaved,
}: {
  companies: CompanyOption[];
  contact?: ContactDefaults;
  onSaved?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError(null);
    const companyRaw = String(data.get("companyId") || "");
    const payload = {
      fullName: String(data.get("fullName") || ""),
      primaryEmail: String(data.get("primaryEmail") || ""),
      phone: String(data.get("phone") || ""),
      title: String(data.get("title") || ""),
      location: String(data.get("location") || ""),
      relationshipStatus: (String(data.get("relationshipStatus")) ||
        "unknown") as RelationshipStatus,
      notes: String(data.get("notes") || ""),
      companyId: companyRaw || null,
    };
    startTransition(async () => {
      const result = contact
        ? await updateContactAction({
            contactId: contact.id,
            expectedVersion: contact.version,
            ...payload,
          })
        : await createContactAction(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (!contact) event.currentTarget.reset();
      onSaved?.();
    });
  }

  return (
    <form className="grid gap-3" onSubmit={onSubmit}>
      <Field label="Name">
        <Input name="fullName" required maxLength={300} defaultValue={contact?.fullName} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Email">
          <Input name="primaryEmail" type="email" maxLength={320} defaultValue={contact?.primaryEmail ?? ""} />
        </Field>
        <Field label="Phone">
          <Input name="phone" maxLength={40} defaultValue={contact?.phone ?? ""} />
        </Field>
        <Field label="Title">
          <Input name="title" maxLength={200} defaultValue={contact?.title ?? ""} />
        </Field>
        <Field label="Location">
          <Input name="location" maxLength={200} defaultValue={contact?.location ?? ""} />
        </Field>
        <Field label="Company">
          <select
            name="companyId"
            defaultValue={contact?.currentCompanyId ?? ""}
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
        <Field label="Relationship status">
          <select
            name="relationshipStatus"
            defaultValue={contact?.relationshipStatus ?? "unknown"}
            className="border-input bg-background h-9 rounded-md border px-2 text-[13px]"
          >
            {RELATIONSHIP_STATUSES.map((status) => (
              <option key={status} value={status}>
                {RELATIONSHIP_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Notes">
        <Textarea
          name="notes"
          maxLength={10_000}
          defaultValue={contact?.notes ?? ""}
          placeholder="Record observations and their sources; do not infer verified facts."
        />
      </Field>
      {error ? (
        <p className="text-destructive text-[13px]" role="alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : contact ? "Save contact" : "Create contact"}
      </Button>
    </form>
  );
}
