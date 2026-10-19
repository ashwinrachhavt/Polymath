"use client";

import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/workspace/ui";
import { createDefinitionAction } from "./actions";

/** Catalog entry form. Defines what a reward IS; nothing here awards one. */
export function DefinitionForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      ref={formRef}
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setError(null);
        startTransition(async () => {
          const result = await createDefinitionAction({
            key: String(data.get("key") || "").trim(),
            kind: String(data.get("kind") || "points") as "points" | "streak_day" | "badge" | "collectible",
            label: String(data.get("label") || "").trim(),
            description: String(data.get("description") || "").trim(),
            points: Number.parseInt(String(data.get("points") || "0"), 10) || 0,
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          formRef.current?.reset();
        });
      }}
    >
      <Field label="Key">
        <Input name="key" required maxLength={60} placeholder="quartz" />
      </Field>
      <Field label="Label">
        <Input name="label" required maxLength={120} placeholder="Quartz" />
      </Field>
      <Field label="Kind">
        <Select
          name="kind"
          defaultValue="points"
         
        >
          <option value="points">points</option>
          <option value="streak_day">streak day</option>
          <option value="badge">badge</option>
          <option value="collectible">collectible</option>
        </Select>
      </Field>
      <Field label="Points">
        <Input name="points" inputMode="numeric" placeholder="10" />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Description">
          <Input name="description" maxLength={300} placeholder="What earns it, once its rule is switched on." />
        </Field>
      </div>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Define reward"}
        </Button>
        {error ? <p className="text-destructive text-[13px]" role="alert">{error}</p> : null}
      </div>
    </form>
  );
}
