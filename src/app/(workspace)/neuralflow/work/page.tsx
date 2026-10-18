import { Section } from "@/components/page-header";
import { PageHeader } from "@/components/page-header";
import { Readout } from "@/components/readout";
import { listOpenTasks } from "@/domains/work/commands";
import { getAuthContext } from "@/lib/auth";
import { OpenTaskList, TaskComposer } from "./work-today";

export const metadata = { title: "Work · Axiom" };

/*
 * One task model, four presentations. The view switcher is present but inert:
 * list, board, and calendar read the same rows, and none of them exist yet.
 * Showing the switch now is honest about the shape; wiring it to nothing is not.
 */
const views = ["Today", "List", "Board", "Calendar"] as const;

/*
 * Today reads the canonical `tasks` table, so the obligation a document
 * review accepted is on this list — same row, no bridge, no sync. The header
 * and this read are server-side; the row interactions are the client island.
 */
export default async function WorkPage() {
  const auth = await getAuthContext();
  const tasks = await listOpenTasks(auth);

  return (
    <>
      <PageHeader
        title="Work"
        purpose="Execute your commitments."
        actions={
          // Disabled buttons, not inert spans: the switcher is not wired yet, and
          // a control that looks operable but is not is worse than one that
          // plainly says so. Each view lands with the data it presents.
          <div className="panel flex items-center gap-0.5 rounded-md p-0.5">
            {views.map((view, index) => (
              <button
                key={view}
                type="button"
                disabled
                title={`${view} view arrives with the data it presents`}
                className={
                  index === 0
                    ? "bg-secondary text-secondary-foreground rounded-md px-2 py-1 text-xs font-medium disabled:opacity-60"
                    : "text-muted-foreground rounded-md px-2 py-1 text-xs disabled:opacity-60"
                }
              >
                {view}
              </button>
            ))}
          </div>
        }
      />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section
          title="Today"
          description="Everything open, soonest due first."
        >
          <TaskComposer />
          <OpenTaskList
            tasks={tasks.map((task) => ({
              id: task.id,
              title: task.title,
              status: task.status,
              dueAt: task.dueAt,
              createdAt: task.createdAt,
            }))}
          />
          <p className="text-muted-foreground mt-3 text-[13px]">
            <Readout>{tasks.length}</Readout> open
          </p>
        </Section>
      </div>
    </>
  );
}
