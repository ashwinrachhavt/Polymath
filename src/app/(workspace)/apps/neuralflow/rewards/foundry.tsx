"use client";

import { useRef, useState, useTransition } from "react";
import { Empty } from "@/components/workspace/ui";
import { RecipeStoneArt } from "@/components/products/neuralflow/stone-art";
import type { FoundryProposal } from "@/domains/gamification/queries";
import { Button } from "@/components/ui/button";
import { decideFoundryProposalAction } from "./actions";

/*
 * The Foundry's owner-facing half (spec §7): ML-designed stones awaiting a
 * decision, each rendered from its recipe - the same SVG the schema judged,
 * shipped as a data-URL <img>. Approve applies the recipe (the canonical
 * decide action through LOCAL_WRITERS); reject records the decision. The
 * card keeps its idempotency key for its lifetime, so a retry replays the
 * first decision instead of minting a second one, the way the Reviews
 * queue's cards do.
 */

function ProposalCard({ proposal }: { proposal: FoundryProposal }) {
  const keyRef = useRef<string>(crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [decided, setDecided] = useState(false);

  function decide(decision: "approved" | "rejected") {
    setError(null);
    startTransition(async () => {
      const result = await decideFoundryProposalAction({
        proposalId: proposal.proposalId,
        expectedVersion: proposal.expectedVersion,
        revisionId: proposal.revisionId,
        idempotencyKey: keyRef.current,
        decision,
      });
      if (!result.ok) setError(result.error);
      else setDecided(true);
    });
  }

  if (decided) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {proposal.recipe ? (
          <RecipeStoneArt svg={proposal.recipe.svg} name={proposal.recipe.name} size={48} />
        ) : (
          <span className="nf-vitrine size-12 shrink-0" aria-hidden />
        )}
        <div className="min-w-0">
          <p className="text-[13px] font-medium">
            {proposal.recipe?.name ?? proposal.title}
            {proposal.recipe ? <span className="text-muted-foreground"> · {proposal.recipe.rarity}</span> : null}
          </p>
          <p className="text-xs text-muted-foreground">{proposal.recipe?.theme ?? proposal.expectedEffect}</p>
          {proposal.recipe ? (
            <div className="mt-1 flex items-center gap-1" aria-label="Palette">
              {proposal.recipe.palette.map((color) => (
                <span
                  key={color}
                  className="size-3 rounded-full border border-border"
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
          ) : null}
          {proposal.rejection ? (
            <p className="text-xs text-destructive">
              Malformed recipe ({proposal.rejection}) - reject it and regenerate.
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={() => decide("approved")}>
          {pending ? "Deciding…" : "Approve"}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide("rejected")}>
          Reject
        </Button>
      </div>
      {error ? (
        <span role="alert" className="w-full text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function Foundry({
  proposals,
  stones,
}: {
  proposals: FoundryProposal[];
  stones: Array<{ key: string; label: string; description: string | null; svg: string }>;
}) {
  return (
    <div className="flex flex-col gap-4">
      {proposals.length ? (
        <div className="flex flex-col gap-4">
          {proposals.map((proposal) => (
            <ProposalCard key={proposal.proposalId} proposal={proposal} />
          ))}
        </div>
      ) : (
        <Empty title="No stones awaiting review" />
      )}
      {stones.length ? (
        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <p className="text-xs text-muted-foreground">
            Forged stones - approved designs, ready to drop into a deep session.
          </p>
          <div className="flex flex-wrap gap-4">
            {stones.map((stone) => (
              <div key={stone.key} className="flex items-center gap-2">
                <RecipeStoneArt svg={stone.svg} name={stone.label} size={32} />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">{stone.label}</p>
                  {stone.description ? (
                    <p className="max-w-64 truncate text-xs text-muted-foreground">{stone.description}</p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
