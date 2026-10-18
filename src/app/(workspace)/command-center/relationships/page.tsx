import { EmptyState } from "@/components/empty-state";
import { PageHeader, Section } from "@/components/page-header";
import { Readout } from "@/components/readout";
import { Badge } from "@/components/ui/badge";
import {
  listOrganizations,
  listPeople,
} from "@/domains/identity/party-csv";
import { getAuthContext } from "@/lib/auth";
import { ImportButton } from "./import-button";

export const metadata = { title: "Relationships · Axiom" };

/*
 * People and organizations, read from the canonical party tables. A document
 * party resolved to a contact still lands in the CRM tables; this screen reads
 * `people`/`organizations`, which is what the import and the manual link
 * write. Unifying those two universes is a separate decision (see TODOS).
 */
export default async function RelationshipsPage() {
  const auth = await getAuthContext();
  const [people, organizations] = await Promise.all([
    listPeople(auth),
    listOrganizations(auth),
  ]);

  return (
    <>
      <PageHeader
        title="Relationships"
        purpose="Keep track of people and companies."
        actions={<ImportButton />}
      />

      <div className="flex flex-col gap-6 px-4 py-5 md:px-6">
        <Section
          title="People"
          description="Every claim about a person carries where it came from."
        >
          {people.length === 0 ? (
            <EmptyState
              title="No people yet"
              description="Import your LinkedIn connections, or add a person from a document review. An email is the only thing that merges two rows."
            />
          ) : (
            <ul className="flex flex-col">
              {people.map((person) => (
                <li
                  key={person.id}
                  className="border-border flex flex-wrap items-center gap-3 border-b py-2 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {person.displayName}
                  </span>
                  {person.organizations.length ? (
                    <span className="text-muted-foreground shrink-0 text-[12px]">
                      {person.organizations.map((org) => org.name).join(", ")}
                    </span>
                  ) : (
                    <span className="text-muted-foreground shrink-0 text-[12px]">
                      No organization
                    </span>
                  )}
                  {person.email ? (
                    <span className="text-muted-foreground shrink-0 text-[12px]">
                      {person.email}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {people.length ? (
            <p className="text-muted-foreground mt-3 text-[13px]">
              <Readout>{people.length}</Readout> people
            </p>
          ) : null}
        </Section>

        <Section title="Organizations" description="Matched on domain first, name second.">
          {organizations.length === 0 ? (
            <EmptyState
              title="No organizations yet"
              description="Organizations arrive from the connections import or from a document party."
            />
          ) : (
            <ul className="flex flex-col">
              {organizations.map((org) => (
                <li
                  key={org.id}
                  className="border-border flex items-center gap-3 border-b py-2 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                    {org.name}
                  </span>
                  {org.domain ? (
                    <span className="text-muted-foreground shrink-0 text-[12px]">
                      {org.domain}
                    </span>
                  ) : null}
                  <Badge variant="outline" className="shrink-0">
                    <Readout>{org.peopleCount}</Readout> people
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title="Waiting on a reply" description="Follow-ups are cancelled explicitly, never quietly.">
            <EmptyState
              title="Nothing outstanding"
              description="Open follow-ups appear here with how long they have been waiting."
            />
          </Section>

          <Section title="Correspondence" description="Drafted, sent, and received — with the proposal that authorized it.">
            <EmptyState
              title="No correspondence yet"
              description="Drafts sit here until you approve them. Sending is an external write, so it always asks."
            />
          </Section>
        </div>
      </div>
    </>
  );
}
