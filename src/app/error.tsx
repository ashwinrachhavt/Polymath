"use client";

import { Button } from "@/components/ui/button";

/*
 * Boundary behaviour is explicit (agents/engineering.md): a failure states what
 * happened and offers the way out. It never apologises, and it never renders an
 * empty screen that looks like success.
 *
 * `error.digest` is the only handle that ties this screen to the server log, so
 * it is shown rather than swallowed.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-3 p-6">
      <h1 className="text-lg font-medium tracking-tight">This screen did not load</h1>
      <p className="text-muted-foreground max-w-prose text-sm">
        Something failed on the server. Nothing was saved, and no action was taken on your
        behalf.
      </p>
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={reset}>
          Try again
        </Button>
        {error.digest ? (
          <span className="text-muted-foreground font-mono text-xs">{error.digest}</span>
        ) : null}
      </div>
    </main>
  );
}
