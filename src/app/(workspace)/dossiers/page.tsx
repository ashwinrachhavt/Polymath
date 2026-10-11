import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export const metadata = { title: "Dossiers · Axiom" };

/*
 * A dossier is a research question with a boundary: exactly which source
 * versions are admitted. The boundary is the feature — without it, synthesis
 * quietly cites whatever the model happened to read.
 */
export default function DossiersPage() {
  return (
    <>
      <PageHeader
        title="Dossiers"
        purpose="Research with a bounded set of sources."
        actions={<Button disabled>New dossier</Button>}
      />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section title="Open dossiers" description="Each one states its question and its source boundary.">
          <EmptyState
            title="No dossiers yet"
            description="A dossier collects a question, the exact sources allowed to answer it, and what you concluded."
          />
        </Section>

        <Section title="What a dossier holds">
          <ul className="text-muted-foreground flex flex-col gap-2 text-[13px]">
            <li>
              <span className="text-foreground font-medium">A question.</span> Stated before the reading,
              so the boundary follows the question rather than the other way round.
            </li>
            <li>
              <span className="text-foreground font-medium">A pinned set of source versions.</span> A page
              that changes later does not silently change what the dossier said.
            </li>
            <li>
              <span className="text-foreground font-medium">Open questions and claims.</span> Each claim
              points at the passage it came from.
            </li>
            <li>
              <span className="text-foreground font-medium">Generated output, marked as generated.</span>{" "}
              Producing a report is not publishing one.
            </li>
          </ul>
        </Section>

        <Section
          title="Bounded, or open"
          description="A bounded dossier answers only from the source versions admitted to it. An open dossier may reach further, and says when it does."
        >
          <div className="flex gap-2">
            <Badge variant="outline" className="font-normal">
              Bounded
            </Badge>
            <Badge variant="outline" className="font-normal">
              Open
            </Badge>
          </div>
        </Section>
      </div>
    </>
  );
}
