"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { researchCompanyRecordAction } from "./actions";

/*
 * ASH-114: research this company from its record. The report lands as a
 * Studio draft linked to the company and opens in the dossier workbench.
 */
export function ResearchCompanyButton({ companyId }: { companyId: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ artifactId: string; manifestSize: number; gapSections: number } | null>(null);

  async function research() {
    setPending(true);
    setError(null);
    setDone(null);
    try {
      const result = await researchCompanyRecordAction({ companyId, idempotencyKey: crypto.randomUUID() });
      if (!result.ok) throw new Error(result.error);
      setDone(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The research pass failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={research} disabled={pending}>
        {pending ? "Researching…" : "Research"}
      </Button>
      {error ? <span role="alert" className="text-destructive text-xs">{error}</span> : null}
      {done ? (
        <span className="text-muted-foreground text-xs">
          Draft ready from {done.manifestSize} {done.manifestSize === 1 ? "source" : "sources"}
          {done.gapSections > 0 ? ` (${done.gapSections} evidence gaps)` : ""}.{" "}
          <a href={`/polymath/dossiers?draft=${done.artifactId}`} className="underline underline-offset-2 hover:text-foreground">
            Open the workbench
          </a>
        </span>
      ) : null}
    </span>
  );
}
