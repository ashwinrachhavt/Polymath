"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { revokeInvitationAction } from "../actions";

/*
 * One pending row, one revoke. Revoking is quiet on purpose: the console's
 * list refreshes through the action's revalidatePath, and a dead invitation
 * answers the same "not valid" as any other dead token at accept time.
 */
export function RevokeInvitation({ invitationId }: { invitationId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="flex items-center gap-2">
      {error ? (
        <span className="text-destructive text-xs" role="alert">
          {error}
        </span>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await revokeInvitationAction(invitationId);
            if (!result.ok) setError(result.error);
          });
        }}
      >
        {pending ? "Revoking…" : "Revoke"}
      </Button>
    </span>
  );
}
