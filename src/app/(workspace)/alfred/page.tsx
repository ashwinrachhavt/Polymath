import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Alfred · Axiom" };

/*
 * Conversation, delegation, and the run timeline. The run states are listed
 * because they are the contract the owner relies on: a run that is waiting for
 * input is visibly waiting, not silently stuck.
 */
const runStates = [
  "Queued",
  "Running",
  "Waiting for input",
  "Waiting for approval",
  "Succeeded",
  "Failed",
  "Cancelled",
];

export default function AlfredPage() {
  return (
    <>
      <PageHeader
        title="Alfred"
        purpose="Delegate and inspect what it did."
        actions={
          <Badge variant="secondary" className="font-normal">
            No profile yet
          </Badge>
        }
      />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section title="Ask Alfred" description="One agent, with a stated model, tools, and budget before it starts.">
          <div className="flex flex-col gap-3">
            <label htmlFor="objective" className="sr-only">
              What should Alfred do?
            </label>
            <textarea
              id="objective"
              rows={3}
              disabled
              placeholder="Describe an objective. Alfred proposes; you approve anything that leaves Axiom."
              className="border-input bg-background focus-visible:ring-ring w-full resize-y rounded-md border px-3 py-2 text-[13px] outline-none focus-visible:ring-3 disabled:opacity-60"
            />
            <Button disabled className="w-fit">
              Start a run
            </Button>
            <p className="text-muted-foreground text-xs">
              Disabled until the run engine lands. Nothing typed here is sent anywhere.
            </p>
          </div>
        </Section>

        <Section title="Threads" description="A thread keeps its record context, so it does not start from nothing.">
          <EmptyState
            title="No threads yet"
            description="Threads open from a task, project, person, or from a question typed above."
          />
        </Section>

        <Section title="Recent runs" description="Every run shows its steps, questions, artifacts, and spend.">
          <EmptyState
            title="No runs yet"
            description="A run is durable: reloading rebuilds its timeline, retries create a new run, and finished runs never change."
          />
          <p className="text-muted-foreground text-xs">
            States: {runStates.join(" → ")}.
          </p>
        </Section>
      </div>
    </>
  );
}
