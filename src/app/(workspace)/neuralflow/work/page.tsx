import { Suspense } from "react";
import { workView } from "@/components/products/neuralflow/work-views";
import { NeonTasks } from "./neon-tasks";
import { NeuralFlowFeatureLinks, WorkViewLinks } from "./work-today";

export const metadata = { title: "Work · Axiom" };

type WorkQuery = Promise<Record<string, string | string[] | undefined>>;

async function WorkSurface({ searchParams }: { searchParams: WorkQuery }) {
  const query = await searchParams;
  const view = workView(query.view);
  const task = typeof query.task === "string" ? query.task : undefined;
  const date = typeof query.date === "string" ? query.date : undefined;
  let surface;

  if (view === "board") {
    const { BoardsScreen } = await import("@/components/products/neuralflow/work-screens");
    surface = <BoardsScreen title="Work" />;
  } else if (view === "calendar") {
    const { CalendarScreen } = await import("@/components/products/neuralflow/calendar-screens");
    surface = <CalendarScreen key={date || "current"} title="Work" initialDate={date} />;
  } else if (view === "saved") {
    const show = typeof query.show === "string" ? query.show : undefined;
    surface = <NeonTasks show={show} selectedTask={task} />;
  } else {
    const { TasksScreen } = await import("@/components/products/neuralflow/work-screens");
    surface = <TasksScreen key={view} title="Work" view={view} selectedTask={task} />;
  }
  const saved = view === "saved";

  return (
    <>
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 md:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <WorkViewLinks active={view} />
          <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">{saved ? "Saved to your workspace." : "Browser-only preview. Sample records and edits stay in this browser, not Neon; no production persistence or provider sync."}</p>
        </div>
        <NeuralFlowFeatureLinks />
      </div>
      {surface}
    </>
  );
}

export default function WorkPage({ searchParams }: { searchParams: WorkQuery }) {
  return <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening Work…</p>}><WorkSurface searchParams={searchParams} /></Suspense>;
}
