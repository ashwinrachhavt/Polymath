import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Activity · Axiom" };

/*
 * The audit stream. Append-only, and written in the same transaction as the
 * change it describes — so "a change with no row did not happen" is literally
 * true rather than a slogan on a page.
 */
export default function ActivityPage() {
  return (
    <>
      <PageHeader
        title="Activity"
        purpose="See what changed and why."
        actions={
          <Badge variant="secondary" className="font-normal">
            0 events
          </Badge>
        }
      />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section title="Recent" description="Newest first. Actor, action, subject, and the summary in words.">
          <EmptyState
            title="Nothing has happened yet"
            description="Every meaningful change — accepted outcomes, approved proposals, sends, imports — is recorded here with who did it."
          />
        </Section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="External actions" description="The provider's answer, redacted to a summary.">
            <EmptyState
              title="No external actions"
              description="Attempts, provider responses, and anything whose outcome is still unknown appear here."
            />
          </Section>

          <Section title="Deliveries and imports" description="Webhooks that arrived, and what they started.">
            <EmptyState
              title="No deliveries"
              description="Signature-verified deliveries are deduplicated before they are allowed to start work."
            />
          </Section>
        </div>

        <Section title="Anything unresolved" description="An unknown outcome is reconciled before anything retries.">
          <EmptyState
            title="Nothing unresolved"
            description="Actions whose result the provider never confirmed are listed here until they are resolved."
          />
        </Section>
      </div>
    </>
  );
}
