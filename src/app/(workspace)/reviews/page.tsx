import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Readout } from "@/components/readout";
import { Badge } from "@/components/ui/badge";

export const metadata = { title: "Reviews · Axiom" };

/*
 * The unified approval queue. The risk table from the product spec is rendered
 * rather than summarised, because the defaults are the thing the owner is
 * trusting — a vague "we ask when it matters" is how a queue stops being read.
 */
const risk = [
  { level: "Read", examples: "Search mail, read an issue, fetch a page", rule: "Runs" },
  { level: "Prepare", examples: "Draft an email, compose an issue, build an artifact", rule: "Runs locally" },
  { level: "External write", examples: "Send email, create an event, update an issue", rule: "Your approval" },
  { level: "Sensitive write", examples: "Delete, submit, post publicly, merge, deploy", rule: "Approval + confirm" },
  { level: "Prohibited", examples: "Export credentials, bypass policy", rule: "Never" },
];

export default function ReviewsPage() {
  return (
    <>
      <PageHeader
        title="Reviews"
        purpose="Decide what happens next."
        actions={
          <Badge variant="secondary" className="font-normal">
            <Readout>0 waiting</Readout>
          </Badge>
        }
      />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section title="Waiting on you" description="Oldest first. Nothing expires silently without saying so.">
          <EmptyState
            title="No decisions pending"
            description="Proposals from Alfred, drafts waiting to be sent, and anything with an unknown outcome queue here."
          />
        </Section>

        <Section title="What needs a decision" description="Deterministic policy sets the bar; the model never lowers it.">
          <div className="panel overflow-hidden rounded-lg">
            <table className="w-full text-[13px]">
              <caption className="sr-only">Risk classes and what each one requires</caption>
              <thead className="bg-muted/50 text-muted-foreground text-xs">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Risk
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Examples
                  </th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Default
                  </th>
                </tr>
              </thead>
              <tbody>
                {risk.map((row) => (
                  <tr key={row.level} className="border-border border-t">
                    <th scope="row" className="px-3 py-2 text-left font-medium">
                      {row.level}
                    </th>
                    <td className="text-muted-foreground px-3 py-2">{row.examples}</td>
                    <td className="px-3 py-2">{row.rule}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        <Section title="Recently decided" description="An approval binds to one exact revision; an edit needs a new one.">
          <EmptyState
            title="Nothing decided yet"
            description="Approved, rejected, and expiring proposals stay readable here with who decided and when."
          />
        </Section>
      </div>
    </>
  );
}
