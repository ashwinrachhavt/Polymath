import { Suspense } from "react";
import { workView } from "@/components/products/neuralflow/work-views";
import { NeonBoard } from "./neon-board";
import { NeonCalendar } from "./neon-calendar";
import { NeonTasks } from "./neon-tasks";
import { WorkViewLinks } from "./work-today";

export const metadata = { title: "Work · Polymath" };

type WorkQuery = Promise<Record<string, string | string[] | undefined>>;

async function WorkSurface({ searchParams }: { searchParams: WorkQuery }) {
  const query = await searchParams;
  const view = workView(query.view);
  const task = typeof query.task === "string" ? query.task : undefined;
  const date = typeof query.date === "string" ? query.date : undefined;
  const show = typeof query.show === "string" ? query.show : undefined;

  // Today / Open / Finished are a scope over the same rows, carried in `show`
  // and valid on any list presentation. The destination tab is derived from
  // the effective scope, not from `view`, so "Finished" still reads as List.
  const listed = view !== "board" && view !== "calendar";
  const scope = show === "today" ? "today" : show === "done" ? "done" : view === "today" ? "today" : "open";
  const destination = listed && scope === "today" ? "today" : "list";
  const presentation = listed ? "saved" : view;

  let surface;
  if (view === "board") {
    surface = <NeonBoard raw={query} />;
  } else if (view === "calendar") {
    surface = <NeonCalendar key={date || "current"} date={date} />;
  } else {
    surface = <NeonTasks show={show ?? (view === "today" ? "today" : undefined)} selectedTask={task} raw={query} />;
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3 md:px-6">
        <WorkViewLinks active={destination} presentation={presentation} />
      </div>
      {surface}
    </>
  );
}

export default function WorkPage({ searchParams }: { searchParams: WorkQuery }) {
  return <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening Work…</p>}><WorkSurface searchParams={searchParams} /></Suspense>;
}
