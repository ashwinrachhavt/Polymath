import { io } from "next/cache";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getStudyPlan } from "@/domains/learning/study";
import { getAuthContext } from "@/lib/auth";

/*
 * The Study entry on Today: what is due across every source and mission, how
 * long today's session takes, and one click to start it. With nothing due it
 * says what comes back tomorrow instead of a button.
 */
export async function StudyCard() {
  await io();
  const auth = await getAuthContext();
  let plan;
  try {
    plan = await getStudyPlan(auth);
  } catch (error) {
    unstable_rethrow(error);
    console.error("today: the study plan did not load", error);
    return (
      <p role="alert" className="text-body-dense text-muted-foreground">
        Study did not load. Reload the page to try again.
      </p>
    );
  }
  if (plan.dueNow === 0 && plan.items.length === 0) {
    if (plan.tomorrow === 0 && !plan.mission) return null;
    return (
      <section aria-label="Study" className="rounded-xl border border-border px-4 py-3">
        <p className="text-body-dense font-medium">Study</p>
        <p className="text-body-dense text-muted-foreground">
          Nothing is due{plan.tomorrow > 0 ? `. ${plan.tomorrow} come back tomorrow` : ""}.
        </p>
      </section>
    );
  }
  return (
    <section
      aria-label="Study"
      className="flex items-center justify-between gap-4 rounded-xl border border-border px-4 py-3"
    >
      <div className="min-w-0">
        <p className="text-body-dense font-medium">Study</p>
        <p className="text-body-dense text-muted-foreground">
          {plan.dueNow} due · about {plan.minutes} min
          {plan.mission
            ? ` · ${plan.mission.title}: ${plan.mission.daysLeft === 0 ? "today" : `${plan.mission.daysLeft}d left`}`
            : ""}
        </p>
      </div>
      <Button asChild size="sm">
        <Link href="/study" prefetch={false}>
          Start
        </Link>
      </Button>
    </section>
  );
}
