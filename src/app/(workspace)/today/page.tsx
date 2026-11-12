import { io } from "next/cache";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import { Suspense } from "react";
import { NotebookText } from "lucide-react";
import { IconButton } from "@/components/ui/icon-button";
import { Screen } from "@/components/workspace/ui";
import { getDayPage, todayIn } from "@/domains/daybook/queries";
import { getAuthContext } from "@/lib/auth";
import { CloseTheDay } from "../command-center/day/[date]/close-the-day";
import { FocusTimer } from "../neuralflow/focus/focus-timer";
import { listWorkRowsForPage } from "../neuralflow/work/data";
import { TaskSection } from "../neuralflow/work/neon-tasks";

export const metadata = { title: "Today · Polymath" };

/*
 * Today (spec §2): the plan and the tasks, a focus timer, then Shut down as
 * the day's last step, on one screen. It composes the Work list, the focus
 * timer and the day page's close panel, whose button opens Shut down. Each
 * keeps its own reads and server actions; an action's revalidation re-renders
 * this page in the same response.
 *
 * Only the task list reads the URL (scope, filters, pager, selected task), so
 * each section streams in its own Suspense boundary and the timer never waits
 * on the list. The old screens keep their routes; only the rail moved here.
 */

type TodayQuery = Promise<Record<string, string | string[] | undefined>>;

async function TodayTasks({ searchParams }: { searchParams: TodayQuery }) {
  const query = await searchParams;
  return (
    <TaskSection
      basePath="/today"
      show={typeof query.show === "string" ? query.show : "today"}
      selectedTask={typeof query.task === "string" ? query.task : undefined}
      raw={query}
    />
  );
}

async function TodayClose() {
  // Per-user data: render at request time, never prerender.
  await io();
  const auth = await getAuthContext();
  let counts: { captures: number; committed: number; sessions: number };
  try {
    const [day, plan] = await Promise.all([
      todayIn(auth).then((date) => getDayPage(auth, date)),
      listWorkRowsForPage(auth, "today"),
    ]);
    counts = { captures: day.captured.length, committed: plan.length, sessions: day.sessions.length };
  } catch (error) {
    unstable_rethrow(error);
    console.error("today: the day's counts did not load", error);
    return (
      <p role="alert" className="text-body-dense text-muted-foreground">
        The day&apos;s counts did not load. Reload the page to try again, or{" "}
        <Link href="/command-center/shutdown" className="underline underline-offset-4">
          go to Shut down
        </Link>
        .
      </p>
    );
  }
  return <CloseTheDay {...counts} />;
}

function Loading({ label }: { label: string }) {
  return (
    <p role="status" className="text-body-dense text-muted-foreground">
      {label}
    </p>
  );
}

export default function TodayPage({ searchParams }: { searchParams: TodayQuery }) {
  return (
    <Screen
      title="Today"
      actions={
        <IconButton
          href="/command-center/day"
          label="Today's record"
          icon={<NotebookText aria-hidden className="size-4" />}
        />
      }
    >
      <Suspense fallback={<Loading label="Loading your tasks…" />}>
        <TodayTasks searchParams={searchParams} />
      </Suspense>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <Suspense fallback={<Loading label="Loading focus…" />}>
            <FocusTimer />
          </Suspense>
        </div>
        <div className="min-w-0">
          <Suspense fallback={<Loading label="Loading the day…" />}>
            <TodayClose />
          </Suspense>
        </div>
      </div>
    </Screen>
  );
}
