"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { researchDossierCompanyAction } from "./actions";

/*
 * ASH-114: run a dossier-only case study. The report lands as a draft on the
 * artifact rows and opens in the same workbench as a generated draft.
 */
export function ResearchCompanyForm({ dossierId }: { dossierId: string }) {
  const [companyName, setCompanyName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ artifactId: string; title: string; manifestSize: number; gapSections: number } | null>(null);

  async function research() {
    setPending(true);
    setError(null);
    setDone(null);
    try {
      const result = await researchDossierCompanyAction({ dossierId, companyName, idempotencyKey: crypto.randomUUID() });
      if (!result.ok) throw new Error(result.error);
      setDone(result);
      setCompanyName("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The research pass failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={companyName}
          onChange={(event) => setCompanyName(event.target.value)}
          placeholder="Company name, e.g. Acme Corp"
          className="max-w-xs"
        />
        <Button type="button" onClick={research} disabled={pending || !companyName.trim()}>
          {pending ? "Researching…" : "Research"}
        </Button>
      </div>
      {error ? <p role="alert" className="text-destructive text-[13px]">{error}</p> : null}
      {done ? (
        <p className="text-muted-foreground text-[13px]">
          Draft ready from {done.manifestSize} pinned {done.manifestSize === 1 ? "source" : "sources"}
          {done.gapSections > 0 ? ` (${done.gapSections} sections marked as evidence gaps)` : ""}.{" "}
          <a href={`/alfred/dossiers?dossier=${dossierId}&draft=${done.artifactId}`} className="underline underline-offset-2 hover:text-foreground">
            Open the workbench
          </a>
        </p>
      ) : null}
    </div>
  );
}
