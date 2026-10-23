"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { requestJson } from "@/lib/client-request";

/*
 * Create a notebook: a name only. Documents join through the notebook's
 * Sources pane afterward (IA plan 9), so this form sends no document ids; the
 * POST route still accepts them for API callers.
 */
export function CreateDossierForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setPending(true);
    setError(null);
    const result = await requestJson("/api/v1/dossiers", {
      method: "POST",
      body: { name, documentIds: [] },
      idempotencyKey: crypto.randomUUID(),
    });
    setPending(false);
    if (!result.ok) {
      setError(result.failure.title);
      return;
    }
    setName("");
    router.refresh();
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Name the notebook"
        required
        maxLength={200}
        className="border-input bg-background h-9 w-64 rounded-md border px-3 text-sm"
      />
      <Button type="submit" variant="outline" disabled={pending || !name.trim()}>
        {pending ? "Creating…" : "New notebook"}
      </Button>
      {error ? <p className="text-destructive text-[13px]">{error}</p> : null}
    </form>
  );
}
