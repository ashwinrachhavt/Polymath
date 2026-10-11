import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Readout } from "@/components/readout";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Work · Axiom" };

/*
 * One task model, four presentations. The view switcher is present but inert:
 * list, board, and calendar read the same rows, and none of them exist yet.
 * Showing the switch now is honest about the shape; wiring it to nothing is not.
 */
const views = ["Today", "List", "Board", "Calendar"] as const;

export default function WorkPage() {
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
          description="Accepted outcomes first, then ready work, then what is waiting."
        >
          <EmptyState
            title="No tasks yet"
            description="Tasks arrive from capture, from Alfred, or from this screen once creating one is wired."
            action={<Badge variant="outline"><Readout>0 open</Readout></Badge>}
          />
        </Section>

        <Section title="Spaces and projects" description="Spaces group; projects carry an outcome.">
          <div className="grid gap-3 sm:grid-cols-3">
            {["No spaces yet", "No projects yet", "No saved views yet"].map((label) => (
              <div
                key={label}
                className="panel-empty text-muted-foreground rounded-lg px-3 py-4 text-[13px]"
              >
                {label}
              </div>
            ))}
          </div>
        </Section>
      </div>
    </>
  );
}
