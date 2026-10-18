"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/workspace/ui";
import { createCompanyAction } from "./actions";

export function CompanyForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        setError(null);
        startTransition(async () => {
          const result = await createCompanyAction({
            name: String(data.get("name") || ""),
            domain: String(data.get("domain") || "") || undefined,
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          form.reset();
        });
      }}
    >
      <Field label="Company name">
        <Input name="name" required maxLength={300} />
      </Field>
      <Field label="Domain">
        <Input name="domain" maxLength={253} placeholder="example.com" />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? "Adding…" : "Add company"}
        </Button>
        {error ? <p className="text-destructive text-[13px]" role="alert">{error}</p> : null}
      </div>
    </form>
  );
}
