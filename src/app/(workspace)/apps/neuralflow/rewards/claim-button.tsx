"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { claimShardAction } from "./actions";

/* The explicit shard claim (A10): five stones fuse into one, by hand only. */
export function ClaimShardButton({ claimable }: { claimable: number }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        disabled={pending || claimable < 1}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await claimShardAction();
            if (!result.ok) setError(result.error);
          });
        }}
      >
        {pending ? "Claiming…" : claimable > 0 ? `Claim shard (${claimable} ready)` : "Claim shard"}
      </Button>
      {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
    </span>
  );
}
