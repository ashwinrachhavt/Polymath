import { io } from "next/cache";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Empty, Panel, Screen, Status } from "@/components/workspace/ui";
import { getCompanyDetail } from "@/domains/crm/queries";
import { latestProfileResearch } from "@/domains/knowledge/profile-research";
import { getAuthContext } from "@/lib/auth";
import { ProfileResearchCards } from "../../profile-research-cards";
import { CompanyResearchControls } from "../../profile-research-controls";

export const metadata = { title: "Company · Polymath" };

/*
 * The company profile (ASH-291): the CRM record, its linked contacts, and
 * the embedded research workflow - one bounded pass crawls the record's
 * homepage and about page and searches recent news, then proposes a grounded
 * card set that persists on the profile. The case-study engine (ASH-114)
 * stays where it was: the companies panel on the Contacts screen.
 */

export default async function CompanyProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await io();
  const auth = await getAuthContext();
  const valid = /^[0-9a-fA-F-]{36}$/.test(id);
  const detail = valid ? await getCompanyDetail(auth, { companyId: id }) : null;
  const cardSet = detail ? await latestProfileResearch(auth, { subjectType: "company", subjectId: detail.company.id }) : null;

  if (!detail) {
    return (
      <Screen title="Company">
        <Empty
          title="Company not found"
          description="This link does not match a company in this workspace."
          action={
            <Button asChild variant="outline">
              <Link href="/command-center/relationships/contacts">Open contacts</Link>
            </Button>
          }
        />
      </Screen>
    );
  }

  const { company, contacts: linked } = detail;
  return (
    <Screen
      title={company.name}
      actions={
        <Link href="/command-center/relationships/contacts" className="text-[13px] font-medium underline-offset-4 hover:underline">
          Open contacts
        </Link>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-6">
          <Panel title="Research" description="A bounded web pass: homepage, about page and recent news become a grounded card set.">
            <div className="space-y-4">
              <CompanyResearchControls companyId={company.id} researched={cardSet !== null} />
              {cardSet ? (
                <ProfileResearchCards cardSet={cardSet} />
              ) : (
                <p className="text-[13px] text-muted-foreground">Not researched yet. The first pass reads the company&apos;s own site and recent news.</p>
              )}
            </div>
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Record">
            <dl className="grid gap-2 text-[13px]">
              <div>
                <dt className="text-muted-foreground">Domain</dt>
                <dd className="readout">{company.domain ?? "Not recorded"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Description</dt>
                <dd>{company.description ?? "Not recorded"}</dd>
              </div>
            </dl>
          </Panel>

          <Panel title={`${linked.length} ${linked.length === 1 ? "contact" : "contacts"}`}>
            {linked.length ? (
              <div className="divide-y divide-border">
                {linked.map((person) => (
                  <div key={person.linkId} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <Link
                        href={`/command-center/relationships/contacts?id=${person.contactId}`}
                        className="block max-w-[16rem] truncate text-[13px] font-medium underline-offset-4 hover:underline"
                      >
                        {person.fullName}
                      </Link>
                      {person.title ? <p className="truncate text-xs text-muted-foreground">{person.title}</p> : null}
                    </div>
                    {person.isCurrent ? <Status>current</Status> : null}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">No contacts linked to this company yet.</p>
            )}
          </Panel>
        </div>
      </div>
    </Screen>
  );
}
