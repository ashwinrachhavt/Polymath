"use client";

import { Button } from "@/components/ui/button";

/*
 * Workspace-wide error boundary. apps/alfred and apps/command-center keep
 * their more specific boundaries; this one catches every other destination so
 * a broken screen never falls through to the root error and loses the shell.
 */
export default function WorkspaceError({ reset }: { reset: () => void }) {
  return (
    <div role="alert" className="flex flex-1 flex-col justify-center p-6">
      <h1 className="text-lg font-medium">This screen could not open</h1>
      <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
        Reload the screen to try again. Browser-only preview changes stay in this browser.
      </p>
      <Button onClick={reset} variant="outline" className="mt-4 w-fit">
        Retry
      </Button>
    </div>
  );
}
