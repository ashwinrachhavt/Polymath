import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Relationships · Axiom" };

export default function RelationshipsPage() {
  return (
    <>
      <PageHeader
        title="Relationships"
        purpose="Keep track of people and companies."
        actions={
          <Button variant="outline" disabled>
            Import contacts
          </Button>
        }
      />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section title="People" description="Every claim about a person carries where it came from.">
          <EmptyState
            title="No contacts yet"
            description="Contacts arrive from mail, from an import, or by hand. Name matching never counts as a verified identity."
          />
        </Section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Companies" description="Matched on domain first, name second.">
            <EmptyState title="No companies yet" description="Organizations group the people you know there." />
          </Section>

          <Section title="Waiting on a reply" description="Follow-ups are cancelled explicitly, never quietly.">
            <EmptyState
              title="Nothing outstanding"
              description="Open follow-ups appear here with how long they have been waiting."
              action={<Badge variant="outline">0 open</Badge>}
            />
          </Section>
        </div>

        <Section title="Correspondence" description="Drafted, sent, and received — with the proposal that authorized it.">
          <EmptyState
            title="No correspondence yet"
            description="Drafts sit here until you approve them. Sending is an external write, so it always asks."
          />
        </Section>
      </div>
    </>
  );
}
