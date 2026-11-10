import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/workspace/ui";

/*
 * The way into Shut down: what is still open on the day, then the ritual.
 * The day page renders it beside its record, and Today renders it as its
 * last section.
 */
export function CloseTheDay({
  captures,
  committed,
  sessions,
}: {
  captures: number;
  committed: number;
  sessions: number;
}) {
  return (
    <Panel title="Close the day" description="The ritual reads this record, then seeds tomorrow.">
      <dl className="space-y-2 text-body-dense">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Captures still to clarify</dt>
          <dd className="tabular-nums">{captures}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Committed tasks</dt>
          <dd className="tabular-nums">{committed}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Sessions today</dt>
          <dd className="tabular-nums">{sessions}</dd>
        </div>
      </dl>
      <div className="mt-4">
        <Button asChild className="w-full">
          <Link href="/command-center/shutdown">Close the day</Link>
        </Button>
      </div>
    </Panel>
  );
}
