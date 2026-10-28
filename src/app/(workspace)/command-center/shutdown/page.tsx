import { io } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Screen } from "@/components/workspace/ui";
import { previewShutdown } from "@/domains/daybook/shutdown";
import { getAuthContext } from "@/lib/auth";
import { ShutdownForm } from "./shutdown-form";

export const metadata = { title: "Shut down · Polymath" };

/*
 * The end-of-day ritual (ASH-305): read what is still open, choose, confirm
 * once. A child of Today with no rail entry, like the day page.
 */
async function ShutdownSurface() {
  await io();
  const auth = await getAuthContext();
  const preview = await previewShutdown(auth);
  // Key on the DAY only: the apply's own action response refreshes this route,
  // and keying on the live session's version remounts the form the moment the
  // apply finishes that session - discarding the confirmation it just showed
  // (ASH-323). Stale choices stay guarded server-side by expectedVersion.
  return (
    <Screen
      title="Shut down"
      description="Close the day on purpose. Nothing changes until you confirm. Parking is reversible and the summary email is only a proposal - finishing or abandoning a session is final."
      actions={
        <Button variant="outline" size="sm" asChild>
          <Link href="/command-center/inbox">Back to Inbox</Link>
        </Button>
      }
    >
      <ShutdownForm preview={preview} key={preview.today} />
    </Screen>
  );
}

/*
 * `io()` must sit inside a Suspense boundary under cacheComponents, or every
 * navigation here is treated as blocked on uncached data.
 */
export default function ShutdownPage() {
  return (
    <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Loading…</p>}>
      <ShutdownSurface />
    </Suspense>
  );
}
