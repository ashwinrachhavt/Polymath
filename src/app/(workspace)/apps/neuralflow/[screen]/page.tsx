import { Suspense } from "react";
import { notFound } from "next/navigation";

const screens = ["dashboard", "tasks", "boards", "calendar", "scheduler", "focus", "projects", "notes", "meetings", "brain-dump", "reports", "rewards"];

/*
 * The screen is validated outside the boundary so an unknown one still 404s
 * rather than rendering inside the fallback. Only the query string suspends,
 * which is what keeps navigation to a known screen instant.
 */
export default async function NeuralFlowScreen({ params, searchParams }: { params: Promise<{ screen: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { screen } = await params;
  if (!screens.includes(screen)) notFound();
  return <Suspense fallback={<p role="status" className="p-6 text-[13px] text-muted-foreground">Opening screen…</p>}><SelectedScreen screen={screen} searchParams={searchParams}/></Suspense>;
}

async function SelectedScreen({ screen, searchParams }: { screen: string; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const task = typeof query.task === "string" ? query.task : undefined;
  const note = typeof query.note === "string" ? query.note : undefined;
  const date = typeof query.date === "string" ? query.date : undefined;
  switch (screen) {
    case "dashboard": {
      const { Dashboard } = await import("@/components/products/neuralflow/work-screens");
      return <Dashboard />;
    }
    case "tasks": {
      const { TasksScreen } = await import("@/components/products/neuralflow/work-screens");
      return <TasksScreen selectedTask={task} />;
    }
    case "boards": {
      const { BoardsScreen } = await import("@/components/products/neuralflow/work-screens");
      return <BoardsScreen />;
    }
    case "calendar": {
      const { CalendarScreen } = await import("@/components/products/neuralflow/calendar-screens");
      return <CalendarScreen key={date || "current"} initialDate={date} />;
    }
    case "scheduler": {
      const { SchedulerScreen } = await import("@/components/products/neuralflow/calendar-screens");
      return <SchedulerScreen />;
    }
    case "focus": {
      const { FocusScreen } = await import("@/components/products/neuralflow/focus-screen");
      return <FocusScreen key={task || "active"} initialTask={task} />;
    }
    case "projects": {
      const { ProjectsScreen } = await import("@/components/products/neuralflow/workspace-screens");
      return <ProjectsScreen />;
    }
    case "notes": {
      const { NotesScreen } = await import("@/components/products/neuralflow/workspace-screens");
      return <NotesScreen initialNote={note} />;
    }
    case "meetings": {
      const { MeetingsScreen } = await import("@/components/products/neuralflow/reflection-screens");
      return <MeetingsScreen />;
    }
    case "brain-dump": {
      const { BrainDumpScreen } = await import("@/components/products/neuralflow/reflection-screens");
      return <BrainDumpScreen />;
    }
    case "reports": {
      const { ReportsScreen } = await import("@/components/products/neuralflow/reflection-screens");
      return <ReportsScreen />;
    }
    case "rewards": {
      const { RewardsScreen } = await import("@/components/products/neuralflow/reflection-screens");
      return <RewardsScreen />;
    }
  }
}
