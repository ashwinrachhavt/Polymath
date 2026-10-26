import { io } from "next/cache";
import Link from "next/link";
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
export default async function ShutdownPage() {
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
          <Link href="/command-center/briefing">Back to Today</Link>
        </Button>
      }
    >
      <ShutdownForm preview={preview} key={preview.today} />
    </Screen>
  );
}
