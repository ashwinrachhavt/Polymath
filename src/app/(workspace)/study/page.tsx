import { connection } from "next/server";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getStudyPlan } from "@/domains/learning/study";
import { getAuthContext } from "@/lib/auth";
import { StudySession } from "./study-session";

export const metadata: Metadata = { title: "Study · Polymath" };

/*
 * One click from Today lands here with the session already chosen: the day's
 * due items from every source and mission, about ten minutes, interleaved.
 */
export default function StudyPage() {
  return (
    <Suspense
      fallback={
        <div role="status" aria-label="Choosing today's session" className="page-content mx-auto max-w-2xl">
          <Skeleton className="h-64 w-full" />
        </div>
      }
    >
      <Session />
    </Suspense>
  );
}

async function Session() {
  await connection();
  const auth = await getAuthContext();
  const plan = await getStudyPlan(auth);
  if (plan.items.length === 0) {
    return (
      <div className="page-content mx-auto flex max-w-2xl flex-col items-center gap-3 py-16 text-center">
        <h1 className="text-xl font-medium">Nothing is due</h1>
        <p className="text-sm text-muted-foreground">
          {plan.tomorrow > 0
            ? `${plan.tomorrow} ${plan.tomorrow === 1 ? "item comes" : "items come"} back tomorrow.`
            : "Items you learn will come back here when it is time to recall them."}
        </p>
        <Button asChild variant="outline">
          <Link href="/today">Back to Today</Link>
        </Button>
      </div>
    );
  }
  return <StudySession items={plan.items} minutes={plan.minutes} mission={plan.mission} />;
}
