import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Focus · Axiom" };

/*
 * Focus is a durable session, not a client timer: the clock lives in the
 * database so a refresh or a second tab resumes the same session rather than
 * starting a rival one. The lifecycle is shown even while the controls are
 * inert, because the states are the contract.
 */
const lifecycle = ["Start", "Pause", "Resume", "Interrupt", "Finish", "Abandon"] as const;

export default function FocusPage() {
  return (
    <>
      <PageHeader
        title="Focus"
        purpose="Work on one thing."
        actions={
          <Badge variant="secondary" className="font-normal">
            No session running
          </Badge>
        }
      />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section title="Current session">
          <div className="border-border flex flex-col gap-4 rounded-xl border px-4 py-5">
            <p className="text-3xl font-medium tabular-nums">00:00</p>
            <p className="text-muted-foreground max-w-prose text-sm">
              The timer is authoritative in the database, so it survives a refresh, a navigation, and a
              second tab. Starting one is wired with the focus commands.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled>Start focus</Button>
              <Button variant="outline" disabled>
                Pick a task
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              Lifecycle: {lifecycle.join(" → ")}. Every pause and interruption is recorded, not discarded.
            </p>
          </div>
        </Section>

        <Section title="Today's sessions" description="Time, task, and how each session ended.">
          <EmptyState
            title="No sessions yet"
            description="Finished sessions appear here with their duration and the task they were tied to."
          />
        </Section>

        <Section title="Completion" description="Reflection enriches finished work; it never blocks it.">
          <EmptyState
            title="Nothing to reflect on"
            description="When a session ends, you get a lightweight prompt for outcome, learning, and follow-up — skippable."
          />
        </Section>
      </div>
    </>
  );
}
