import { Suspense } from "react";
import { workView } from "@/components/products/neuralflow/work-views";
import { NeonBoard } from "./neon-board";
import { NeonCalendar } from "./neon-calendar";
import { NeonTasks } from "./neon-tasks";
import { FeatureLinks, WorkViewLinks } from "./work-today";

export const metadata = { title: "Work · Polymath" };

type WorkQuery = Promise<Record<string, string | string[] | undefined>>;

async function WorkSurface({ searchParams }: { searchParams: WorkQuery }) {
  const query = await searchParams;
  const view = workView(query.view);
  const task = typeof query.task === "string" ? query.task : undefined;
  const date = typeof query.date === "string" ? query.date : undefined;
  let surface;

  // Every Work view reads the same canonical Neon tasks. The browser-only
  // preview survives only on the standalone /apps/neuralflow route.
  if (view === "board") {
    surface = <NeonBoard raw={query} />;
  } else if (view === "calendar") {
    surface = <NeonCalendar key={date || "current"} date={date} />;
  } else {
    const show = typeof query.show === "string" ? query.show : undefined;
    surface = <NeonTasks show={view === "today" ? "today" : show} selectedTask={task} raw={query} />;
  }

  return (
    <>
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <WorkViewLinks active={view} />
          <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">Saved to your workspace.</p>
        </div>
        <FeatureLinks />
      </div>
      {surface}
    </>
  );
}

export default function WorkPage({ searchParams }: { searchParams: WorkQuery }) {
  return <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening Work…</p>}><WorkSurface searchParams={searchParams} /></Suspense>;
}
