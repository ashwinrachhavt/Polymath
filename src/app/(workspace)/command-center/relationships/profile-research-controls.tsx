"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ContactResearchFocus } from "@/domains/knowledge/profile-research";
import { researchCompanyProfileAction, researchContactProfileAction } from "./actions";

/*
 * The research controls embedded on the company and person profiles
 * (ASH-291). One click runs the bounded pass; the page revalidates and the
 * card set renders under the controls. The error line is its own row so a
 * long message never squeezes the buttons out of a narrow viewport, and it
 * stays visible in every state - a failed refresh is never silent.
 */

type Done = { cardCount: number; gaps: number; manifestSize: number } | null;

function doneText(done: Done): string | null {
  if (!done) return null;
  if (done.cardCount === 0) return "No grounded cards - see the gap note below.";
  return `${done.cardCount} ${done.cardCount === 1 ? "card" : "cards"} from ${done.manifestSize} ${done.manifestSize === 1 ? "source" : "sources"}${done.gaps > 0 ? ` (${done.gaps} dropped ungrounded)` : ""}.`;
}

export function CompanyResearchControls({ companyId, researched }: { companyId: string; researched: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done>(null);

  async function research() {
    setPending(true);
    setError(null);
    try {
      const result = await researchCompanyProfileAction({ companyId, idempotencyKey: crypto.randomUUID() });
      if (!result.ok) setError(result.error);
      else setDone(result);
    } catch {
      setError("The research pass failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={research} disabled={pending}>
          {pending ? "Researching…" : researched ? "Research again" : "Research company"}
        </Button>
        {done ? <span className="text-xs text-muted-foreground">{doneText(done)}</span> : null}
      </span>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}

const FOCI: Array<{ value: ContactResearchFocus | undefined; label: string; pendingLabel: string }> = [
  { value: undefined, label: "Research person", pendingLabel: "Researching…" },
  { value: "background", label: "Background", pendingLabel: "Researching…" },
  { value: "mentions", label: "Recent mentions", pendingLabel: "Researching…" },
  { value: "talking-points", label: "Talking points", pendingLabel: "Researching…" },
];

export function ContactResearchControls({ contactId, researched }: { contactId: string; researched: boolean }) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done>(null);

  async function research(focus: ContactResearchFocus | undefined, key: string) {
    setPending(key);
    setError(null);
    try {
      const result = await researchContactProfileAction({ contactId, focus, idempotencyKey: crypto.randomUUID() });
      if (!result.ok) setError(result.error);
      else setDone(result);
    } catch {
      setError("The research pass failed.");
    } finally {
      setPending(null);
    }
  }

  return (
    <span className="flex flex-col gap-1">
      <span className="flex flex-wrap items-center gap-2">
        {FOCI.map((f, i) => (
          <Button
            key={f.value ?? "profile"}
            type="button"
            variant={i === 0 ? "outline" : "ghost"}
            size="sm"
            disabled={pending !== null}
            onClick={() => research(f.value, f.value ?? "profile")}
          >
            {pending === (f.value ?? "profile") ? f.pendingLabel : i === 0 && researched ? "Research again" : f.label}
          </Button>
        ))}
        {done ? <span className="text-xs text-muted-foreground">{doneText(done)}</span> : null}
      </span>
      {error ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
