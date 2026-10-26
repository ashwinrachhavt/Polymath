"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { HomeQueueCard } from "@/domains/home/queue";
import { decideHomeAgentAction, decideHomeCaptureAction } from "./home-actions";

/*
 * The decision card: what it does, why, what it risks, and the one-tap call.
 * Approve/reject run here; edit always happens on the card's own surface,
 * where the full context lives - the homepage never becomes a second editor.
 */

const RISK_LABEL: Record<HomeQueueCard["riskClass"], string> = {
  read: "Read only",
  prepare: "Prepares, sends nothing",
  external_write: "Writes outside",
  sensitive_write: "Sensitive write",
  prohibited: "Prohibited",
};

export function HomeQueue({ cards }: { cards: HomeQueueCard[] }) {
  return (
    <ul className="flex flex-col gap-3" aria-label="Decisions waiting on you">
      {cards.map((card) => (
        <QueueCard key={`${card.origin}:${card.id}`} card={card} />
      ))}
    </ul>
  );
}

function QueueCard({ card }: { card: HomeQueueCard }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const expired = card.decision.kind === "agent" && card.decision.expired;

  async function decide(decision: "approved" | "rejected" | "accepted") {
    setPending(true);
    setError("");
    const result =
      card.decision.kind === "agent"
        ? await decideHomeAgentAction({
            idempotencyKey: crypto.randomUUID(),
            proposalId: card.id,
            expectedVersion: card.decision.version,
            revisionId: card.decision.revisionId,
            decision: decision === "rejected" ? "rejected" : "approved",
          })
        : await decideHomeCaptureAction({ proposalId: card.id, decision: decision === "rejected" ? "rejected" : "accepted" });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    router.refresh();
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{card.origin === "agent" ? "Agent proposal" : "Capture read"}</span>
        <span aria-hidden>·</span>
        <span>{RISK_LABEL[card.riskClass]}</span>
        {card.expiresAt ? (
          <>
            <span aria-hidden>·</span>
            <span>{expired ? "Expired" : `Decide by ${card.expiresAt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`}</span>
          </>
        ) : null}
      </div>
      <p className="text-[14px] font-medium leading-snug">{card.title}</p>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{card.effect}</p>
      {card.reason ? <p className="text-xs text-muted-foreground">{card.reason}</p> : null}
      <div className="mt-1 flex items-center gap-2">
        {expired ? (
          <span className="text-xs text-muted-foreground">This proposal expired; open it to re-propose.</span>
        ) : (
          <>
            <Button type="button" size="sm" disabled={pending} onClick={() => decide("approved")}>
              Approve
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide("rejected")}>
              Reject
            </Button>
          </>
        )}
        <Button asChild size="sm" variant="ghost">
          <Link href={card.href}>Open</Link>
        </Button>
        {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
      </div>
    </li>
  );
}
