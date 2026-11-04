"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { acceptInvitationAction } from "./actions";

/*
 * The one interactive element of the acceptance page. Success is a state
 * change plus a router refresh - the new membership changes what the shell
 * and every cache tag see - and the follow-on navigation is the person's
 * own click, not a forced redirect.
 */
export function AcceptButton({ token }: { token: string }) {
  const router = useRouter();
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (accepted) {
    return (
      <div className="mt-4 flex items-center gap-3" role="status" data-testid="accept-success">
        <p className="text-body-dense font-medium">You are in.</p>
        <Button
          variant="outline"
          onClick={() => {
            router.push("/");
          }}
        >
          Go to the workspace
        </Button>
      </div>
    );
  }

  return (
    <form
      className="mt-4"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await acceptInvitationAction(token);
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setAccepted(true);
          router.refresh();
        });
      }}
    >
      <Button type="submit" disabled={pending}>
        {pending ? "Joining…" : "Accept invitation"}
      </Button>
      {error ? (
        <p className="mt-2 text-destructive text-body-dense" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
