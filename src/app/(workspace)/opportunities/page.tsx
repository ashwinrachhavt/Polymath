import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Opportunities · Axiom" };

/*
 * One generic opportunity with optional specialization. The stage list is the
 * contract, and the prepared/submitted/accepted distinction is spelled out
 * because conflating them is the failure this screen exists to prevent.
 */
const stages = [
  "Identified",
  "Researching",
  "Preparing",
  "Submitted",
  "Interviewing",
  "Negotiating",
  "Won",
  "Lost",
  "Withdrawn",
];

export default function OpportunitiesPage() {
  return (
    <>
      <PageHeader
        title="Opportunities"
        purpose="Track what you are pursuing."
        actions={
          <>
            <Button variant="outline" disabled>
              Capture a source
            </Button>
            <Button disabled>New opportunity</Button>
          </>
        }
      />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section title="Active" description="What is moving, and what the next commitment is.">
          <EmptyState
            title="Nothing in progress"
            description="A role, a lead, or a partnership starts here — from a capture, a job board, or a referral."
          />
        </Section>

        <Section title="Stages">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {stages.map((stage, index) => (
              <span key={stage} className="flex items-center gap-1.5">
                <Badge variant="outline" className="font-normal">
                  {stage}
                </Badge>
                {index < stages.length - 1 ? (
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                ) : null}
              </span>
            ))}
          </div>
          <p className="text-muted-foreground text-[13px]">
            Prepared is not submitted, and submitted is not accepted. Each step is recorded when it
            actually happens, and nothing is submitted without your approval.
          </p>
        </Section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Materials" description="Versioned, so you know exactly what you sent.">
            <EmptyState
              title="No materials yet"
              description="Resumes, cover letters, and answers attach to an opportunity and keep their history."
            />
          </Section>

          <Section title="Deadlines" description="What closes soon, and what has already passed.">
            <EmptyState title="No deadlines" description="Dates that matter are listed here, not buried in a description." />
          </Section>
        </div>
      </div>
    </>
  );
}
