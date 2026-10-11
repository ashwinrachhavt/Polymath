import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Readout } from "@/components/readout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Inbox · Axiom" };

/*
 * Capture and clarify. The composer is a placeholder until the capture command
 * lands; the rules below are the real classification order, and each states
 * what it will do rather than pretending to have done it.
 */
export default function InboxPage() {
  return (
    <>
      <PageHeader
        title="Inbox"
        purpose="Clarify what arrived."
        actions={
          <Badge variant="secondary" className="font-normal">
            <Readout>0 unprocessed</Readout>
          </Badge>
        }
      />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section
          title="Capture"
          description="Text, a URL, a file, or a forwarded message. The original is kept."
        >
          <form className="flex flex-col gap-2" aria-describedby="capture-hint">
            <label htmlFor="capture" className="sr-only">
              Capture something
            </label>
            <textarea
              id="capture"
              rows={3}
              disabled
              placeholder="Capture lands here — the command is not wired yet."
              className="border-input bg-background focus-visible:ring-ring w-full resize-y rounded-md border px-3 py-2 text-[13px] outline-none focus-visible:ring-3 disabled:opacity-60"
            />
            <p id="capture-hint" className="text-muted-foreground text-xs">
              Saving is disabled until the capture command exists. Nothing typed here is stored.
            </p>
            <Button type="button" disabled className="w-fit">
              Capture
            </Button>
          </form>
        </Section>

        <Section title="Waiting to be clarified" description="Newest first. Nothing is deleted by classifying it.">
          <EmptyState
            title="The inbox is empty"
            description="Everything that arrives — pasted, forwarded, or synced — waits here until you turn it into a task, note, project, or contact."
          />
        </Section>

        <Section title="How captures are classified" description="Rules first, then Alfred. You decide the last step.">
          <ul className="text-muted-foreground flex flex-col gap-2 text-[13px]">
            <li>
              <span className="text-foreground font-medium">Obvious items classify immediately.</span>{" "}
              Files, URLs, events, and messages matching a known pattern propose a record on arrival.
            </li>
            <li>
              <span className="text-foreground font-medium">Everything else waits for Alfred.</span>{" "}
              Enrichment runs in the background and never blocks the capture itself.
            </li>
            <li>
              <span className="text-foreground font-medium">A proposal is never applied silently.</span>{" "}
              It stays pending until you accept, edit, or reject it, and the original is preserved either
              way.
            </li>
          </ul>
        </Section>
      </div>
    </>
  );
}
