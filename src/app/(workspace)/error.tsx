"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/*
 * Workspace-wide error boundary. apps/polymath and apps/command-center keep
 * their more specific boundaries; this one catches every other destination so
 * a broken screen never falls through to the root error and loses the shell.
 */
export default function WorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // The boundary is where a render crash becomes visible; log the real error
  // here or it is swallowed behind the generic copy (ASH-163).
  useEffect(() => {
    console.error("Workspace screen failed", error);
  }, [error]);
  return (
    <div role="alert" className="flex flex-1 flex-col justify-center p-6">
      <h1 className="text-lg font-medium">This screen could not open</h1>
      <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
        Reload the screen to try again. Browser-only preview changes stay in this browser.
      </p>
      <Button onClick={reset} variant="outline" className="mt-4 w-fit">
        Retry
      </Button>
      {error.digest ? (
        <span className="mt-3 font-mono text-xs text-muted-foreground">{error.digest}</span>
      ) : null}
    </div>
  );
}
